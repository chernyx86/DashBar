"""Local OCR and conservative draft extraction for invoices."""
import base64
import csv
import io
import os
import re
import shutil
import subprocess
from itertools import product
from math import cos, radians, sin
from datetime import date as calendar_date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from contextlib import ExitStack
from tempfile import TemporaryDirectory
from time import monotonic

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

IMAGE_FORMATS = {".jpg", ".jpeg", ".png", ".webp"}
SCAN_FORMATS = IMAGE_FORMATS | {".pdf"}
MAX_PAGES = 4
MAX_PIXELS = 30_000_000
MAX_ROWS = 100
BUNDLED_TESSDATA = Path(__file__).with_name("ocr-models")
OCR_LANGUAGES = ("rus", "eng")
OCR_TOTAL_LABEL = str.maketrans("bceorp", "всеогр")
MONTHS = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()


class RecognitionError(Exception):
    pass


def command(arguments, timeout=20):
    try:
        return subprocess.run(arguments, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, env={**os.environ, "OMP_THREAD_LIMIT": "2"}).stdout
    except subprocess.TimeoutExpired as error:
        raise RecognitionError("Распознавание заняло слишком много времени. Попробуйте более чёткий скан.") from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise RecognitionError("Не удалось распознать файл. Проверьте формат и установку русской модели Tesseract.") from error


def read_image(path):
    try:
        with Image.open(path) as image:
            if image.width * image.height > MAX_PIXELS:
                raise RecognitionError("Изображение слишком большое. Уменьшите размер и повторите.")
            return ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise RecognitionError("Изображение не удалось открыть.") from error


def source_pages(folder, name, data):
    suffix = Path(name).suffix.lower()
    if suffix not in SCAN_FORMATS:
        raise RecognitionError("Для распознавания нужен PDF, JPG, PNG или WEBP.")
    path = folder / ("source" + suffix)
    path.write_bytes(data)
    if suffix != ".pdf":
        return [path]
    info = command(["pdfinfo", str(path)], timeout=8).decode("utf-8", "replace")
    match = re.search(r"^Pages:\s*(\d+)", info, re.M)
    if not match or not 1 <= int(match[1]) <= MAX_PAGES:
        raise RecognitionError(f"Распознавание принимает скан на 1–{MAX_PAGES} страниц. Разделите PDF по документам.")
    # Small phone scans often have a lot of blank margin around dense invoice
    # tables. Keep enough source pixels for header and item recognition.
    command(["pdftoppm", "-scale-to", "3200", "-jpeg", "-jpegopt", "quality=95",
             str(path), str(folder / "page")], timeout=35)
    pages = sorted(folder.glob("page-*.jpg"))
    if len(pages) != int(match[1]):
        raise RecognitionError("Не удалось прочитать все страницы PDF.")
    return pages


def tesseract_options():
    options = []
    if not os.environ.get("TESSDATA_PREFIX") and BUNDLED_TESSDATA.is_dir():
        options = ["--tessdata-dir", str(BUNDLED_TESSDATA)]
    try:
        listing = command(["tesseract", "--list-langs", *options], timeout=8)
    except RecognitionError as error:
        raise RecognitionError("Не удалось проверить языки Tesseract. Проверьте установку и TESSDATA_PREFIX.") from error
    installed = set(listing.decode("utf-8", "replace").splitlines())
    missing = [lang for lang in OCR_LANGUAGES if lang not in installed]
    if missing:
        raise RecognitionError("В Tesseract отсутствуют языковые модели: "+", ".join(missing)+".")
    return options


def words_from_image(image, scratch, timeout, options):
    mono = ImageOps.autocontrast(ImageOps.grayscale(image))
    mono.save(scratch)
    raw = command(["tesseract", str(scratch), "stdout", *options, "-l", "+".join(OCR_LANGUAGES), "--psm", "11",
                   "-c", "tessedit_create_tsv=1"], timeout=timeout)
    words = []
    for row in csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE):
        word = (row.get("text") or "").strip()
        if not word or row["level"] != "5":
            continue
        x, y = int(row["left"]), int(row["top"])
        w, h = int(row["width"]), int(row["height"])
        words.append((x + w / 2, y + h / 2, h, word))
    return words


def bucket_lines(words):
    lines = []
    for x, y, h, word in sorted(words, key=lambda w: (w[1], w[0])):
        if not lines or abs(y - lines[-1][0]) > max(4, h * .55):
            lines.append((y, []))
        lines[-1][1].append((x, word))
    return lines


def page_text(words):
    return "\n".join(" ".join(word for _, word in sorted(line)) for _, line in bucket_lines(words))


def scan_page(image, scratch, deadline, options, preferred_angle=None):
    original = image
    image = image.copy()
    image.thumbnail((3200, 3200), Image.Resampling.LANCZOS)
    rotations = (0, 90, 270, 180) if preferred_angle is None else (preferred_angle, *(x for x in (0, 90, 270, 180) if x != preferred_angle))
    best = (-1, image, [], "", 0)
    for angle in rotations:
        candidate = image.rotate(angle, expand=True) if angle else image
        remaining = deadline - monotonic()
        if remaining < 1:
            raise RecognitionError("Распознавание не успело завершиться. Попробуйте загрузить документ по частям.")
        words = words_from_image(candidate, scratch, min(22, remaining), options)
        combined = page_text(words)
        normalized = combined.lower().replace("ё", "е")
        evidence = sum(bool(re.search(key, normalized)) for key in
                       ("продавец", "покупатель", "наименование", "налог", "цена", "счет.?фактура", "накладная"))
        russian_words = len(re.findall(r"[а-яА-Я]{3,}", combined))
        score = evidence * 3000 + russian_words
        if score > best[0]:
            best = (score, candidate, words, combined, angle)
        if evidence >= 5 or (angle == preferred_angle and russian_words >= 20):
            break
    candidate, words, combined, angle = best[1:]
    # Preserve the original raster for small table cells. Scale OCR coordinates
    # instead of discarding the scan resolution after orientation detection.
    full = original.rotate(angle, expand=True) if angle else original
    sx, sy = full.width / candidate.width, full.height / candidate.height
    return full, [(x*sx, y*sy, h*sy, word) for x,y,h,word in words], combined, angle


def number(text):
    cleaned = re.sub(r"\s+", "", text.strip(" []()|«»'")).replace(",", ".")
    return cleaned if re.fullmatch(r"\d+(?:\.\d{1,3})?", cleaned) else ""


def by_coordinates(words, y, half_height, low, high):
    region = [(x, word) for x, yy, _, word in words if abs(yy-y) <= half_height and low <= x < high]
    return " ".join(word for _, word in sorted(region))


def number_in_column(words, y, half_height, low, high):
    candidates = [(x, yy, token.strip(" |[]()«»'."))
                  for x, yy, _, token in words if abs(yy-y)<=half_height and low<=x<high]
    numeric = [(x, yy, token) for x, yy, token in candidates if number(token)]
    if not numeric:
        return ""
    nearest = min(numeric,key=lambda v:abs(v[1]-y))
    nearby = sorted((x, value) for x, yy, value in numeric if abs(yy-nearest[1])<=half_height*.55)
    return number(" ".join(value for _,value in nearby))


def extract_rows(image, words):
    """Suggest line items for the standard UPD table when its columns are identifiable."""
    width = image.width
    names = [(x, y) for x, y, _, w in words if re.search(r"наименование", w, re.I)]
    prices = [(x, y) for x, y, _, w in words if re.sub(r"\W", "", w).lower() == "цена"]
    pairs = [(x, y, xp) for x, y in names for xp, yp in prices
             if abs(y-yp) < width*.035 and width*.16 < xp-x < width*.42 and y < image.height*.65]
    if not pairs:
        return [], ""
    first, header, price_anchor = min(pairs, key=lambda row: row[1])
    scale = (price_anchor-first) / (.38-.14)
    locate = lambda fraction: first + (fraction-.14)*scale
    # UPD columns: description, unit, quantity, unit price before tax, tax, gross amount.
    total_markers = [y for x,y,_,w in words if x < locate(.25) and y > header+width*.07
                     and re.sub(r"\W","",w).lower().translate(OCR_TOTAL_LABEL) in {"всего", "итого"}]
    end = min(total_markers, default=image.height*.82)
    unit_hits = sorted((y, re.sub(r"[^а-я.]", "", w.lower())) for x,y,_,w in words
                       if header+width*.042 < y < end and locate(.265) <= x <= locate(.323)
                       and re.sub(r"[^а-я]", "",w.lower()) in {"шт","кг","уп","бут","л","г","мл"})
    rows = []
    for i, (y, unit) in enumerate(unit_hits[:MAX_ROWS]):
        tolerance = width*.010
        qty = number_in_column(words, y, tolerance, locate(.325), locate(.379))
        price = number_in_column(words, y, tolerance, locate(.384), locate(.446))
        net_sum = number_in_column(words,y,tolerance,locate(.448),locate(.512))
        vat = number_in_column(words, y, tolerance, locate(.570), locate(.636))
        gross = number_in_column(words, y, tolerance, locate(.632), locate(.725))
        upper = y-tolerance
        lower = unit_hits[i+1][0]-tolerance if i+1 < len(unit_hits) else end
        description = [entry for entry in words if upper<=entry[1]<lower and locate(.109)<=entry[0]<locate(.25)]
        pos = " ".join(page_text(description).replace("|","").replace("[","").replace("="," ").split())
        pos = re.sub(r"^\d{1,3}\s*(?=[А-ЯA-Z])","",pos)
        if not pos or not (qty or price or gross):
            continue
        valid = rounding = False
        try:
            estimated = (Decimal(qty)*Decimal(price)).quantize(Decimal(".01"),rounding=ROUND_HALF_UP)
            rounding = estimated != Decimal(net_sum)
            tolerance = max(Decimal(".01"),Decimal(qty)*Decimal(".005")+Decimal(".005"))
            valid = (Decimal(net_sum)+Decimal(vat)==Decimal(gross)
                     and abs(estimated-Decimal(net_sum))<=tolerance)
        except InvalidOperation:
            pass
        rows.append({"pos":pos,"unit":unit.rstrip("."),"qty":qty,"netPrice":price,"netSum":net_sum,"vat":vat,"gross":gross,
                     "needsReview":not valid,"rounding":valid and rounding})
    total = number_in_column(words, end, width*.012, locate(.632), locate(.725)) if total_markers else ""
    return rows, total


def column_profile(mask, box, vertical=False):
    part = mask.crop(box)
    size = (part.width, 1) if vertical else (1, part.height)
    return list(part.resize(size, Image.Resampling.BOX).tobytes())


def profile_peaks(values, offset, threshold):
    groups = []
    for i, value in enumerate(values, offset):
        if value < threshold:
            continue
        if not groups or i > groups[-1][-1][0] + 1:
            groups.append([])
        groups[-1].append((i, value))
    return [max(group, key=lambda pair: pair[1])[0] for group in groups]


def ruled_column_edges(mask, top, bottom):
    """Return sustained vertical table rules, excluding isolated OCR glyphs."""
    top=max(0,round(top));bottom=min(mask.height,round(bottom))
    if bottom-top<12:return []
    scores=[]
    step=max(3,min(8,(bottom-top)//12))
    for x in range(15,mask.width-15):
        hits=checks=0
        for y in range(top,bottom,step):
            checks+=1
            if mask.crop((x-1,y,min(mask.width,x+2),min(bottom,y+step))).getbbox():hits+=1
        if checks and hits/checks>=.72:scores.append(x)
    groups=[]
    for x in scores:
        if not groups or x>groups[-1][-1]+2:groups.append([])
        groups[-1].append(x)
    # A printed rule is narrow; broad connected regions tend to be text.
    return [round((group[0]+group[-1])/2) for group in groups if len(group)<=9]


def expanded_grid(image, words):
    """Recognize the expanded UPD layout only when both headers and grid agree."""
    w, h = image.size
    names = [(x, y) for x,y,_,t in words if 'наименование' in t.casefold()]
    prices = [(x,y) for x,y,_,t in words if re.fullmatch(
        r'(?:цен[аыи]|тариф|стоимость)', re.sub(r'\W','',t.casefold()))]
    quantities = [(x,y) for x,y,_,t in words if t.casefold() == 'количество' or
                  (re.sub(r'\W','',t.casefold())=='коли' and any(abs(x-xx)<w*.025 and 0<yy-y<w*.06 and 'чество' in tt.casefold()
                    for xx,yy,_,tt in words))]
    totals = [(x,y) for x,y,_,t in words if re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL) in {'всего','итого'}]
    anchors = [(nx,ny,px,py,qx) for nx,ny in names for px,py in prices for qx,qy in quantities
               if .18*w < px-nx < .46*w and .015*w < px-qx < .15*w
               and abs(ny-py)<.04*w and abs(qy-py)<.04*w and ny<h*.62]
    if not anchors:
        return None
    nx, ny, px, py, _ = min(anchors, key=lambda a:a[1])
    wide=px/w>=.48
    matches = [(x,y) for x,y in totals if x<px and y>ny+.08*w]
    if not matches:
        return None
    tx, ty = min(matches,key=lambda a:a[1])
    scale = w/900
    gray = ImageOps.grayscale(image)
    small = gray.resize((900,round(h/scale)),Image.Resampling.LANCZOS)
    base = small.point(lambda p:255 if p<190 else 0)
    top, bottom = max(0,round(ny/scale)-25), min(small.height,round(ty/scale)+20)
    left, right = 45, 855
    best = None
    for angle in (0,-.25,.25,-.5,.5,-.75,.75,-1,1,-1.25,1.25,-1.5,1.5,-2,2):
        mask = base.rotate(angle,fillcolor=0)
        profile = column_profile(mask,(left,top,right,bottom))
        score = sum(v*v for v in profile if v>=70)
        if best is None or score>best[0]:
            best = (score,angle,mask,profile)
    _, angle, mask, profile = best
    lines = profile_peaks(profile,top,70)
    def transform(x,y):
        dx,dy=x/scale-450,y/scale-small.height/2
        a=radians(angle)
        return 450+cos(a)*dx+sin(a)*dy, small.height/2-sin(a)*dx+cos(a)*dy
    hx,hy=transform(nx,ny); price_x,_=transform(px,py); _,total_y=transform(tx,ty)
    before=[v for v in lines if v<total_y-1]
    after=[v for v in lines if v>total_y+1]
    if not before or not after or after[0]-before[-1]>32:
        return None
    end, total_end = before[-1],after[0]
    starts=[b for a,b in zip(lines,lines[1:]) if hy+15<a<hy+(65 if wide else 120) and 5<=b-a<=18 and b<end]
    if not starts:
        return None
    start=starts[-1]
    boundaries=[v for v in lines if start<=v<=end]
    # A narrow numbered header row precedes the item bands; avoid guessing if
    # the remaining horizontal lines are not a plausible table.
    if not 2<=len(boundaries)<=17 or any(not 9<=b-a<=100 for a,b in zip(boundaries,boundaries[1:])):
        return None
    name_ref,price_ref=(183,468) if wide else (139,395)
    factor=(price_x-hx)/(price_ref-name_ref)
    locate=lambda x: round(hx+(x-name_ref)*factor)
    expected=[locate(x) for x in ((135,282,328,363,408,457,510,563,621,671,727) if wide else
                                 (99,222,285,329,369,423,490,564,618,680))]
    if min(expected)<12 or max(expected)>888:
        return None
    vprofile=column_profile(mask,(0,start+3,900,end-3),True)
    columns=[]
    for x in expected:
        lo,hi=max(0,x-9),min(900,x+10)
        found=max(range(lo,hi),key=lambda i:vprofile[i])
        if vprofile[found]<70:
            return None
        columns.append(found)
    if any(b-a<10 for a,b in zip(columns,columns[1:])):
        return None
    indices=((0,1),(2,3),(3,4),(5,6),(6,7),(8,9),(9,10)) if wide else ((0,1),(2,3),(3,4),(4,5),(5,6),(7,8),(8,9))
    cells=[(columns[a],columns[b]) for a,b in indices]
    return gray.rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC),mask,scale,boundaries,total_end,cells,angle


def split_quantity_grid(image, words):
    """Find a landscape UPD with separate package size, packages and pieces.

    Anchor the ruled table at its printed total rather than at a fragile OCR
    reading of the tiny column headings. Require the characteristic sequence
    of quantity, price, net, excise, tax rate, tax and gross columns.
    """
    w,h=image.size
    if w<=h:return None
    text=page_text(words).casefold()
    if not ('продав' in text and ('покупател' in text or 'грузополуч' in text)):
        return None
    scale=w/900
    gray=ImageOps.grayscale(image)
    small=gray.resize((900,round(h/scale)),Image.Resampling.LANCZOS)
    base=small.point(lambda p:255 if p<180 else 0)
    totals=[(x/scale,y/scale) for x,y,_,t in words if x<w*.48 and h*.25<y<h*.85
            and re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL)=='всего']
    for tx,ty in totals:
        top=max(0,round(ty)-140);bottom=min(small.height,round(ty)+20)
        best=None
        for angle in (0,-.25,.25,-.5,.5,-.75,.75,-1,1,-1.5,1.5,-2,2):
            mask=base.rotate(angle,fillcolor=0)
            p=column_profile(mask,(20,top,880,bottom))
            score=sum(v*v for v in p if v>=45)
            if best is None or score>best[0]:best=(score,angle,mask,p)
        _,angle,mask,p=best
        def transform(x,y):
            dx,dy=x-450,y-small.height/2;a=radians(angle)
            return 450+cos(a)*dx+sin(a)*dy,small.height/2-sin(a)*dx+cos(a)*dy
        _,total_y=transform(tx,ty)
        rules=profile_peaks(p,top,45)
        above=[v for v in rules if v<total_y-1];below=[v for v in rules if v>total_y+1]
        if not above or not below or not 5<=below[0]-above[-1]<=25:continue
        end,total_end=above[-1],below[0]
        # The narrow numbered header ends just before the first item band.
        starts=[b for a,b in zip(rules,rules[1:]) if 3<=b-a<=10 and 9<=end-b<=120]
        if not starts:continue
        start=starts[-1]
        lines=[v for v in rules if start<=v<=end]
        if len(lines)<2 or any(not 8<=b-a<=60 for a,b in zip(lines,lines[1:])):continue
        edges=profile_peaks(column_profile(mask,(0,start+2,900,end-2),True),0,90)
        header_profile=column_profile(mask,(0,max(top,start-60),900,start-3),True)
        edges=[x for x in edges if max(header_profile[max(0,x-3):min(900,x+4)],default=0)>=48]
        # A total row contains three monetary fields. The rightmost one
        # must lie inside the gross column of the item grid.
        money=[]
        for x,y,_,token in words:
            xx,yy=transform(x/scale,y/scale)
            if end-2<=yy<=total_end+2 and xx>tx+50 and re.search(r'\d{3,}',token):money.append(xx)
        if not money:continue
        gross_x=max(money)
        matches=[i for i,(a,b) in enumerate(zip(edges,edges[1:])) if a<gross_x<b and 25<=b-a<=100]
        if len(matches)!=1:continue
        i=matches[0]
        if i<10:continue
        widths=[edges[j+1]-edges[j] for j in range(i-9,i+1)]
        if not (all(10<=v<=48 for v in widths[:4]) and 12<=widths[4]<=55
                and 28<=widths[5]<=100 and 8<=widths[6]<=45 and 8<=widths[7]<=45
                and 20<=widths[8]<=90):continue
        names=[(a,b) for a,b in zip(edges[:i-9],edges[1:i-8]) if 50<=b-a<=180]
        if len(names)!=1:continue
        def cell(j):return (edges[j],edges[j+1])
        columns=[names[0],cell(i-9),cell(i-7),cell(i-5),cell(i-4),cell(i-1),cell(i)]
        # Return the split quantity cells too, for checking packaging.
        return gray.rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC),mask,scale,lines,total_end,columns,angle,cell(i-8),cell(i-6)
    return None


def standard_upd_grid(image, words):
    """Locate item rows in the printed Russian UPD (universal transfer form).

    The UPD has a stable page-wide table, but its narrow headers are often
    unreadable in low-quality scans. Use the document label, table rules, and
    the fixed printed form columns together; never use this fallback for a
    generic invoice or a table without visible row rules.
    """
    width, height = image.size
    text = page_text(words).casefold().replace("ё", "е")
    if "передаточ" not in text or not re.search(r"счет.?фактура|продавец", text):
        return None
    name_hits = [(x, y) for x, y, _, token in words if "наимен" in token.casefold()
                 and width * .08 <= x <= width * .42 and height * .14 <= y <= height * .60]
    if not name_hits:
        return None
    # The printed UPD repeats the word "наименование" in its header block.
    # The lowest occurrence is the goods-column heading on sideways scans.
    name_x, name_y = max(name_hits, key=lambda p: p[1])
    scale = width / 900
    small = ImageOps.grayscale(image).resize((900, round(height / scale)), Image.Resampling.LANCZOS)
    mask = small.point(lambda pixel: 255 if pixel < 205 else 0)

    # A landscape UPD has variable row counts and column widths. Detect the
    # ruled item bands first, then anchor the key cells to printed headings.
    if width > height:
        y_lo, y_hi = round(small.height * .40), round(small.height * .76)
        horizontal = column_profile(mask, (20, y_lo, 880, y_hi))
        rules = profile_peaks(horizontal, y_lo, 38)
        chains = []
        for start in range(len(rules)):
            chain = [rules[start]]
            for line in rules[start + 1:]:
                gap = line - chain[-1]
                if gap < 10:
                    # Adjacent strokes are commonly the double bottom of a
                    # header. Keep the later line as the first item boundary.
                    if len(chain) == 1:
                        chain[-1] = line
                    continue
                if gap > 42:
                    break
                chain.append(line)
            if len(chain) >= 3:
                chains.append(chain)
        if not chains:
            # Sideways phone scans sometimes erase the fine horizontal rules,
            # while Tesseract still locates the numeric cells. In that case
            # recover row bands from repeated aligned numeric baselines.
            left_totals=[y/scale for x,y,_,token in words
                         if x/scale<400 and y/scale>name_y/scale+24
                         and re.sub(r"\W","",token.casefold()).translate(OCR_TOTAL_LABEL) in {"всего","итого"}]
            row_limit=min(small.height*.78,min(left_totals)-3) if left_totals else small.height*.78
            numeric=[]
            for x,y,h,token in words:
                xn,yn=x/scale,y/scale
                if (xn<250 or xn>760 or yn<name_y/scale+24 or yn>row_limit
                        or not re.fullmatch(r"\d[\d.,]*[)\]]?",token.strip())):
                    continue
                numeric.append(yn)
            groups=[]
            for y in sorted(numeric):
                if not groups or y-groups[-1][-1]>5:groups.append([])
                groups[-1].append(y)
            centers=[sum(group)/len(group) for group in groups if len(group)>=3]
            if not centers or len(centers)>MAX_ROWS:
                return None
            if len(centers)==1:
                boundaries=[max(name_y/scale+12,centers[0]-10),centers[0]+10]
            else:
                boundaries=[centers[0]-(centers[1]-centers[0])/2]
                boundaries.extend((a+b)/2 for a,b in zip(centers,centers[1:]))
                boundaries.append(centers[-1]+(centers[-1]-centers[-2])/2)
            boundaries=[round(y) for y in boundaries]
        else:
            boundaries = max(chains, key=lambda seq: (len(seq), seq[-1] - seq[0]))
        # Prefer the numeric baselines to horizontal rules when they agree
        # on the repeated item rows. This keeps header/footer rules out of the
        # item sequence on narrow or perspective-skewed phone scans.
        low_row=name_y/scale+24
        row_totals=[y/scale for x,y,_,token in words
                    if x/scale<400 and y/scale>low_row
                    and re.sub(r"\W","",token.casefold()).translate(OCR_TOTAL_LABEL) in {"всего","итого"}]
        row_limit=min(small.height*.78,min(row_totals)-3) if row_totals else min(small.height*.78,boundaries[-1]+12)
        values=[]
        for x,y,h,token in words:
            yn=y/scale;xn=x/scale
            if 250<=xn<=700 and low_row<yn<row_limit and re.fullmatch(r"\d[\d.,]*[)\]]?",token.strip()):
                values.append(yn)
        groups=[]
        for y in sorted(values):
            if not groups or y-groups[-1][-1]>5:groups.append([])
            groups[-1].append(y)
        centers=[sum(group)/len(group) for group in groups if len(group)>=3]
        if 2<=len(centers)<=MAX_ROWS:
            boundaries=[centers[0]-(centers[1]-centers[0])/2]
            boundaries.extend((a+b)/2 for a,b in zip(centers,centers[1:]))
            boundaries.append(centers[-1]+(centers[-1]-centers[-2])/2)
        # Remove any leftover duplicate header strokes.
        clean = [boundaries[0]]
        for line in boundaries[1:]:
            if line - clean[-1] >= 10:
                clean.append(line)
            else:
                clean[-1] = line
        boundaries = clean
        # A few Russian UPD scans include only the first item rows in the OCR
        # baseline sequence. Recover any additional rows from the ruled table
        # itself, even when the partial baseline boundaries look regular.
        # The profile may report both dark edges of a rule (for example 305
        # and 310), so collapse those hits before searching for a row run.
        floor=name_y/scale+50
        eligible=[]
        for line in rules:
            if line<=floor or line>small.height*.78:
                continue
            if eligible and line-eligible[-1]<=10:
                eligible[-1]=round((eligible[-1]+line)/2)
            else:
                eligible.append(line)
        candidates=[]
        for start in range(len(eligible)):
            chain=[eligible[start]]
            for line in eligible[start+1:]:
                gap=line-chain[-1]
                if gap<12:break
                if gap>32:break
                chain.append(line)
            if len(chain)>=4:candidates.append(chain)
        if candidates:
            ruled=max(candidates,key=lambda seq:(len(seq),-max(seq[i+1]-seq[i] for i in range(len(seq)-1))))
            if len(ruled)>len(boundaries):
                boundaries=ruled
        if not 2 <= len(boundaries) <= MAX_ROWS + 1:
            return None

        # Locate numeric columns from the printed UPD header words. The
        # rightmost "всего" belongs to amount including VAT; the nearest
        # "цена" anchors unit price, and the immediately preceding ruled band
        # is quantity. These are page-relative, so vendor-specific widths work.
        price_hits = [(x / scale + len(token) * h / scale * .38, y / scale)
                      for x, y, h, token in words
                      if re.sub(r"\W", "", token.casefold()) in {"цена", "тариф"}
                      and y > height * .28 and y < height * .58]
        total_hits = [(x / scale, y / scale) for x, y, _, token in words
                      if re.sub(r"\W", "", token.casefold()).translate(OCR_TOTAL_LABEL) == "всего"
                      and y > height * .28 and y < height * .62]
        if not total_hits:
            return None
        # `price_hits` are normalized to the 900px page while `name_y` is a
        # coordinate from the original scan. Compare in the same coordinate
        # system; otherwise a noisy header word can anchor the price cell to
        # the wrong vertical rule on landscape scans.
        price_x = min(price_hits, key=lambda p: abs(p[1] - name_y / scale))[0] if price_hits else None
        amount_headers=[(x/scale + len(token)*h/scale*.38,y/scale)
                        for x,y,h,token in words
                        if re.sub(r"\W","",token.casefold()).startswith("стоим")
                        and height*.28<y<height*.62]
        gross_x = (max(x for x,_ in total_hits) if price_hits else
                   max((x for x,_ in amount_headers if x<720),default=max(x for x,_ in total_hits)))
        # Include the table header: some printed templates omit a faint
        # vertical rule inside the item rows but draw it clearly through the
        # multi-line header.
        x_rules = ruled_column_edges(mask, max(0, round(name_y / scale) - 28), boundaries[-1] + 4)
        x_rules = [x for x in x_rules if 30 <= x <= 880]

        def nearest_left(x):
            values = [v for v in x_rules if v < x]
            return max(values) if values else None

        def nearest_right(x):
            values = [v for v in x_rules if v > x]
            return min(values) if values else None

        def cell_at(x, min_width, max_width):
            pairs=[(a,b) for a,b in zip(x_rules,x_rules[1:])
                   if a < x < b and min_width <= b-a <= max_width]
            return min(pairs,key=lambda pair:abs((pair[0]+pair[1])/2-x)) if pairs else None

        if price_x is not None:
            price_pair=cell_at(price_x,24,90)
        else:
            price_pair=None
        # Some standard UPDs split the quantity header into package count and
        # physical piece count and OCR misses the word "цена". In that layout
        # the price column is immediately left of the first net amount column.
        net_labels=[x / scale + len(token) * h / scale * .38
                    for x,y,h,token in words
                    if re.sub(r"\W", "", token.casefold()).startswith("стоим")
                    and y > height*.28 and y < height*.62 and x/scale < gross_x]
        net_pair=cell_at(min(net_labels),35,100) if net_labels else None
        if price_pair is None and net_pair:
            previous=[a for a,b in zip(x_rules,x_rules[1:]) if b==net_pair[0]]
            price_pair=(max(previous),net_pair[0]) if previous else None
        gross_pair=cell_at(gross_x,35,100)
        if gross_pair is None and net_pair:
            # Keep the gross field bounded by the final value column, not by
            # a stray vertical stroke in the country/declaration columns.
            likely=[(a,b) for a,b in zip(x_rules,x_rules[1:])
                    if b>a and 35<=b-a<=100 and a>=net_pair[1]]
            gross_pair=min(likely,key=lambda pair:abs(pair[1]-gross_x)) if likely else None
        price_left,price_right=price_pair if price_pair else (None,None)
        gross_left,gross_right=gross_pair if gross_pair else (None,None)
        name_x_scaled = name_x / scale
        name_pair=cell_at(name_x_scaled,45,180)
        name_left,name_right=name_pair if name_pair else (nearest_left(name_x_scaled),nearest_right(name_x_scaled))
        if not all(v is not None for v in (price_left, price_right, gross_left, gross_right,
                                            name_left, name_right)):
            return None
        qty_choices=[(a,b) for a,b in zip(x_rules,x_rules[1:])
                     if b==price_left and 12<=b-a<=80]
        qty_pair=qty_choices[-1] if qty_choices else None
        qty_left=qty_pair[0] if qty_pair else nearest_left(price_left-1)
        if qty_left is None or price_left - qty_left < 8:
            return None
        # In this UPD family the two columns immediately before price are the
        # unit and physical quantity; preserve the entire unit cell.
        unit_left = name_right
        if not (name_right < qty_left < price_left < gross_left < gross_right):
            return None
        # Tax amount is between net and gross. Its exact cell is not required
        # to calculate the user-facing unit price, but retaining it supports
        # the existing review form.
        net_left = price_right
        net_right = nearest_right(net_left + 1)
        if net_right is None or net_right >= gross_left:
            return None
        vat_left = nearest_left(gross_left - 1)
        if vat_left is None or vat_left < net_right:
            vat_left = net_right
        cells = [(name_left, name_right), (unit_left, qty_left), (qty_left, price_left),
                 (price_left, price_right), (net_left, net_right), (vat_left, gross_left),
                 (gross_left, gross_right)]
        return small, mask, scale, boundaries, boundaries[-1], cells, 0

    y_start = max(0, round(name_y / scale) - 90)
    y_end = min(small.height, round(name_y / scale) + 190)
    horizontal = column_profile(mask, (20, y_start, 880, y_end))
    rules = profile_peaks(horizontal, y_start, 55)
    # UPD item rows are usually 12–36 pixels high at a 900px page width.
    # Find a run of at least four item rows and the narrow document-total row.
    sequences = []
    for start in range(len(rules)):
        chosen = [rules[start]]
        while len(chosen) < 6:
            previous = chosen[-1]
            next_lines = [line for line in rules if line > previous and 11 <= line - previous <= 36]
            if not next_lines:
                break
            chosen.append(next_lines[0])
        if len(chosen) == 6 and 7 <= chosen[-1] - chosen[-2] <= 20:
            if chosen[0] > name_y / scale + 20:
                sequences.append(chosen)
    if not sequences:
        return None
    boundaries = min(sequences, key=lambda seq: abs(seq[0] - name_y / scale - 48))
    if not (4 <= len(boundaries) - 1 <= MAX_ROWS):
        return None

    top, bottom = boundaries[0] - 3, boundaries[-1] + 3
    vertical = column_profile(mask, (20, max(0, round(name_y / scale) - 20), 880,
                                     min(small.height, round(boundaries[-1] + 5))), True)
    x_rules = profile_peaks(vertical, 20, 65)
    # Standard UPD columns, expressed against its detected left/right table
    # edges. The ruled columns are checked before accepting the profile.
    edges = [x for x in x_rules if x < 120 or x > 800]
    if len(edges) < 2:
        return None
    left, right = min(edges), max(edges)
    if right - left < 700:
        return None
    canonical = (102, 280, 311, 332, 365, 412, 455, 507, 587, 642, 703)
    # Keep the canonical positions exact after proving the page edges and
    # nearby rules; a one-pixel drift at this scale can cut a printed digit.
    columns = list(canonical)
    # Require visible vertical rules around the description, quantity, price,
    # net, VAT, and gross amount columns.
    for x in columns[1:]:
        if not any(abs(hit - x) <= 9 for hit in x_rules):
            return None
    cells = [(columns[a], columns[b]) for a, b in
             ((0, 1), (2, 4), (4, 5), (5, 6), (6, 7), (8, 9), (9, 10))]
    total_end = boundaries[-1]
    return ImageOps.grayscale(small), mask, scale, boundaries[:-1], total_end, cells, 0


def transport_grid(image,words):
    """Recognize the distinct commodity table of form 1-Т (no VAT columns)."""
    w,h=image.size
    names=[(x,y) for x,y,_,t in words if 'наименование' in t.casefold()]
    prices=[(x,y) for x,y,_,t in words if re.sub(r'\W','',t.casefold())=='цена']
    amounts=[(x,y) for x,y,_,t in words if re.sub(r'\W','',t.casefold())=='сумма']
    anchors=[(nx,ny,ax,ay) for nx,ny in names for px,py in prices for ax,ay in amounts
             if .035*w<nx-px<.15*w and .30*w<ax-nx<.49*w and abs(ny-py)<.03*w and abs(ny-ay)<.03*w and ny<h*.65]
    if not anchors:return None
    nx,ny,ax,ay=min(anchors,key=lambda a:a[1])
    total_marks=[(x,y) for x,y,_,t in words if x<nx and y>ny+.07*w and re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL)=='итого']
    if not total_marks:return None
    tx,ty=min(total_marks,key=lambda a:a[1]);scale=w/900
    gray=ImageOps.grayscale(image);small=gray.resize((900,round(h/scale)),Image.Resampling.LANCZOS)
    base=small.point(lambda p:255 if p<190 else 0)
    top,bottom=max(0,round(ny/scale)-40),min(small.height,round(ty/scale)+24)
    best=None
    for angle in (0,-.25,.25,-.5,.5,-.75,.75,-1,1,-1.25,1.25,-1.5,1.5,-2,2):
        mask=base.rotate(angle,fillcolor=0);profile=column_profile(mask,(45,top,855,bottom))
        score=sum(v*v for v in profile if v>=95)
        if best is None or score>best[0]:best=(score,angle,mask,profile)
    _,angle,mask,profile=best;lines=profile_peaks(profile,top,100)
    def transform(x,y):
        dx,dy=x/scale-450,y/scale-small.height/2;a=radians(angle)
        return 450+cos(a)*dx+sin(a)*dy,small.height/2-sin(a)*dx+cos(a)*dy
    hx,hy=transform(nx,ny);amount_x,_=transform(ax,ay);_,total_y=transform(tx,ty)
    before=[v for v in lines if v<total_y-1];after=[v for v in lines if v>total_y+1]
    if not before or not after or after[0]-before[-1]>28:return None
    end,total_end=before[-1],after[0]
    starts=[b for a,b in zip(lines,lines[1:]) if hy+12<a<hy+60 and 5<=b-a<=16 and b<end]
    if not starts:return None
    start=starts[0];boundaries=[v for v in lines if start<=v<=end]
    if not 2<=len(boundaries)<=17 or any(not 9<=b-a<=85 for a,b in zip(boundaries,boundaries[1:])):return None
    factor=(amount_x-hx)/(699-344);expected=[round(hx+(x-344)*factor) for x in (217,264,313,527,566,684,747)]
    if min(expected)<12 or max(expected)>888:return None
    profile=column_profile(mask,(0,start+3,900,end-3),True);columns=[]
    for x in expected:
        lo,hi=max(0,x-10),min(900,x+11);found=max(range(lo,hi),key=lambda i:profile[i])
        if profile[found]<90:return None
        columns.append(found)
    if any(b-a<10 for a,b in zip(columns,columns[1:])):return None
    cells=[(columns[a],columns[b]) for a,b in ((2,3),(3,4),(0,1),(1,2),(5,6))]
    return gray.rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC),mask,scale,boundaries,total_end,cells,angle


def grid_cell(image,mask,scale,box,short=False,total=False):
    a,y,b,z=box
    def peak_x(x):
        lo,hi=x-5,x+6
        top=min(z-4,y+max(4,(z-y)//3))
        values=column_profile(mask,(lo,top,hi,z-3),True)
        return lo+max(range(len(values)),key=values.__getitem__) if max(values,default=0)>=80 else x
    if not total:
        a,b=peak_x(a),peak_x(b)
    x1,x2=round((a+1)*scale),round((b-.35)*scale)
    if x2-x1<=8:
        return None
    def horizontal(y):
        lo,hi=round((y-5)*scale),round((y+5)*scale)
        values=column_profile(image.crop((x1+3,lo,x2-3,hi)).point(lambda p:255 if p<195 else 0),
                              (0,0,x2-x1-6,hi-lo))
        return lo+max(range(len(values)),key=values.__getitem__)
    y1,y2=horizontal(y)+2,horizontal(z)-1
    if short and not total:
        y2=min(y2,y1+round(11*scale))
    if x2<=x1 or y2<=y1:
        return None
    cell=ImageOps.autocontrast(image.crop((x1,y1,x2,y2)),cutoff=1)
    # Keep the glyphs; remove only long horizontal/vertical border strokes.
    dark=cell.point(lambda p:255 if p<180 else 0)
    draw=ImageDraw.Draw(cell)
    for yy,value in enumerate(column_profile(dark,(0,0,dark.width,dark.height))):
        if value>180 and (yy<cell.height*.12 or yy>cell.height*.88):
            draw.line((0,yy,cell.width,yy),fill=255)
    for xx,value in enumerate(column_profile(dark,(0,0,dark.width,dark.height),True)):
        if value>180 and (xx<cell.width*.06 or xx>cell.width*.94):
            draw.line((xx,0,xx,cell.height),fill=255)
    return cell


def direct_grid_cell(image, scale, box):
    """Crop a high-resolution, ruled-table cell without resizing its source."""
    a, y, b, z = box
    inset = max(3, round(scale * 1.8))
    x1, x2 = round(a * scale) + inset, round(b * scale) - inset
    y1, y2 = round(y * scale) + inset, round(z * scale) - inset
    if x2 <= x1 or y2 <= y1:
        return None
    return ImageOps.autocontrast(ImageOps.grayscale(image.crop((x1, y1, x2, y2))), cutoff=1)


def grid_text(cell,scratch,deadline,options,mode,lang,binary=False,psm=None):
    if cell is None or deadline-monotonic()<2:
        return ''
    if binary:
        cell=cell.point(lambda p:0 if p<165 else 255)
    box=ImageOps.invert(cell.point(lambda p:0 if p<180 else 255)).getbbox()
    if box:
        cell=cell.crop(box)
    zoom=3 if binary else 2
    cell=cell.resize((cell.width*zoom,cell.height*zoom),Image.Resampling.NEAREST if binary else Image.Resampling.BICUBIC)
    ImageOps.expand(cell,20,'white').save(scratch)
    extra=['-c','tessedit_char_whitelist=0123456789,.'] if mode!='text' and mode!='unit' else []
    try:
        return command(['tesseract',str(scratch),'stdout',*options,'-l',lang,'--psm',str(psm or (6 if mode=='text' else 7)),*extra],
                       timeout=min(5,deadline-monotonic())).decode('utf-8','replace').strip()
    except RecognitionError:
        return ''


def decimal_candidates(texts, money):
    values=set()
    for raw in texts:
        v=number(raw)
        if not v:
            continue
        d=Decimal(v)
        if d>0 and d<=Decimal('1000000000'):
            values.add(d)
            if money and '.' not in v and len(v)>=3:
                values.add(d/100)
        elif d==0:
            values.add(d)
    return sorted(values)


def reconcile_package_quantity(quantities, size_reads, piece_reads):
    """Recover a lost quantity comma only with independent pack/piece evidence."""
    sizes={}
    for raw in size_reads:
        for value in decimal_candidates([raw],False):
            if 1<=value<=1000 and value==value.to_integral_value():sizes[value]=sizes.get(value,0)+1
    if not sizes:return None
    highest=max(sizes.values());best_sizes=[s for s,count in sizes.items() if count==highest]
    if len(best_sizes)!=1:return None
    # A visibly printed decimal separator is stronger evidence than an OCR
    # integer which may have lost the comma (48,000 -> 48000).
    explicit=[raw for raw in piece_reads if re.search(r'\d[,.]\d',raw)]
    pieces=set(decimal_candidates(explicit or piece_reads,False))
    options=set(quantities)
    if explicit:
        options|={q/1000 for q in quantities if q>=1000 and q==q.to_integral_value() and q%1000==0}
    compatible={q for q in options if q>0 and q*best_sizes[0] in pieces}
    return next(iter(compatible)) if len(compatible)==1 else None


GRID_KEYS=('qty','netPrice','netSum','vat','gross')


def grid_row_candidates(candidates,unit,document_total):
    """A proposed combination must have at least three independently read fields.

    Calculated alternatives are never labelled as read values. They are only
    offered after the independently read document total resolves the ambiguity.
    """
    qty,price,net,vat,gross=map(set,candidates)
    def cents_only(values):
        return {v for v in values if v==v.quantize(Decimal('.01'))}
    net,vat,gross=map(cents_only,(net,vat,gross))
    nets=net|{g-v for g,v in product(gross,vat) if g>=v}
    result={}
    for n in nets:
        if not 0<n<=document_total:
            continue
        pairs=set(product(qty,price))
        for q in qty:
            if q>0:
                pairs.add((q,(n/q).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)))
        # Only countable packaging can suggest an integral quantity from
        # an independently recognized net amount and unit price.
        if unit in {'шт','уп','бут'}:
            for p in price:
                if p>0:
                    q=(n/p).quantize(Decimal('1'),rounding=ROUND_HALF_UP)
                    if q>0:pairs.add((q,p))
        taxes=set(product(vat,gross))|{(v,n+v) for v in vat}|{(g-n,g) for g in gross if g>=n}
        for q,p in pairs:
            if q<=0 or p<=0 or abs(q*p-n)>q*Decimal('.005')+Decimal('.01'):
                continue
            for v,g in taxes:
                if v<0 or n+v!=g or g>document_total:
                    continue
                values=(q,p,n,v,g)
                derived=tuple(k for k,x,read in zip(GRID_KEYS,values,candidates) if x not in read)
                if len(derived)<=2:
                    result[values]=derived
    # Keep the bound explicit. Ambiguous damaged OCR must fall back to review,
    # not silently prune alternatives and manufacture a unique combination.
    return result if len(result)<=200 else {}


def resolve_grid_document(rows,doc_total,doc_net=None):
    if not doc_total or not rows:
        return None
    total=Decimal(doc_total)
    net_total=Decimal(doc_net) if doc_net is not None else None
    options=[grid_row_candidates(r['candidates'],r['unit'],total) for r in rows]
    if any(not r for r in options):
        return None
    # Meet in the middle: retain the highest evidence score for each exact
    # sum in each half, then join complementary amounts. A tied best result
    # is never silently selected, even if the financial totals agree.
    target=(total,net_total if net_total is not None else Decimal(0))
    def half(start,end):
        states={(Decimal(0),Decimal(0)):(0,[],False)}
        for index in range(start,end):
            choices=options[index]
            votes=rows[index].get('votes',[{} for _ in GRID_KEYS])
            grouped={}
            for values,derived in choices.items():
                key=(values[-1],values[2] if net_total is not None else Decimal(0))
                score=100*(5-len(derived))+sum(vote.get(value,0) for vote,value in zip(votes,values))
                old=grouped.get(key)
                if old is None or score>old[0]:grouped[key]=(score,[(values,derived)],False)
                elif score==old[0]:grouped[key]=(old[0],old[1],True)
            next_states={}
            for (subtotal,subtotal_net),(score,selected,ambiguous) in states.items():
                for (gross,net),(added,items,tied) in grouped.items():
                    key=(subtotal+gross,subtotal_net+net)
                    if key[0]>target[0] or key[1]>target[1]:continue
                    new_score=score+added
                    old=next_states.get(key)
                    if old is None or new_score>old[0]:next_states[key]=(new_score,selected+items,ambiguous or tied)
                    elif new_score==old[0]:next_states[key]=(old[0],old[1],True)
                    if len(next_states)>10000:return None
            states=next_states
        return states
    middle=len(rows)//2
    left,right=half(0,middle),half(middle,len(rows))
    if left is None or right is None:return None
    chosen=None
    for key,(score,selected,tied) in left.items():
        counterpart=right.get((target[0]-key[0],target[1]-key[1]))
        if counterpart is None:continue
        added,items,other_tied=counterpart
        if chosen is None or score+added>chosen[0]:chosen=(score+added,selected+items,tied or other_tied)
        elif score+added==chosen[0]:chosen=(chosen[0],chosen[1],True)
    return chosen[1] if chosen and not chosen[2] else None


def resolve_grid_core(rows,doc_total):
    """If tax/price columns are unreadable, preserve independently read quantities and totals.

    No quantity or amount is derived solely from a price. Only a unique best
    allocation of printed gross amounts matching the independent total is used.
    """
    if not doc_total or not rows:return None
    total=Decimal(doc_total)
    if total<0:return None
    states={Decimal(0):(0,[],False)}
    for row in rows:
        votes=row.get('votes',[{} for _ in GRID_KEYS])
        gross={g for g in row['candidates'][-1] if 0<=g<=total and g==g.quantize(Decimal('.01'))}
        if not gross:return None
        next_states={}
        for subtotal,(score,items,tied) in states.items():
            for value in gross:
                amount=subtotal+value
                if amount>total:continue
                new_score=score+votes[-1].get(value,0)
                old=next_states.get(amount)
                if old is None or new_score>old[0]:next_states[amount]=(new_score,items+[value],tied)
                elif new_score==old[0]:next_states[amount]=(old[0],old[1],True)
                if len(next_states)>10000:return None
        states=next_states
    chosen=states.get(total)
    if not chosen or chosen[2]:return None
    result=[]
    for row,amount in zip(rows,chosen[1]):
        votes=row.get('votes',[{} for _ in GRID_KEYS])[0]
        quantities={q for q in row['candidates'][0] if q>0}
        score=max((votes.get(q,0) for q in quantities),default=-1)
        best=[q for q in quantities if votes.get(q,0)==score]
        result.append((best[0] if len(best)==1 else None,amount))
    return result


def extract_transport_rows(image,words,scratch,deadline,options,layout,high_image=None):
    gray,mask,scale,lines,total_end,columns,angle=layout
    if high_image is not None:
        gray=ImageOps.grayscale(high_image).rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC);scale=gray.width/900
    rows=[]
    def read_numbers(cell,a,b,y):
        reads=[grid_text(cell,scratch,deadline,options,'number',lang,binary,psm)
               for lang,binary,psm in (('eng',True,7),('rus',True,7),('eng',False,7),('eng',True,8))]
        reads.append(number_in_column(words,(y+5)/mask.height*image.height,image.width*.013,(a-3)/900*image.width,(b+3)/900*image.width))
        return reads
    for y,z in zip(lines,lines[1:]):
        if deadline-monotonic()<5:return [],''
        cells=[grid_cell(gray,mask,scale,(a,y,b,z),short=i>0) for i,(a,b) in enumerate(columns)]
        pos=' '.join(grid_text(cells[0],scratch,deadline,options,'text','rus+eng').replace('|',' ').split()).strip(' —_')
        units={grid_text(cells[1],scratch,deadline,options,'unit',lang,binary).casefold().strip(' .|') for lang,binary in (('rus',True),('rus',False),('rus+eng',False))}
        a,b=columns[1]
        units.update(re.sub(r'[^а-я]','',t.casefold()) for x,yy,_,t in words if (a-3)/900*image.width<=x<(b+3)/900*image.width
                     and (y-2)/mask.height*image.height<=yy<(y+13)/mask.height*image.height)
        units&={'шт','кг','уп','бут','л','г','мл'};unit=units.pop() if len(units)==1 else ''
        choices=[[],[],[],[],[]];votes=[{} for _ in GRID_KEYS]
        for index,key in ((2,0),(3,1),(4,4)):
            a,b=columns[index];reads=read_numbers(cells[index],a,b,y)
            choices[key]=decimal_candidates(reads,key!=0)
            for raw in reads:
                for v in decimal_candidates([raw],key!=0):votes[key][v]=votes[key].get(v,0)+1
        rows.append({'pos':pos,'unit':unit,'candidates':choices,'votes':votes})
    a,b=columns[-1];cell=grid_cell(gray,mask,scale,(a-1,lines[-1],b,total_end),total=True)
    totals=decimal_candidates([grid_text(cell,scratch,deadline,options,'number',lang,binary)
                                 for lang,binary in (('eng',True),('rus',True),('eng',False))],False)
    resolved=[(total,resolve_grid_core(rows,format(total,'f'))) for total in totals]
    resolved=[(total,values) for total,values in resolved if values]
    total,values=resolved[0] if len(resolved)==1 else (None,None)
    result=[]
    for i,row in enumerate(rows):
        qty,gross=values[i] if values else (None,None)
        if gross is not None:
            # The printed price is corroboration only, never a source of qty.
            compatible=[q for q in row['candidates'][0] if q>0 and any(abs(q*p-gross)<=q*Decimal('.005')+Decimal('.01') for p in row['candidates'][1])]
            if len(compatible)==1:qty=compatible[0]
        result.append({'pos':row['pos'],'unit':row['unit'],'qty':format(qty,'f') if qty is not None else '',
                       'gross':format(gross,'f') if gross is not None else '', 'netPrice':'','netSum':'','vat':'','needsReview':True})
    return result,format(total,'f') if total is not None else ''


def bottle_pack_reading(text, alternative=''):
    """Normalize a printed bottle volume only with an explicit litre glyph.

    A lost Cyrillic 'л' can look like 1, п or n in these scans. The decimal
    correction remains a suggestion requiring review, never a trusted value.
    """
    prefix=r'\b(?:бут(?:ылка)?|byt)\.?\s*'
    literal=prefix+r'(\d+)[,. ](\d{1,3})\s*([лlпn])\s*[*×°xх]\s*(\d{1,3})(?!\d)'
    found=re.search(literal,text,re.I)
    if found:
        return text[:found.start()]+f'БУТ {found[1]},{found[2]} л*{found[4]}'+text[found.end():],True
    damaged=re.search(prefix+r'(\d+)[,.](\d{2,3})\s*[*×°xх]\s*(\d{1,3})(?!\d)',text,re.I)
    retry=re.search(literal,alternative,re.I)
    if damaged and retry and damaged[1]==retry[1] and damaged[2]==retry[2]+'1' and damaged[3]==retry[4]:
        return text[:damaged.start()]+f'БУТ {retry[1]},{retry[2]} л*{retry[4]}'+text[damaged.end():],True
    return text,False


def extract_expanded_rows(image,words,scratch,deadline,options,layout=None,high_image=None):
    layout=layout or expanded_grid(image,words)
    if not layout:
        return [],''
    gray,mask,scale,lines,total_end,columns,angle=layout[:7]
    split=len(layout)==9
    if high_image is not None:
        gray=ImageOps.grayscale(high_image).rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC)
        scale=gray.width/900
    result=[]
    for y,z in zip(lines,lines[1:]):
        if deadline-monotonic()<5:
            return [],''
        cells=[grid_cell(gray,mask,scale,(a,y,b,z),short=i>0 and not split) for i,(a,b) in enumerate(columns)]
        pos=' '.join(grid_text(cells[0],scratch,deadline,options,'text','rus+eng').split())
        pos=re.sub(r'\s+',' ',pos.replace('|',' ').replace('_',' ')).strip(' —')
        if high_image is not None and len(re.findall(r'[А-Яа-яЁё]{2,}', pos)) < 2:
            direct = direct_grid_cell(high_image, scale, (columns[0][0], y, columns[0][1], z))
            recovered = ' '.join(grid_text(direct, scratch, deadline, options, 'text', 'rus+eng', psm=6).split())
            if len(re.findall(r'[А-Яа-яЁё]{2,}', recovered)) > len(re.findall(r'[А-Яа-яЁё]{2,}', pos)):
                pos = recovered
        pos=re.sub(r'(\d[,.]\d{1,2})[°×](?=\d)',r'\1*',pos)
        # A second reading from the full-page text can recover marks between
        # volume and packing count. Never infer a pack count from a number
        # without a printed separator.
        a,b=columns[0]
        original_words=[entry for entry in words if (a-3)/900*image.width<=entry[0]<(b+3)/900*image.width
                        and (y-1)/mask.height*image.height<=entry[1]<(z-1)/mask.height*image.height]
        original=' '.join(page_text(original_words).split())
        if split:
            alternate=grid_text(cells[0],scratch,deadline,options,'text','rus+eng',True,6) if deadline-monotonic()>8 else ''
            pos,pack_recovered=bottle_pack_reading(pos,' '.join(alternate.split()))
        else:pack_recovered=False
        pack=r'(?<!\d)(\d+[,.]\d{1,2})\s*[*×°]\s*(\d{1,3})(?!\d)'
        printed_pack=re.search(pack,original)
        if printed_pack and not re.search(pack,pos):
            pos=re.sub(r'(\b(?:бутылка|упаковка)\s+)\d+[,.]\d+(?:\s*[%°×*]\s*\d+)?',
                       lambda m:m[1]+printed_pack[1]+'*'+printed_pack[2],pos,flags=re.I)
        units={grid_text(cells[1],scratch,deadline,options,'unit',lang,binary).casefold().strip(' .|')
               for lang,binary in (('rus',True),('rus+eng',False))}
        a,b=columns[1]
        units.update(re.sub(r'[^а-я]','',t.casefold()) for x,yy,_,t in words
                     if (a-3)/900*image.width<=x<(b+3)/900*image.width
                     and (y-2)/mask.height*image.height<=yy<(y+13)/mask.height*image.height)
        aliases={'упак':'уп','упаковка':'уп','упаковок':'уп','бутылка':'бут'}
        units={aliases.get(u,u) for u in units}
        units&={'шт','кг','уп','бут','л','г','мл'}
        if split and not units and deadline-monotonic()>5:
            direct=direct_grid_cell(gray,scale,(columns[1][0],y,columns[1][1],z))
            retry={grid_text(direct,scratch,deadline,options,'unit',lang,binary).casefold().strip(' .|') for lang,binary in (('rus',False),('rus+eng',False))}
            units={aliases.get(u,u) for u in retry}&{'шт','кг','уп','бут','л','г','мл'}
        unit=units.pop() if len(units)==1 else ''
        choices=[];votes=[]
        for i,cell in enumerate(cells[2:]):
            # Keep the per-row OCR budget bounded. The source words pass and
            # the high-resolution cell each provide an independent reading;
            # running four full Tesseract variants for every numeric column
            # made multi-line invoices time out before the last rows.
            reads=[grid_text(cell,scratch,deadline,options,'number',lang,binary,7)
                   for lang,binary in (('eng',True),('eng',False))]
            a,b=columns[i+2]
            raw_y=(y+5)/mask.height*image.height
            reads.append(number_in_column(words,raw_y,image.width*.013,(a-3)/900*image.width,(b+3)/900*image.width))
            choices.append(decimal_candidates(reads,i>0))
            counts={}
            for raw in reads:
                for value in decimal_candidates([raw],i>0):
                    counts[value]=counts.get(value,0)+1
            votes.append(counts)
        if split:
            # Packaging quantity is the billed quantity. Never substitute the
            # pieces column: printed price and net amount refer to packages.
            count_reads=[]
            for a,b in layout[7:9]:
                crops=[grid_cell(gray,mask,scale,(a,y,b,z),short=False),direct_grid_cell(gray,scale,(a,y,b,z))]
                count_reads.append([grid_text(cell,scratch,deadline,options,'number','eng',binary) for cell in crops for binary in (False,True)])
            compatible=reconcile_package_quantity(choices[0],*count_reads)
            if compatible is not None:
                choices[0]=[compatible]
                votes[0][compatible]=max(votes[0].values(),default=0)+1
                if not unit:unit='уп'
        result.append(dict(pos=pos,unit=unit,candidates=choices,votes=votes,**({'packReview':True} if pack_recovered else {})))
    # Independent full-page OCR of the printed total, near the total label.
    total_labels=[y for x,y,_,t in words if x<image.width*.4 and abs(y/image.height-lines[-1]/mask.height)<.05
                  and re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL) in {'всего','итого'}]
    def read_total(a,b):
        printed={number_in_column(words,y,image.width*.018,(a-5)/900*image.width,(b+5)/900*image.width) for y in total_labels}
        printed=set(decimal_candidates([v for v in printed if v],True)) if split else {Decimal(v) for v in printed if v}
        cell=grid_cell(gray,mask,scale,(a-1,lines[-1],b,total_end),total=True)
        cell_values=decimal_candidates([grid_text(cell,scratch,deadline,options,'number',lang,binary)
                                       for lang,binary in (('eng',True),('rus',True),('eng',False))],split)
        return printed,set(cell_values)
    printed,cell_values=read_total(*columns[-1])
    total_value=next(iter(printed)) if len(printed)==1 else next(iter(cell_values)) if len(cell_values)==1 else None
    total=format(total_value,'f') if total_value is not None else ''
    net_print,net_cell=read_total(*columns[4])
    vat_print,vat_cell=read_total(*columns[5])
    net_matches={n for n,v in product(net_print|net_cell,vat_print|vat_cell) if n+v==total_value}
    doc_net=next(iter(net_matches)) if len(net_matches)==1 else None
    if split:
        # OCR can lose a decimal comma; accept a total only if the row
        # amounts reconcile and the printed net plus tax confirms it.
        confirmed=[]
        for candidate in printed|cell_values:
            nets={n for n,v in product(net_print|net_cell,vat_print|vat_cell) if n+v==candidate}
            if len(nets)!=1:continue
            candidate_total=format(candidate,'f')
            resolved=resolve_grid_document(result,candidate_total,next(iter(nets)))
            core=resolve_grid_core(result,candidate_total) if not resolved else None
            if resolved or core:confirmed.append((candidate_total,resolved,core))
        total,chosen,basic=confirmed[0] if len(confirmed)==1 else ('',None,None)
    else:
        chosen=resolve_grid_document(result,total,doc_net)
        basic=resolve_grid_core(result,total) if not chosen else None
    for i,row in enumerate(result):
        candidates=row.pop('candidates')
        row.pop('votes',None)
        if chosen:
            values,derived=chosen[i]
            row.update(zip(GRID_KEYS,(format(v,'f') for v in values)))
            row['calculatedFields']=list(derived)
            row['rounding']=values[0]*values[1]!=values[2]
        else:
            # Preserve independently read quantity and line total even when
            # the document has no readable grand total. The receiving screen
            # derives unit price as line total / quantity and requires the
            # operator to reconcile the final invoice total before saving.
            row.update(zip(GRID_KEYS,('' for _ in GRID_KEYS)))
            if basic:
                qty,gross=basic[i]
                row['qty']=format(qty,'f') if qty is not None else ''
                row['gross']=format(gross,'f')
            else:
                qtys=candidates[0]
                grosses=candidates[-1]
                if len(qtys)==1:row['qty']=format(next(iter(qtys)),'f')
                if len(grosses)==1:row['gross']=format(next(iter(grosses)),'f')
        row['needsReview']=True
    return result,total


def buyer_name(image, words):
    for x, y, height, word in words:
        if y >= image.height * .45 or re.sub(r'\W','',word.casefold()) != "покупатель":
            continue
        # UPD templates may place the buyer label in the right-hand column.
        nearby = [(xx, token) for xx, yy, _, token in words
                  if x < xx < min(image.width, x + image.width * .45)
                  and abs(yy - y) <= max(5, height * .75)]
        line = " ".join(token for _, token in sorted(nearby))
        line = re.sub(r"^[\s:()0-9а]*?(?=\b(?:ООО|ИП|АО|ПАО|ОАО|ЗАО|Общество)\b)", "", line, flags=re.I)
        line = re.sub(r"^общество с ограниченной ответственностью\s+", "ООО ", line, flags=re.I)
        legal = r"(ООО|ИП|АО|ПАО|ОАО|ЗАО)"
        quoted = re.match(legal + r'\s*[«"“„]([^»"”]+)[»"”]', line, flags=re.I)
        if quoted:
            return f"{quoted[1].upper()} {quoted[2].strip()}"
        plain = re.match(legal + r"\s+(.+)", line, flags=re.I)
        if plain:
            name = re.split(r'\s*\(\d+[а-я]?\)|,|\s+(?=адрес|город|ул\.|ИНН|КПП)',
                            plain[2], maxsplit=1, flags=re.I)[0]
            name = name.strip(' «»"“”„.:;')
            if name and any(letter.isalpha() for letter in name):
                return f"{plain[1].upper()} {name}"
    return ""


def valid_inn(value):
    if not re.fullmatch(r'\d{10}|\d{12}',value) or not value.strip('0'):
        return False
    digits=[int(c) for c in value]
    def checksum(weights):
        return sum(d*w for d,w in zip(digits,weights))%11%10
    if len(digits)==10:
        return checksum([2,4,10,3,5,9,4,6,8])==digits[9]
    return (checksum([7,2,4,10,3,5,9,4,6,8])==digits[10]
            and checksum([3,7,2,4,10,3,5,9,4,6,8])==digits[11])


def seller_inn(image,words):
    labels=[(x,y,h) for x,y,h,t in words if 'инн' in t.casefold() and x<image.width*.35 and y<image.height*.35]
    if not labels:
        return ''
    # The seller's INN appears before the buyer's in the UPD header. Require
    # the seller label on this line, not just any ten digits from the page.
    for x,y,h in sorted(labels,key=lambda a:a[1]):
        line=by_coordinates(words,y,max(h,image.width*.009),x-image.width*.04,image.width*.57)
        if not re.search(r'продав',line,re.I):
            continue
        extended=by_coordinates(words,y+image.width*.008,image.width*.019,x-image.width*.04,image.width*.57)
        candidates={n for n in re.findall(r'(?<!\d)(?:\d{12}|\d{10})(?!\d)',extended) if valid_inn(n)}
        if len(candidates)==1:
            return candidates.pop()
        return ''
    return ''


def retry_seller_inn(image,words,high_image,scratch,deadline,options):
    """Retry a damaged printed INN, without inventing missing digits."""
    labels=[(x,y,h) for x,y,h,t in words if 'инн' in t.casefold() and x<image.width*.35 and y<image.height*.35]
    for x,y,h in sorted(labels,key=lambda a:a[1]):
        line=by_coordinates(words,y,max(h,image.width*.009),x-image.width*.04,image.width*.95)
        if not re.search(r'продав',line,re.I):
            continue
        raw=[(xx,yy,hh,t) for xx,yy,hh,t in words if xx>x and abs(yy-y)<image.width*.009
             and re.fullmatch(r'\d{10}|\d{12}',t)]
        if len(raw)!=1:return ''
        xx,yy,hh,_=raw[0]
        source=high_image if high_image is not None else image
        sx,sy=source.width/image.width,source.height/image.height
        values=set()
        for span in (.024,.029,.034):
            box=(round((xx-image.width*span)*sx),round((yy-hh*.72)*sy),
                 round((xx+image.width*span)*sx),round((yy+hh*.76)*sy))
            cell=ImageOps.autocontrast(ImageOps.grayscale(source.crop(box)))
            for lang,binary in (('eng',False),('rus',False),('eng',True),('rus',True)):
                val=re.sub(r'\s+','',grid_text(cell,scratch,deadline,options,'number',lang,binary))
                if valid_inn(val):values.add(val)
        return next(iter(values)) if len(values)==1 else ''
    return ''


def invoice_fields(image, words):
    width = image.width
    labels = [(x, y) for x, y, _, token in words
              if x<width*.35 and y<image.height*.45
              and re.search(r"счет.?фактура|накладная",token.lower().replace("ё","е"))]
    document_number = date = seller = ""
    for x, y in sorted(labels, key=lambda pair:pair[1]):
        candidates=[]
        near = [(xx, yy, word) for xx, yy, _, word in words
                if abs(yy-y)<=width*.012 and x+width*.05<xx<x+width*.29]
        candidates.append(" ".join(word for _,_,word in sorted(near)).lower())
        # The number and date may be on the next line underneath the label.
        for yy,line_words in bucket_lines(words):
            if abs(yy-y)<=width*.035:
                candidates.append(' '.join(word for xx,word in sorted(line_words) if x+width*.05<xx<x+width*.32).lower())
        for line in candidates:
            written = re.search(r"\b(\d{1,2})\s+("+"|".join(MONTHS)+r")\s+(20\d{2})\b", line)
            numeric = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b", line)
            match = written or numeric
            if not match:
                continue
            month = MONTHS.index(written[2])+1 if written else int(numeric[2])
            number_match = re.search(r"(?<!\w)(?:[а-яa-z]{1,8}[-/]?)?\d{1,14}(?:[-/]\d{1,8})?(?!\w)",line[:match.start()],re.I)
            if not number_match:continue
            try:
                date = calendar_date(int(match[3]), month, int(match[1])).isoformat()
            except ValueError:
                continue
            document_number = number_match[0].upper()
            break
        if document_number:break
    seller_labels = [(x,y) for x,y,_,token in words if re.sub(r"\W","",token.lower())=="продавец" and x<width*.35 and y<image.height*.45]
    if seller_labels:
        x,y = seller_labels[0]
        seller_line = by_coordinates(words,y+width*.002,width*.012,x+width*.03,width*.94)
        seller_line = re.split(r'\b(?:покупатель|адрес|инн|кпп)\b',seller_line,maxsplit=1,flags=re.I)[0].strip()
        quoted = re.search(r'обществ\S*\s+с\s+ограниченн\S*\s+ответственност\S*\s*[«"“„]([^»"”]+)[»"”]',seller_line,flags=re.I)
        company = re.search(r"обществ\S*\s+с\s+ограниченн\S*\s+ответственност\S*\s*(.+)",seller_line,flags=re.I)
        if quoted:
            seller = "ООО " + quoted[1].strip()
        elif company:
            seller = "ООО " + company[1].strip()
        elif re.match(r"^(?:ООО|ИП|АО)\b",seller_line,re.I):
            seller = re.sub(r'\s*\(\d+[а-я]?\)\s*$', '', seller_line)
        seller = seller.translate(str.maketrans("", "", '«»“”'+chr(34)+chr(39))).strip()
    return {"supplier":seller,"supplierInn":seller_inn(image,words),"buyer":buyer_name(image,words),"date":date,"number":document_number,
            "deliveryAddress":delivery_address(image,words)}


def high_resolution_header_fields(image, scratch, deadline, options):
    """Retry UPD header fields with a larger OCR pass when page TSV missed them."""
    header = image.crop((0, 0, image.width, round(image.height * (.42 if image.width>image.height else .24))))
    ImageOps.autocontrast(ImageOps.grayscale(header), cutoff=1).save(scratch)
    try:
        raw = command(["tesseract", str(scratch), "stdout", *options, "-l", "+".join(OCR_LANGUAGES), "--psm", "6"],
                      timeout=min(16, max(2, deadline - monotonic())))
    except RecognitionError:
        return {}
    text = raw.decode("utf-8", "replace")
    normalized = re.sub(r"\s+", " ", text).replace("ё", "е")
    result = {}
    months = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря"
    written = re.search(r"\b(\d{1,2})\s+(" + "|".join(months.split()) + r")\s+(20\d{2})\b", normalized, re.I)
    numeric = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b", normalized)
    date_match = written or numeric
    if date_match:
        try:
            month = months.split().index(written[2].lower()) + 1 if written else int(numeric[2])
            year = int(written[3]) if written else int(numeric[3])
            result["date"] = calendar_date(year, month, int(date_match[1])).isoformat()
        except (ValueError, IndexError):
            pass
    number_match = re.search(r"(?:№|N[еe0o°])\s*[:.]?\s*([0-9]{4,14})", normalized, re.I)
    if number_match:
        result["number"] = number_match[1]

    def company(segment):
        legal = r"(?:общество\s+[св]\s+ограниченн\w*\s+ответственност\w*|ооо|ип|ао|пао|оао|зао)"
        match = re.search(legal + r"\s*[«\"“„'‘]?\s*([^»\"”’'\n,()]{2,55})", segment, re.I)
        if not match:
            return ""
        name = re.split(r"\s+(?:инн|кпп|адрес|покупатель|продавец)\b", match[1], maxsplit=1, flags=re.I)[0]
        name = name.strip(" .:; «»\"“”'‘’")
        if not re.fullmatch(r"[А-ЯЁ][А-ЯЁа-яё .-]{2,54}", name):
            return ""
        prefix = re.match(r"общество\s+[св]\s+ограниченн\w*\s+ответственност\w*", match[0], re.I)
        kind = "ООО" if prefix or match[0].strip().lower().startswith("ооо") else match[0].split()[0].upper()
        return f"{kind} {name}" if name else ""

    seller_label = re.search(r"прода[а-яе]*", text, re.I)
    buyer_label = re.search(r"покупатель", text, re.I)
    if seller_label:
        end = buyer_label.start() if buyer_label and buyer_label.start() > seller_label.start() else seller_label.start() + 260
        result["supplier"] = company(text[seller_label.start():end])
    if buyer_label:
        end = min((p.start() for p in re.finditer(r"инн|кпп|адрес|грузополуч", text[buyer_label.start():], re.I)), default=260)
        result["buyer"] = company(text[buyer_label.start():buyer_label.start()+end])
    return result


def delivery_address(image,words):
    """Read an explicitly labelled consignee/delivery address, not the buyer's legal address."""
    width=image.width
    candidates=[]
    for x,y,h,t in words:
        label=re.sub(r'\W','',t.casefold())
        if y>image.height*.45 or x>width*.5:
            continue
        if not (label.startswith('грузополуч') or (label=='адрес' and any(
            abs(yy-y)<width*.012 and 0<xx-x<width*.18 and tt.casefold().startswith('доставк') for xx,yy,_,tt in words))):
            continue
        nearby=[entry for entry in words if x+width*.025<entry[0]<width*.94 and abs(entry[1]-y)<max(h*1.3,width*.012)]
        line=' '.join(page_text(nearby).split())
        # Require a street/house marker; a bare company or a postal code is not an address.
        street_type=r'(?:улица|ул\.?|переулок|пер\.?|проспект|пр-т|шоссе|наб\.?|бульвар|площадь)'
        street=re.search(r'(?<!\w)'+street_type+r'\s+([А-Яа-яЁё-]{2,})',line,re.I)
        if not street or street[1].casefold() in {'по','окпо','инн','кпп','адрес','получатель','грузополучатель','дом'}:
            street=re.search(r'(?<!\w)([А-Яа-яЁё-]{2,})\s+'+street_type+r'(?=\s*[,.;]?\s*(?:дом|д\.|№|\d))',line,re.I)
        if not street:
            # A scan may omit the tiny "ул." marker. Return only the
            # explicitly printed postcode, city, street and house span;
            # a bare house number or an unlabelled address is not enough.
            literal=re.search(r'(?<!\d)(\d{6})[\s_,.]+(?:г\.?\s*)?([А-Яа-яЁё-]{2,})\s*(?:г\.?\s*)?[, ]+([А-Яа-яЁё-]{2,})\s+дом\s*(?:№\s*)?\d+',line,re.I)
            if literal:
                tail=re.split(r'\s*\(\d+[а-я]?\)\s*|\b(?:ИНН|КПП|ОКПО|плательщик|документ\w*)\b',line[literal.start():],maxsplit=1,flags=re.I)[0].strip(' ,;')
                if 8<=len(tail)<=250:candidates.append(tail.replace('_',' '))
            continue
        if not street or not re.search(r'\d',line[street.start():]):
            continue
        if street[1].casefold() in {'по','окпо','инн','кпп','адрес','получатель','грузополучатель','дом'}:
            continue
        start=street.start()
        postal=re.search(r'(?<!\d)\d{6}(?!\d)',line[:start])
        city=re.search(r'(?<!\w)г\.\s*[А-Яа-яЁё-]+',line[:start],re.I)
        if postal:start=postal.start()
        elif city:start=city.start()
        result=re.split(r'\s*\(\d+[а-я]?\)\s*|\b(?:ИНН|КПП|ОКПО|плательщик|документ)\b',line[start:],maxsplit=1,flags=re.I)[0].strip(' ,;')
        if 8<=len(result)<=250 and re.search(r'\d',result[street.start()-start:]):candidates.append(result)
    unique=list(dict.fromkeys(candidates))
    return unique[0] if len(unique)==1 else ''


def transport_header(image,words,high_image,scratch,deadline,options):
    """Read number and date from explicitly labelled right-hand cells of form 1-Т."""
    w,h=image.size
    date_labels=[(x,y) for x,y,_,t in words if t.casefold()=='дата' and x>w*.6 and y<h*.2 and any(
        0<xx-x<w*.12 and abs(yy-y)<w*.015 and tt.casefold().startswith('составлен') for xx,yy,_,tt in words)]
    if len(date_labels)!=1:return {}
    x,y=date_labels[0]
    right_label=max((xx for xx,yy,_,tt in words if x<xx<x+w*.12 and abs(yy-y)<w*.015 and tt.casefold().startswith('составлен')),default=x)
    number_labels=[(xx,yy) for xx,yy,_,t in words if t.strip()=='№' and xx>w*.65 and h*.008<y-yy<h*.035]
    if len(number_labels)!=1:return {}
    source=high_image if high_image is not None else image;sx,sy=source.width/w,source.height/h
    left=max(right_label+w*.035,number_labels[0][0]+w*.01);right=min(w*.97,left+w*.095)
    if right-left<w*.04:return {}
    def read_cell(center):
        cell=ImageOps.autocontrast(ImageOps.grayscale(source.crop((round(left*sx),round((center-h*.008)*sy),round(right*sx),round((center+h*.008)*sy)))))
        return [grid_text(cell,scratch,deadline,options,'number',lang,binary,7) for lang,binary in (('eng',False),('rus',False),('eng',True))]
    raw_numbers=read_cell(number_labels[0][1]);numbers=[v for v in raw_numbers if re.fullmatch(r'\d{1,14}',v)]
    dates=[]
    for raw in read_cell(y):
        match=re.fullmatch(r'(\d{2})[.,/-]?(\d{2})[.,/-]?(20\d{2})',raw)
        if not match:continue
        try:dates.append(calendar_date(int(match[3]),int(match[2]),int(match[1])).isoformat())
        except ValueError:pass
    result={}
    for key,values in (('number',numbers),('date',dates)):
        agreed={v for v in values if values.count(v)>=2}
        if len(agreed)==1:result[key]=agreed.pop()
    return result


def complete_gross_amounts(rows, total):
    """Offer a calculated amount only when independently read totals agree."""
    candidates = []
    try:
        for row in rows:
            gross = Decimal(row["netSum"]) + Decimal(row["vat"])
            if row["gross"] and gross != Decimal(row["gross"]):
                return
            candidates.append(gross)
        if sum(candidates) != Decimal(total):
            return
    except InvalidOperation:
        return
    for row, gross in zip(rows, candidates):
        if row["gross"]:
            continue
        row["gross"] = format(gross, ".2f")
        row["calculatedGross"] = True


def validate_document_total(rows, total):
    """Keep a document total only when every extracted line reconciles to it."""
    if not rows or not total:
        return total
    try:
        if any(not row.get("gross") for row in rows):
            return ""
        declared=Decimal(total).quantize(Decimal(".01"))
        summed=sum((Decimal(row["gross"]).quantize(Decimal(".01")) for row in rows),Decimal(0))
    except (InvalidOperation, ValueError):
        return ""
    if declared!=summed:
        for row in rows:
            row["needsReview"]=True
        return ""
    return total


def item_rows_before_signature(rows):
    """The signature block is not part of the goods table on an UPD."""
    result=[]
    for row in rows:
        name=' '.join(str(row.get('pos','')).casefold().split())
        if re.match(r'^[\W\d]*(?:руководитель\s+организац\w*|главный\s+бухгалтер|иное\s+уполномоченное\s+лицо)\b',name):
            break
        result.append(row)
    return result


def recognize(name, data):
    if not shutil.which("tesseract"):
        raise RecognitionError("На сервере нужно установить Tesseract с русским языком.")
    options = tesseract_options()
    with TemporaryDirectory(prefix="bar-ocr-") as dirname, ExitStack() as resources:
        try:
            from ruled_invoice import CellReader, printed_table, printed_header
            cell_reader = CellReader(os.fsencode(options[1]) if options else None)
            resources.callback(cell_reader.cleanup.close)
        except (ImportError, OSError, AttributeError):
            cell_reader = None
        folder = Path(dirname)
        deadline = monotonic()+120
        pages = source_pages(folder,name,data)
        all_rows, all_text, previews, page_angles = [], [], [], []
        fields, total, angle = {}, "", None
        for index, page in enumerate(pages,1):
            image, words, combined, angle = scan_page(read_image(page),folder/"work.png",deadline,options,angle)
            page_angles.append(angle)
            transport=bool(re.search(r'товарно\s*[-–—]?\s*транспортная\s+накладная',combined,re.I))
            ruled = None
            if cell_reader:
                try:
                    ruled = printed_table(image, cell_reader, deadline, transport, all_rows)
                except OSError:
                    cell_reader = None
            if ruled:
                layout = None
            elif transport:
                layout = transport_grid(image, words)
            else:
                layout = split_quantity_grid(image, words) or standard_upd_grid(image, words) or expanded_grid(image, words)
            high_image=None
            if (layout or index==1) and Path(name).suffix.lower()=='.pdf' and deadline-monotonic()>15:
                try:
                    prefix=folder/f'high-{index}'
                    command(['pdftoppm','-f',str(index),'-l',str(index),'-singlefile','-scale-to','5000','-png',str(folder/'source.pdf'),str(prefix)],timeout=30)
                    high_image=read_image(prefix.with_suffix('.png'))
                    if angle:
                        high_image=high_image.rotate(angle,expand=True)
                except RecognitionError:
                    pass
            rows, page_total = ruled or ((extract_transport_rows(image,words,folder/"cell.png",deadline,options,layout,high_image) if transport else
                                extract_expanded_rows(image,words,folder/"cell.png",deadline,options,layout,high_image)) if layout else ([], ''))
            if not rows and not transport:
                rows, page_total = extract_rows(image,words)
            if (cell_reader and Path(name).suffix.lower()=='.pdf' and deadline-monotonic()>22
                    and (not rows or any(not row.get('qty') for row in rows))):
                # Lossless rendering can recover cell borders and decimal marks
                # lost on the initial JPEG. Only combine rows with matching sums.
                try:
                    prefix = folder/f'grid-retry-{index}'
                    command(['pdftoppm','-f',str(index),'-l',str(index),'-singlefile',
                             '-scale-to','4000' if rows else '3000','-gray','-png',
                             str(folder/'source.pdf'),str(prefix)],timeout=18)
                    alternate = read_image(prefix.with_suffix('.png'))
                    if angle:
                        alternate = alternate.rotate(angle,expand=True)
                    retry = printed_table(alternate,cell_reader,deadline,transport,all_rows)
                    if retry and not rows:
                        rows,page_total = retry
                    elif retry and len(rows)==len(retry[0]) and all(
                            a.get('gross') and a['gross']==b.get('gross')
                            for a,b in zip(rows,retry[0])):
                        for current,other in zip(rows,retry[0]):
                            for key in ('qty','unit','netSum','vat'):
                                if not current.get(key) and other.get(key):
                                    current[key]=other[key]
                        page_total = page_total or retry[1]
                except (OSError,RecognitionError):
                    pass
            rows=item_rows_before_signature(rows)
            if index==1:
                fields = invoice_fields(image, words)
                if high_image is not None and any(not fields.get(key) for key in ("number", "date", "supplier", "buyer", "deliveryAddress")) and deadline-monotonic()>8:
                    # Read the header at source resolution; the coordinate
                    # parser keeps the consignee separate from the buyer.
                    header=high_image.crop((0,0,high_image.width,round(high_image.height*(.44 if high_image.width>high_image.height else .30))))
                    try:
                        header_words=words_from_image(header,folder/'header-tsv.png',min(12,deadline-monotonic()),options)
                        recovered=invoice_fields(high_image,header_words)
                        for key,value in recovered.items():
                            if not fields.get(key) and value:fields[key]=value
                    except RecognitionError:
                        pass
                if high_image is not None and any(not fields.get(key) for key in ("number", "date", "supplier", "buyer")) and deadline-monotonic()>8:
                    retry = high_resolution_header_fields(high_image, folder/"header.png", deadline, options)
                    for key, value in retry.items():
                        if not fields.get(key) and value:
                            fields[key] = value
                if transport and deadline-monotonic()>8:
                    fields.update(transport_header(image,words,high_image,folder/'transport-header.png',deadline,options))
                if not fields['supplierInn'] and deadline-monotonic()>6:
                    fields['supplierInn']=retry_seller_inn(image,words,high_image,folder/'inn.png',deadline,options)
                if cell_reader and not transport and deadline-monotonic()>5:
                    try:
                        printed = printed_header(image,cell_reader)
                        if fields.get('deliveryAddress') and not re.search(
                                r'документ|его адрес|платеж', fields['deliveryAddress'], re.I):
                            printed.pop('deliveryAddress', None)
                        fields.update(printed)
                    except OSError:
                        pass
            if len(all_rows)+len(rows)>MAX_ROWS:
                raise RecognitionError("В документе слишком много строк для одного предпросмотра.")
            all_rows.extend(rows)
            if page_total:
                total = page_total
            all_text.append(combined[:7000])
            image.thumbnail((1500,1500),Image.Resampling.LANCZOS)
            with io.BytesIO() as output:
                image.save(output,format="JPEG",quality=72)
                previews.append(base64.b64encode(output.getvalue()).decode("ascii"))
        complete_gross_amounts(all_rows,total)
        total=validate_document_total(all_rows,total)
        text="\n\n".join(all_text)
        warning=""
        if re.search(r'товарно\s*[-–—]?\s*транспортная\s+накладная',text,re.I):
            warning="Распознана товарно-транспортная накладная (ТТН). Для сверки закупочной цены и НДС используйте соответствующий УПД или счёт-фактуру."
        return {**fields,"rows":all_rows,"total":total,"preview":previews,"ocrText":text,"documentWarning":warning,
                "mode":"local-ocr","pageAngles":page_angles}

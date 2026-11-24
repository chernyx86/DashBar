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
    command(["pdftoppm", "-scale-to", "2400", "-png", str(path), str(folder / "page")], timeout=18)
    pages = sorted(folder.glob("page-*.png"))
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
    image.thumbnail((2460, 2460), Image.Resampling.LANCZOS)
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


def expanded_grid(image, words):
    """Recognize the expanded UPD layout only when both headers and grid agree."""
    w, h = image.size
    names = [(x, y) for x,y,_,t in words if 'наименование' in t.casefold()]
    prices = [(x,y) for x,y,_,t in words if re.fullmatch(r'цен[аыи]', re.sub(r'\W','',t.casefold()))]
    quantities = [(x,y) for x,y,_,t in words if t.casefold() == 'количество' or
                  (re.sub(r'\W','',t.casefold())=='коли' and any(abs(x-xx)<w*.025 and 0<yy-y<w*.06 and 'чество' in tt.casefold()
                    for xx,yy,_,tt in words))]
    totals = [(x,y) for x,y,_,t in words if re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL) in {'всего','итого'}]
    anchors = [(nx,ny,px,py,qx) for nx,ny in names for px,py in prices for qx,qy in quantities
               if .23*w < px-nx < .39*w and .03*w < px-qx < .12*w
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


def extract_expanded_rows(image,words,scratch,deadline,options,layout=None,high_image=None):
    layout=layout or expanded_grid(image,words)
    if not layout:
        return [],''
    gray,mask,scale,lines,total_end,columns,angle=layout
    if high_image is not None:
        gray=ImageOps.grayscale(high_image).rotate(angle,fillcolor=255,resample=Image.Resampling.BICUBIC)
        scale=gray.width/900
    result=[]
    for y,z in zip(lines,lines[1:]):
        if deadline-monotonic()<5:
            return [],''
        cells=[grid_cell(gray,mask,scale,(a,y,b,z),short=i>0) for i,(a,b) in enumerate(columns)]
        pos=' '.join(grid_text(cells[0],scratch,deadline,options,'text','rus+eng').split())
        pos=re.sub(r'\s+',' ',pos.replace('|',' ').replace('_',' ')).strip(' —')
        pos=re.sub(r'(\d[,.]\d{1,2})[°×](?=\d)',r'\1*',pos)
        # A second reading from the full-page text can recover marks between
        # volume and packing count. Never infer a pack count from a number
        # without a printed separator.
        a,b=columns[0]
        original_words=[entry for entry in words if (a-3)/900*image.width<=entry[0]<(b+3)/900*image.width
                        and (y-1)/mask.height*image.height<=entry[1]<(z-1)/mask.height*image.height]
        original=' '.join(page_text(original_words).split())
        pack=r'(?<!\d)(\d+[,.]\d{1,2})\s*[*×°]\s*(\d{1,3})(?!\d)'
        printed_pack=re.search(pack,original)
        if printed_pack and not re.search(pack,pos):
            pos=re.sub(r'(\b(?:бутылка|упаковка)\s+)\d+[,.]\d+(?:\s*[%°×*]\s*\d+)?',
                       lambda m:m[1]+printed_pack[1]+'*'+printed_pack[2],pos,flags=re.I)
        units={grid_text(cells[1],scratch,deadline,options,'unit',lang,binary).casefold().strip(' .|')
               for lang,binary in (('rus',True),('rus',False),('rus+eng',False))}
        a,b=columns[1]
        units.update(re.sub(r'[^а-я]','',t.casefold()) for x,yy,_,t in words
                     if (a-3)/900*image.width<=x<(b+3)/900*image.width
                     and (y-2)/mask.height*image.height<=yy<(y+13)/mask.height*image.height)
        units&={'шт','кг','уп','бут','л','г','мл'}
        unit=units.pop() if len(units)==1 else ''
        choices=[];votes=[]
        for i,cell in enumerate(cells[2:]):
            reads=[grid_text(cell,scratch,deadline,options,'number',lang,binary,psm)
                   for lang,binary,psm in (('eng',True,7),('rus',True,7),('eng',False,7),('eng',True,8))]
            a,b=columns[i+2]
            raw_y=(y+5)/mask.height*image.height
            reads.append(number_in_column(words,raw_y,image.width*.013,(a-3)/900*image.width,(b+3)/900*image.width))
            choices.append(decimal_candidates(reads,i>0))
            counts={}
            for raw in reads:
                for value in decimal_candidates([raw],i>0):
                    counts[value]=counts.get(value,0)+1
            votes.append(counts)
        result.append(dict(pos=pos,unit=unit,candidates=choices,votes=votes))
    # Independent full-page OCR of the printed total, near the total label.
    total_labels=[y for x,y,_,t in words if x<image.width*.4 and abs(y/image.height-lines[-1]/mask.height)<.05
                  and re.sub(r'\W','',t.casefold()).translate(OCR_TOTAL_LABEL) in {'всего','итого'}]
    def read_total(a,b):
        printed={number_in_column(words,y,image.width*.018,(a-5)/900*image.width,(b+5)/900*image.width) for y in total_labels}
        printed={Decimal(v) for v in printed if v}
        cell=grid_cell(gray,mask,scale,(a-1,lines[-1],b,total_end),total=True)
        cell_values=decimal_candidates([grid_text(cell,scratch,deadline,options,'number',lang,binary)
                                       for lang,binary in (('eng',True),('rus',True),('eng',False))],False)
        return printed,set(cell_values)
    printed,cell_values=read_total(*columns[-1])
    total_value=next(iter(printed)) if len(printed)==1 else next(iter(cell_values)) if len(cell_values)==1 else None
    total=format(total_value,'f') if total_value is not None else ''
    net_print,net_cell=read_total(*columns[4])
    vat_print,vat_cell=read_total(*columns[5])
    net_matches={n for n,v in product(net_print|net_cell,vat_print|vat_cell) if n+v==total_value}
    doc_net=next(iter(net_matches)) if len(net_matches)==1 else None
    chosen=resolve_grid_document(result,total,doc_net)
    for i,row in enumerate(result):
        candidates=row.pop('candidates')
        row.pop('votes',None)
        if chosen:
            values,derived=chosen[i]
            row.update(zip(GRID_KEYS,(format(v,'f') for v in values)))
            row['calculatedFields']=list(derived)
            row['rounding']=values[0]*values[1]!=values[2]
        else:
            # Without a unique consistent set, leave disputed financial fields
            # blank; the product and unit remain visible for review.
            row.update(zip(GRID_KEYS,('' for _ in GRID_KEYS)))
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
    return {"supplier":seller,"supplierInn":seller_inn(image,words),"buyer":buyer_name(image,words),"date":date,"number":document_number}


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


def recognize(name, data):
    if not shutil.which("tesseract"):
        raise RecognitionError("На сервере нужно установить Tesseract с русским языком.")
    options = tesseract_options()
    with TemporaryDirectory(prefix="bar-ocr-") as dirname:
        folder = Path(dirname)
        deadline = monotonic()+70
        pages = source_pages(folder,name,data)
        all_rows, all_text, previews = [], [], []
        fields, total, angle = {}, "", None
        for index, page in enumerate(pages,1):
            image, words, combined, angle = scan_page(read_image(page),folder/"work.png",deadline,options,angle)
            layout=expanded_grid(image,words)
            high_image=None
            if layout and Path(name).suffix.lower()=='.pdf' and deadline-monotonic()>15:
                try:
                    prefix=folder/f'high-{index}'
                    command(['pdftoppm','-f',str(index),'-l',str(index),'-singlefile','-scale-to','3600','-png',str(folder/'source.pdf'),str(prefix)],timeout=8)
                    high_image=read_image(prefix.with_suffix('.png'))
                    if angle:
                        high_image=high_image.rotate(angle,expand=True)
                except RecognitionError:
                    pass
            rows, page_total = extract_expanded_rows(image,words,folder/"cell.png",deadline,options,layout,high_image) if layout else ([], '')
            if not rows:
                rows, page_total = extract_rows(image,words)
            if index==1:
                fields = invoice_fields(image, words)
                if not fields['supplierInn'] and deadline-monotonic()>6:
                    fields['supplierInn']=retry_seller_inn(image,words,high_image,folder/'inn.png',deadline,options)
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
        text="\n\n".join(all_text)
        warning=""
        if re.search(r'товарно\s*[-–—]?\s*транспортная\s+накладная',text,re.I):
            warning="Распознана товарно-транспортная накладная (ТТН). Для сверки закупочной цены и НДС используйте соответствующий УПД или счёт-фактуру."
        return {**fields,"rows":all_rows,"total":total,"preview":previews,"ocrText":text,"documentWarning":warning,
                "mode":"local-ocr"}

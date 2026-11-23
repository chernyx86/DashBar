"""Local OCR and conservative draft extraction for invoices."""
import base64
import csv
import io
import os
import re
import shutil
import subprocess
from datetime import date as calendar_date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic

from PIL import Image, ImageOps, UnidentifiedImageError

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
    return best[1:]


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


def buyer_name(image, words):
    for x, y, height, word in words:
        if y >= image.height * .45 or word.casefold().strip(":") != "покупатель":
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


def invoice_fields(image, words):
    width = image.width
    labels = [(x, y) for x, y, _, token in words
              if x<width*.35 and y<image.height*.45
              and re.search(r"счет.?фактура|накладная",token.lower().replace("ё","е"))]
    document_number = date = seller = ""
    for x, y in sorted(labels, key=lambda pair:pair[1]):
        near = [(xx, yy, word) for xx, yy, _, word in words
                if abs(yy-y)<=width*.012 and x+width*.05<xx<x+width*.29]
        line = " ".join(word for _,_,word in sorted(near)).lower()
        written = re.search(r"\b(\d{1,2})\s+("+"|".join(MONTHS)+r")\s+(20\d{2})\b", line)
        numeric = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b", line)
        match = written or numeric
        if not match:
            continue
        month = MONTHS.index(written[2])+1 if written else int(numeric[2])
        try:
            date = calendar_date(int(match[3]), month, int(match[1])).isoformat()
        except ValueError:
            continue
        number_match = re.search(r"\b\d{1,14}\b", line[:match.start()])
        document_number = number_match[0] if number_match else ""
        break
    seller_labels = [(x,y) for x,y,_,token in words if re.sub(r"\W","",token.lower())=="продавец" and x<width*.35]
    if seller_labels:
        x,y = seller_labels[0]
        seller_line = by_coordinates(words,y+width*.004,width*.009,x+width*.08,width*.49)
        company = re.search(r"обществ\S*\s+с\s+ограниченн\S*\s+ответственност\S*\s*(.+)",seller_line,flags=re.I)
        if company:
            seller = "ООО " + company[1].strip()
        elif re.match(r"^(?:ООО|ИП|АО)\b",seller_line,re.I):
            seller = seller_line
        seller = seller.translate(str.maketrans("", "", '«»“”'+chr(34)+chr(39))).strip()
    return {"supplier":seller,"buyer":buyer_name(image,words),"date":date,"number":document_number}


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
            rows, page_total = extract_rows(image,words)
            if index==1:
                fields = invoice_fields(image, words)
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
        return {**fields,"rows":all_rows,"total":total,"preview":previews,"ocrText":"\n\n".join(all_text),
                "mode":"local-ocr"}

"""Read ruled invoice tables by their printed column numbers and cell borders."""
import ctypes
import ctypes.util
import re
from contextlib import ExitStack
from decimal import Decimal
from itertools import product
from time import monotonic

import numpy as np
from PIL import Image, ImageFilter, ImageOps


def runs(mask):
    points = np.flatnonzero(mask)
    return [group for group in np.split(points, np.flatnonzero(np.diff(points) > 1) + 1) if group.size]


def strokes(mask, length, axis):
    # Erode and dilate straight strokes without adding a computer vision runtime.
    def windows(array, size):
        pads = [(0, 0), (0, 0)]
        pads[axis] = (size // 2, size - size // 2 - 1)
        padded = np.pad(array, pads)
        return np.lib.stride_tricks.sliding_window_view(padded, size, axis=axis)
    return windows(windows(mask, length).all(-1), length).any(-1)


def geometry(image):
    mono = ImageOps.grayscale(image)
    scale = mono.width / 1600
    size = (1600, round(mono.height / scale))
    small = mono.resize(size)
    def ink(page):
        return np.asarray(page.filter(ImageFilter.BoxBlur(8)), dtype=np.int16) - np.asarray(page) > 18
    binary = Image.fromarray(np.uint8(ink(small)) * 255)
    def alignment(angle):
        levels = np.asarray(binary.rotate(angle))[:, 240:1360].mean(1)
        return (np.minimum(levels, 180) ** 3).sum()
    angle = max(np.arange(-3, 3.01, .12), key=alignment)
    mono = mono.rotate(angle, Image.Resampling.BICUBIC, fillcolor=255)
    mask = ink(mono.resize(size))
    horizontal = strokes(mask, 24, 1)
    vertical = strokes(mask, 10, 0)
    def vicinity(array, axis, n):
        return np.logical_or.reduce([np.roll(array, k, axis=axis) for k in range(-n, n+1)])
    rule_rows = runs(vicinity(horizontal, 0, 2).sum(1) > 512)
    lines = [int(g[len(g)//2]) for g in rule_rows]
    vertical = vicinity(vertical, 1, 1)
    return mono, scale, horizontal, vertical, lines


class CellReader:
    """Reuse Tesseract language initialization across the cells of one document."""
    def __init__(self, directory):
        lib = ctypes.CDLL(ctypes.util.find_library("tesseract") or "libtesseract.so")
        ptr = ctypes.c_void_p
        integer = ctypes.c_int
        string = ctypes.c_char_p
        for name, result, args in (
            ('TessBaseAPICreate', ptr, []), ('TessBaseAPIDelete', None, [ptr]),
            ('TessBaseAPIInit3', integer, [ptr, string, string]),
            ('TessBaseAPISetPageSegMode', None, [ptr, integer]),
            ('TessBaseAPISetVariable', integer, [ptr, string, string]),
            ('TessBaseAPISetImage', None, [ptr, string, integer, integer, integer, integer]),
            ('TessBaseAPIGetUTF8Text', ptr, [ptr]), ('TessDeleteText', None, [ptr]),
        ):
            func = getattr(lib, name)
            func.restype, func.argtypes = result, args
        self.lib, self.directory, self.handles = lib, directory, {}
        self.cleanup = ExitStack()

    def read(self, cell, numeric=False, single=True, language=None, psm=None):
        if cell is None or min(cell.size) < 3:
            return ''
        language = language or (b'eng' if numeric else b'rus+eng')
        key = numeric, language
        if key not in self.handles:
            handle = self.lib.TessBaseAPICreate()
            if not handle:
                raise OSError("Tesseract initialization failed")
            self.cleanup.callback(self.lib.TessBaseAPIDelete, handle)
            if self.lib.TessBaseAPIInit3(handle, self.directory, language):
                raise OSError("Tesseract language model unavailable")
            self.handles[key] = handle
            if numeric:
                self.lib.TessBaseAPISetVariable(handle, b'tessedit_char_whitelist', b'0123456789,.')
        handle = self.handles[key]
        self.lib.TessBaseAPISetPageSegMode(handle, psm or (7 if single else 6))
        cell = ImageOps.expand(cell.resize((cell.width*2, cell.height*2), Image.Resampling.LANCZOS), 12, 255)
        raw = cell.tobytes()
        self.lib.TessBaseAPISetImage(handle, raw, cell.width, cell.height, 1, cell.width)
        ptr = self.lib.TessBaseAPIGetUTF8Text(handle)
        if not ptr:
            return ''
        try:
            return ' '.join(ctypes.string_at(ptr).decode('utf8').split())
        finally:
            self.lib.TessDeleteText(ptr)


def column_edges(vertical, y, z):
    if z-y < 5:
        return []
    profile = vertical[y+2:z-2].mean(0)
    return [int(g[len(g)//2]) for g in runs(profile > .55) if len(g)<17]


def cell_image(page, scale, rules, box):
    x, y, right, bottom = box
    lo, hi = x + 2, right - 2
    if hi <= lo:
        return None
    def line_at(level):
        start = max(0, level-10)
        weights = rules[start:level+11, lo:hi].mean(1)
        if not len(weights) or weights.max()<.16:
            return level
        return start + int(np.argmax(weights - .01 * np.abs(np.arange(len(weights))+start-level)))
    y, bottom = line_at(y), line_at(bottom)
    bounds = tuple(round(v * scale) for v in (x+1.3, y+1.25, right-1.2, bottom-.9))
    if bounds[3] - bounds[1] < 3 or bounds[2] - bounds[0] < 3:
        return None
    cell = page.crop(bounds)
    cell = ImageOps.autocontrast(cell, cutoff=.5)
    pixels = np.asarray(cell).copy()
    # A cropped ruled cell often retains thin border fragments. Remove long
    # edge strokes and trim white space before asking Tesseract for one line.
    margin = max(2, round(2*scale))
    for side in (pixels, pixels[::-1]):
        for i in range(min(margin,len(side))):
            if (side[i]<180).mean()>.50:
                side[i]=255
    for side in (pixels.T,pixels.T[::-1]):
        for i in range(min(margin,len(side))):
            if (side[i]<180).mean()>.48:
                side[i]=255
    cell = Image.fromarray(pixels)
    bbox = cell.point(lambda value: 255 if value<165 else 0).getbbox()
    return cell.crop(bbox) if bbox else None


def text_line(cell):
    if cell is None:
        return None
    pixels = np.asarray(cell)
    ink = pixels < 155
    # Select the glyph baseline. Residual vertical rules generally contribute
    # only one or two pixels per scanline, even when they span the whole cell.
    weights = ink.sum(1)
    groups = runs(weights >= max(3,min(7,weights.max()*.18)))
    if not groups:
        return cell
    band = max(groups, key=lambda g: weights[g].sum() if len(g)>=3 else 0)
    lo, hi = max(0,band[0]-2), min(len(pixels),band[-1]+3)
    line = pixels[lo:hi].copy()
    for side in (line.T,line.T[::-1]):
        for i in range(min(4,len(side))):
            if (side[i]<160).mean()>.75:
                side[i]=255
    output = Image.fromarray(line)
    box = output.point(lambda p: 255 if p<165 else 0).getbbox()
    return output.crop(box) if box else cell


def numeric_candidates(reader,cell,places):
    line = text_line(cell)
    choices = {}
    trimmed = line
    if line is not None:
        columns = runs((np.asarray(line)<170).any(0))
        # A border at the far left is separated from the right-aligned number
        # by much more white space than a thousands separator.
        for left,right in zip(columns,columns[1:]):
            if right[0]-left[-1]>line.height*.8 and left[-1]<line.width*.5:
                trimmed = line.crop((right[0],0,line.width,line.height))
    for candidate, mode in ((trimmed,7),(trimmed,13),(cell,7),(line,7)):
        raw = reader.read(candidate,True,psm=mode).replace(' ','').replace(',','.')
        if re.fullmatch(r"\d{1,10}(?:\.\d{1,3})?",raw):
            if places == 2 and ('.' not in raw or len(raw.split('.')[1]) != 2):
                continue
            value = Decimal(raw)
            choices[value] = choices.get(value,0) + 1
    return choices


def best_value(choices):
    if not choices:
        return ''
    return format(max(choices,key=choices.get),'f')


def reconcile_row(row, readings):
    # Use arithmetic solely to choose between values actually seen by OCR.
    qtys, prices, nets, taxes, gross = [readings.get(key,{}) for key in
                                       ('qty','netPrice','netSum','vat','gross')]
    votes = {key: values.copy() for key,values in readings.items()}
    for q,p,n in product(qtys,prices,nets):
        if q>0 and abs(q*p-n)<=q*Decimal('.005')+Decimal('.01'):
            for key,value in [('qty',q),('netPrice',p),('netSum',n)]:
                votes[key][value] += 12
    for n,t,g in product(nets,taxes,gross):
        if abs(n+t-g)<=Decimal('.01'):
            for key,value in [('netSum',n),('vat',t),('gross',g)]:
                votes[key][value] += 12
    row.update({key:best_value(values) for key,values in votes.items()})


UNIT_CODES = {'796':'шт','166':'кг','163':'г','112':'л','111':'мл','868':'бут','778':'уп'}


def printed_table(image, reader, deadline, transport=False, previous_rows=()):
    if not .4 <= image.width/image.height <= 3 or min(image.size)<300:
        return None
    page, scale, horizontal, vertical, lines = geometry(image)
    bands = list(zip(lines, lines[1:]))
    for index, (y,z) in enumerate(bands[:-1]):
        if monotonic() > deadline:
            return
        # Narrow numbered band follows a substantially taller column heading.
        if not 6 <= z-y <= 33 or index == 0 or y-lines[index-1] < 40:
            continue
        data_y, data_z = bands[index+1]
        if data_z-data_y < 8:
            continue
        edges = column_edges(vertical, data_y, data_z)
        if len(edges)<12:
            continue
        def crop(left, top, right, bottom):
            return cell_image(page, scale, horizontal, (left, top, right, bottom))
        labels = []
        for a,b in zip(edges,edges[1:]):
            cell = crop(a,y,b,z) if 8 < b-a < 330 else None
            labels.append({reader.read(cell,True), reader.read(text_line(cell),True)})
        # The contiguous numbered fields 3 through 9 identify quantity,
        # net unit price, net amount, excise, VAT rate, VAT and gross.
        scores = [(sum(str(k+3) in labels[j+k] for k in range(7)),j)
                  for j in range(3,len(labels)-6)]
        if not scores:
            continue
        # The gross column is immediately followed by country code (10),
        # country name (10a) and declaration number (11).
        scores = [(s + sum(any(t.startswith(token) for t in labels[j+k]) for k,token in
                   ((-2,'2'),(-1,'2'),(7,'10'),(8,'10'),(9,'11')) if 0<=j+k<len(labels)), j)
                  for s,j in scores]
        score, q = max(scores)
        def heading(j):
            return reader.read(crop(edges[j],lines[index-1],edges[j+1],y),single=False).lower()
        if transport:
            # The 1-T form can subdivide column 9 into several subcolumns.
            # Locate price and amount from their captions independently.
            headers = [heading(j) for j in range(len(labels))]
            price_cols = [j for j,t in enumerate(headers) if 'цена' in t and j>0]
            sum_cols = [j for j,t in enumerate(headers) if 'сумм' in t]
            name_cols = [j for j,t in enumerate(headers) if 'наимен' in t and 'продук' in t]
            if len(price_cols)!=1 or len(sum_cols)!=1 or len(name_cols)!=1:
                continue
            price,name,amount = price_cols[0],name_cols[0],sum_cols[0]
            if not 0<price<name<amount-1:
                continue
            q = price-1
            selected = dict(pos=name,unit=name+1,qty=q,gross=amount)
            unit_index = name+1
        else:
            if score < 4 or sum(s==score for s,j in scores)>1:
                # Recover the start of the money columns by reading captions.
                price_cols = [j for j in range(3,len(labels)-5) if 'цена' in heading(j)]
                if len(price_cols)!=1:
                    price_cols = [j for j in range(3,len(labels)-5)
                                  if '4' in labels[j] and '7' in labels[j+3]
                                  and '8' in labels[j+4]]
                if len(price_cols)!=1:
                    continue
                q = price_cols[0]-1
            first_top,first_bottom = bands[index+1]
            unit_index = q-1
            for j in range(max(0,q-6),q-1):
                code_cell = crop(edges[j],first_top,edges[j+1],first_bottom)
                readings = {reader.read(code_cell,True),reader.read(text_line(code_cell),True)}
                if readings & UNIT_CODES.keys():
                    unit_index=j+1
                    break
            name_candidates = list(range(max(0,unit_index-7),unit_index-1))
            if not name_candidates:
                continue
            name = max(name_candidates,key=lambda j: edges[j+1]-edges[j])
            if unit_index != q-1:
                for j in name_candidates:
                    if 'наимен' in heading(j):
                        name=j
                        break
            selected = dict(pos=name,unit=unit_index,qty=q,netPrice=q+1,netSum=q+2,vat=q+5,gross=q+6)
        result, total = [], ''
        for top,bottom in bands[index+1:]:
            if monotonic() > deadline:
                return
            current = column_edges(vertical,top,bottom)
            def near(target):
                return min(current, key=lambda value: abs(value-target), default=-100)
            # Track the printed vertical rules as a tilted table drifts down the page.
            next_edges = [near(e) if abs(near(e)-e)<10 else e for e in edges]
            anchors = {i+d for i in selected.values() for d in (0,1)}
            item = sum(abs(near(edges[i])-edges[i])<10 for i in anchors) >= len(anchors)-1
            def read_field(key):
                j = selected[key]
                cell = crop(next_edges[j],top,next_edges[j+1],bottom)
                if key in ('pos','unit'):
                    return reader.read(text_line(cell) if key=='unit' else cell, single=key=='unit',
                                       language=b'rus' if key=='unit' else None).strip(' |_')
                return numeric_candidates(reader,cell,3 if key=='qty' else 2)
            if not item or transport:
                label = reader.read(crop(edges[0],top,edges[q],bottom),single=False)
                amounts = read_field('gross')
                seen = [*previous_rows, *result]
                exact = sum((Decimal(r['gross']) for r in seen if r.get('gross')),Decimal(0))
                matches = result and all(r.get('gross') for r in seen) and exact in amounts
                if re.search('всего|итого|оплат',label,re.I) or (matches and (not item or not read_field('pos'))):
                    total=format(exact,'f') if matches else best_value(amounts)
                    break
                if not item:
                    break
            row = {key:read_field(key) for key in ('pos','unit')}
            readings = {key:read_field(key) for key in selected if key not in row}
            if not transport and unit_index+1<q:
                # Only use quantities read from this row that match both the
                # printed net price and net amount. This distinguishes cases,
                # units per case and total pieces.
                by_column = []
                candidates = {}
                for j in range(unit_index+1,q+1):
                    cell = crop(next_edges[j],top,next_edges[j+1],bottom)
                    values = numeric_candidates(reader,cell,3)
                    by_column.append(values)
                    candidates.update(values)
                compatible = {n:w for n,w in candidates.items() if n>0 and any(
                    abs(n*p-net)<=n*Decimal('.005')+Decimal('.01')
                    for p,net in product(readings['netPrice'],readings['netSum']))}
                if len(by_column)==3 and re.search('уп',row['unit'],re.I):
                    per_case, cases, pieces = by_column
                    pack_counts = {v for v in cases if v>0}
                    pack_counts.update(v/1000 for v in cases if v>=1000 and v%1000==0)
                    verified = {v:1 for v in pack_counts if any(
                        size>=1 and size*v in pieces for size in per_case)}
                    if len(verified)==1:
                        compatible = verified
                readings['qty'] = compatible if len(compatible)==1 else {}
            reconcile_row(row,readings)
            if not transport:
                j = selected['unit']-1
                code = reader.read(text_line(crop(next_edges[j],top,next_edges[j+1],bottom)),True)
                row['unit'] = UNIT_CODES.get(code,row['unit'])
            if not any(row.values()):
                break
            for field in ('netPrice','netSum','vat'):
                row.setdefault(field,'')
            row['needsReview'] = True
            result.append(row)
            edges = next_edges
        if result:
            return result,total


def printed_header(image, reader):
    """Read named fields in the upper part of the first page as continuous text."""
    block = ImageOps.grayscale(image.crop((0,0,image.width,round(image.height*.43))))
    block.thumbnail((2300,1200))
    text = reader.read(block,single=False,language=b'rus')
    fields = {}
    quotes = r"""["«“”„`']([^"»“”„`']{2,100})["»“”„`']"""
    for key,label in (('supplier','продавец'),('buyer','покупатель')):
        part = re.search(label+r'\s*[:.]?\s*(.{1,160})',text,re.I)
        if not part:
            continue
        value = re.split(r'\(\d|\b(?:адрес|статус|покупатель|инн)\b',part[1],maxsplit=1,flags=re.I)[0].strip()
        quoted = re.search(quotes,value)
        company = re.search(r'\b(ООО|АО|ПАО|общество)\b',value,re.I)
        if company and quoted:
            prefix = company[1].upper()
            fields[key] = ('ООО' if prefix=='ОБЩЕСТВО' else prefix)+' '+quoted[1].strip()
        elif key=='supplier':
            individual = re.match(r'ИП\s+([А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+)\b',value)
            if individual:
                fields[key]='ИП '+individual[1]
    ids = re.findall(r'(?:сч[её]т[- ]фактура|передаточный документ)\s*[,.:]?\s*№\s*([А-ЯA-Z0-9/-]{2,25})\s+(?:[-—]\s*)?от\b',text,re.I)
    if ids and len(set(ids))==1:
        fields['number']=ids[-1]
    recipient = re.search(r'грузополучатель\s+и\s+его\s+адрес\s*[:.]?\s*(.{1,310})',text,re.I)
    if recipient:
        value = re.split(r'\(4\)|к\s+п[лп]ат|документ об отгрузке|идентификатор',recipient[1],maxsplit=1,flags=re.I)[0]
        # Include a street and a printed building number before proposing a venue.
        address = re.search(r'\b(?:\d{6}\s*[,.]?\s*)?(?:(?:г(?:ород)?\.?\s*)?[А-ЯЁ][а-яё-]+[, .]+)?(?:улица|ул\.)\s*[^,;]{2,45}?,?\s*(?:д(?:ом)?\.?\s*№?\s*)\d+[А-Яа-я]?(?:\s*,?\s*(?:стр(?:оение)?\.?|корп(?:ус)?\.?)\s*\d+[А-Яа-я]?)?',value,re.I)
        if address:
            fields['deliveryAddress']=address[0].strip(' ,.')
    return fields

"""Read-only OCR check of selected invoices from the local DashBar queue."""
import argparse
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ocr import SCAN_FORMATS, RecognitionError, recognize


def check(result):
    missing = [key for key in ('supplier', 'buyer', 'deliveryAddress', 'number', 'date') if not result.get(key)]
    rows = []
    for row in result.get('rows', []):
        line = {key: row.get(key, '') for key in ('pos', 'unit', 'qty', 'gross')}
        try:
            qty, gross = Decimal(line['qty']), Decimal(line['gross'])
            line['unitPrice'] = format(gross / qty, 'f') if qty > 0 and gross > 0 else ''
        except (InvalidOperation, ZeroDivisionError):
            line['unitPrice'] = ''
        rows.append(line)
    try:
        matches = bool(rows) and sum(Decimal(r['gross']) for r in rows) == Decimal(result['total'])
    except (InvalidOperation, KeyError):
        matches = False
    return {'header': {key: result.get(key, '') for key in ('supplier', 'buyer', 'deliveryAddress', 'number', 'date')},
            'missing': missing, 'rows': rows, 'total': result.get('total', ''), 'reconciles': matches,
            'complete': not missing and matches and all(all(r[k] for k in ('pos','unit','qty','gross','unitPrice')) for r in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suppliers', nargs='*', default=['СВАМ', 'ТИКО', 'АСТ', 'КАЗИН'])
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    token = os.environ.get('BM_OPERATOR_TOKEN', '')
    if not token:
        parser.error('В Codespace отсутствует BM_OPERATOR_TOKEN.')
    if not 1 <= args.port <= 65535:
        parser.error('Некорректный порт.')
    base = f'http://127.0.0.1:{args.port}/api/intake'

    def get(path):
        req = Request(base + path, headers={'Authorization': 'Bearer ' + token})
        with urlopen(req, timeout=30) as response:
            return response.read()

    try:
        documents, cursor = [], 0
        while True:
            page = json.loads(get(f'?after_id={cursor}'))
            documents.extend(page['documents'])
            following = page.get('next_cursor')
            if not following or following == cursor:
                break
            cursor = following
        for supplier in args.suppliers:
            candidates = [d for d in documents if supplier.casefold() in d['name'].casefold() and Path(d['name']).suffix.lower() in SCAN_FORMATS]
            if not candidates:
                print(json.dumps({'supplier': supplier, 'status': 'not_in_queue'}, ensure_ascii=False), flush=True)
                continue
            doc = candidates[0]
            print(f"Проверяем: {doc['name']}", flush=True)
            try:
                result = recognize(doc['name'], get(f'/documents/{int(doc["id"])}'))
                print(json.dumps({'file': doc['name'], **check(result)}, ensure_ascii=False, indent=2), flush=True)
            except RecognitionError as error:
                print(json.dumps({'file': doc['name'], 'error': str(error)}, ensure_ascii=False), flush=True)
    except (HTTPError, URLError, OSError) as error:
        parser.exit(1, f'Не удалось прочитать локальную очередь: {error}\n')


if __name__ == '__main__':
    main()

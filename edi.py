"""Convert supported sellers' UTD XML into an editable receiving draft."""
from datetime import datetime
from decimal import Decimal, InvalidOperation
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

MAX_XML = 5 * 1024 * 1024
MAX_LINES = 5000
UNIT_NAMES = {"796": "шт", "166": "кг", "112": "л", "163": "г"}


class EdiError(ValueError):
    pass


def child(parent, name):
    return next((node for node in parent if node.tag == name), None) if parent is not None else None


def field(node, key):
    return (node.get(key, "") if node is not None else "").strip()


def decimal_string(value):
    if not value or len(value) > 30:
        return ""
    try:
        n = Decimal(value.replace(",", "."))
    except InvalidOperation:
        return ""
    return format(n, "f") if n.is_finite() and 0 <= n < Decimal("1e15") and n.as_tuple().exponent >= -8 else ""


def seller_data(invoice):
    identity = child(child(invoice, "СвПрод"), "ИдСв")
    if identity is None:
        return "", ""
    company = child(identity, "СвЮЛУч")
    individual = child(identity, "СвИП")
    if company is not None:
        return field(company, "НаимОрг"), field(company, "ИННЮЛ")
    if individual is not None:
        fio = child(individual, "ФИО")
        name = " ".join(field(fio, key) for key in ("Фамилия", "Имя", "Отчество")).strip()
        return ("ИП " + name if name else ""), field(individual, "ИННФЛ")
    return "", ""


def parse_edi(data):
    if len(data) > MAX_XML:
        raise EdiError("XML больше 5 МБ.")
    try:
        root = ElementTree.fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except (ElementTree.ParseError, DefusedXmlException, LookupError) as error:
        raise EdiError("Не удалось прочитать XML УПД.") from error
    for node in root.iter():
        node.tag = node.tag.rsplit("}", 1)[-1]
    documents = [node for node in root if node.tag == "Документ"]
    if len(documents) != 1:
        raise EdiError("Загрузите оригинальный XML с одним УПД продавца.")
    doc = documents[0]
    if field(doc, "Функция") not in {"СЧФДОП", "ДОП"}:
        raise EdiError("Для прихода нужен УПД с передачей товара.")
    invoice = child(doc, "СвСчФакт")
    if child(invoice, "ИспрСчФ") is not None:
        raise EdiError("Исправленные УПД требуют отдельной сверки. Исходный приход менять нельзя.")
    number = field(invoice, "НомерДок") or field(invoice, "НомерСчФ")
    raw_date = field(invoice, "ДатаДок") or field(invoice, "ДатаСчФ")
    try:
        date = datetime.strptime(raw_date, "%d.%m.%Y").date().isoformat()
    except ValueError as error:
        raise EdiError("В УПД отсутствует корректная дата.") from error
    supplier, supplier_inn = seller_data(invoice)
    currency = field(child(invoice, "ДенИзм"), "КодОКВ") or field(invoice, "КодОКВ")
    if currency != "643":
        raise EdiError("Поддерживается УПД в российских рублях с кодом валюты 643.")
    table = child(doc, "ТаблСчФакт")
    entries = [node for node in table if node.tag == "СведТов"] if table is not None else []
    if not 1 <= len(entries) <= MAX_LINES:
        raise EdiError("В УПД должно быть от 1 до 5000 строк товаров.")
    rows = []
    for node in entries:
        tax_node = child(node, "СумНал")
        vat_node = child(tax_node, "СумНал")
        vat = decimal_string(vat_node.text.strip()) if vat_node is not None and vat_node.text else ""
        rate = field(node, "НалСт").casefold()
        if not vat and (child(tax_node, "БезНДС") is not None or rate in {"без ндс", "безндс", "0%"}):
            vat = "0"
        unit = field(node, "НаимЕдИзм") or UNIT_NAMES.get(field(node, "ОКЕИ_Тов"), "")
        rows.append({"pos": field(node, "НаимТов"), "unit": unit, "qty": decimal_string(field(node, "КолТов")),
                     "netPrice": decimal_string(field(node, "ЦенаТов")),
                     "netSum": decimal_string(field(node, "СтТовБезНДС")),
                     "gross": decimal_string(field(node, "СтТовУчНал")), "vat": vat})
    return {"mode": "edi-xml", "supplier": supplier, "supplierInn": supplier_inn, "number": number, "date": date,
            "total": decimal_string(field(child(table, "ВсегоОпл"), "СтТовУчНалВсего")), "rows": rows}

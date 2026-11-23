import unittest

from edi import EdiError, parse_edi


TEST_INVOICE = """<Файл>
  <Документ Функция="ДОП">
    <СвСчФакт НомерДок="TEST-1" ДатаДок="21.11.2026" КодОКВ="643">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="Тестовый поставщик"/></ИдСв></СвПрод>
    <СвПокуп><ИдСв><СвЮЛУч НаимОрг="Тестовый покупатель"/></ИдСв></СвПокуп>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НаимТов="Сироп" КолТов="2" ЦенаТов="150"
        ОКЕИ_Тов="796" СтТовБезНДС="300" СтТовУчНал="300" НалСт="без НДС"/>
      <ВсегоОпл СтТовУчНалВсего="300"/>
    </ТаблСчФакт>
  </Документ>
</Файл>"""


class EdiDraftTest(unittest.TestCase):
    def test_seller_invoice_maps_to_draft(self):
        draft = parse_edi(TEST_INVOICE.encode())
        self.assertEqual(draft["number"], "TEST-1")
        self.assertEqual(draft["date"], "2026-11-21")
        self.assertEqual(draft["supplier"], "Тестовый поставщик")
        self.assertEqual(draft["total"], "300")
        self.assertEqual(draft["buyer"], "Тестовый покупатель")
        self.assertEqual(
            draft["rows"],
            [{"pos": "Сироп", "unit": "шт", "qty": "2", "netPrice": "150",
              "netSum": "300", "gross": "300", "vat": "0"}],
        )

    def test_unsupported_currency_is_rejected(self):
        foreign_invoice = TEST_INVOICE.replace('КодОКВ="643"', 'КодОКВ="840"')
        with self.assertRaisesRegex(EdiError, "643"):
            parse_edi(foreign_invoice.encode())


if __name__ == "__main__":
    unittest.main()

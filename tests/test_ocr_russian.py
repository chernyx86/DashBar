import io
import shutil
import unittest
from decimal import Decimal

from PIL import Image, ImageDraw, ImageFont

from ocr import recognize, expanded_grid, resolve_grid_document, valid_inn, invoice_fields


class ExpandedGridTest(unittest.TestCase):
    def test_numbered_header_and_item_boundaries(self):
        image=Image.new('RGB',(900,1200),'white')
        draw=ImageDraw.Draw(image)
        for y in (250,305,315,348,381,414,447,460):
            draw.line((44,y,845,y),fill='black',width=2)
        for x in (44,115,135,282,306,328,363,408,430,457,510,563,598,621,671,727,780,845):
            draw.line((x,315,x,447),fill='black',width=2)
        words=[(183,275,12,'Наименование'),(406,265,12,'Количество'),(468,270,12,'Цена'),(140,453,10,'Всего')]
        result=expanded_grid(image,words)
        self.assertIsNotNone(result)
        self.assertEqual(len(result[3]),5)
        self.assertEqual(len(result[5]),7)

    def test_standard_grid_with_one_item_and_split_quantity_label(self):
        image=Image.new('RGB',(900,1260),'white')
        draw=ImageDraw.Draw(image)
        for y in (350,466,480,506,520,534):
            draw.line((45,y,835,y),fill='black',width=2)
        for x in (45,75,99,222,260,285,329,369,423,490,520,564,618,680,750,835):
            draw.line((x,480,x,506),fill='black',width=2)
        words=[(139,380,12,'Наименование'),(348,390,12,'Коли-'),(348,402,12,'чество'),(395,375,12,'Цена'),(100,513,10,'Всего')]
        result=expanded_grid(image,words)
        self.assertIsNotNone(result)
        self.assertEqual(len(result[3]),2)
        self.assertEqual(len(result[5]),7)

    def test_alphanumeric_document_number_on_next_line(self):
        image=Image.new('RGB',(900,1260),'white')
        words=[(135,65,12,'Счет-фактура'),(210,88,12,'АБ000123'),(260,88,12,'от'),
               (290,88,12,'07'),(320,88,12,'ноября'),(360,88,12,'2026')]
        result=invoice_fields(image,words)
        self.assertEqual(result['number'],'АБ000123')
        self.assertEqual(result['date'],'2026-11-07')

    @staticmethod
    def row(unit,*values):
        return {'unit':unit,'candidates':[[Decimal(v) for v in group] for group in values]}

    def test_document_total_resolves_only_consistent_rows(self):
        a=self.row('бут',['3'],['100'],['300'],['60'],['360'])
        b=self.row('бут',['2'],['50'],['100'],[],['120','130'])
        resolved=resolve_grid_document([a,b],'480','400')
        self.assertEqual(resolved[1][0],tuple(map(Decimal,['2','50','100','20','120'])))
        self.assertEqual(resolved[1][1],('vat',))
        self.assertIsNone(resolve_grid_document([a,b],'481','400'))

    def test_ambiguous_quantity_is_not_silently_selected(self):
        row=self.row('бут',['2','4'],[],['100'],['20'],['120'])
        self.assertIsNone(resolve_grid_document([row],'120','100'))

    def test_invalid_inn_is_rejected(self):
        self.assertTrue(valid_inn('7707083893'))
        self.assertFalse(valid_inn('7707083894'))


@unittest.skipUnless(shutil.which("tesseract"), "Требуется Tesseract")
class RussianInvoiceTest(unittest.TestCase):
    def sample(self):
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 31)
        except OSError:
            self.skipTest("Для тестовой накладной нужен шрифт DejaVu Sans")
        width = 1600
        image = Image.new("RGB", (width, 1100), "white")
        draw = ImageDraw.Draw(image)

        def label(fraction, y, text):
            draw.text((fraction * width, y), text, fill="black", font=font, anchor="mm")

        label(.081, 100, "Накладная")
        draw.text((250, 100), "№ 48151 от 21.11.2026", fill="black", font=font, anchor="lm")
        label(.072, 180, "Продавец")
        label(.28, 186, "ООО Северный Бар")
        label(.57, 180, "Покупатель:")
        label(.75, 170, 'ООО «Южный Бар»')
        label(.14, 385, "Наименование")
        label(.38, 385, "Цена")
        rows = [(516, "Сироп", 2, 120, 240, 48, 288), (630, "Тоник", 3, 100, 300, 60, 360)]
        for y, item, qty, price, net, vat, gross in rows:
            values = (item, "шт", qty, price, net, vat, gross)
            for fraction, value in zip((.14, .29, .35, .416, .480, .60, .677), values):
                label(fraction, y, str(value))
        label(.15, 767, "Всего")
        label(.677, 767, "648")
        return image

    def check_invoice(self, image, extension, kind):
        with io.BytesIO() as data:
            image.save(data, format=kind, resolution=150)
            result = recognize(f"test.{extension}", data.getvalue())
        self.assertEqual(result["supplier"], "ООО Северный Бар")
        self.assertEqual(result["buyer"], "ООО Южный Бар")
        self.assertEqual(result["date"], "2026-11-21")
        self.assertEqual(result["number"], "48151")
        self.assertEqual(result["total"], "648")
        self.assertEqual(
            [(row["pos"], row["qty"], row["gross"], row["needsReview"]) for row in result["rows"]],
            [("Сироп", "2", "288", False), ("Тоник", "3", "360", False)],
        )

    def test_png_and_rotated_jpeg(self):
        image = self.sample()
        self.check_invoice(image, "png", "PNG")
        self.check_invoice(image.rotate(90, expand=True), "jpg", "JPEG")

    @unittest.skipUnless(shutil.which("pdfinfo") and shutil.which("pdftoppm"), "Требуется Poppler")
    def test_pdf_scan(self):
        self.check_invoice(self.sample(), "pdf", "PDF")

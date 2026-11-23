import io
import shutil
import unittest

from PIL import Image, ImageDraw, ImageFont

from ocr import recognize


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

import json
import unittest

import httpx

from invoice_vision import VisionError, needs_visual, read_visual_invoice, verified_draft


def invoice():
    return dict(supplier="ООО Тест", supplierInn="", buyer="ООО Бар", deliveryAddress="Петровка, 26",
                number="1", date="2026-11-16", total="110.00",
                rows=[dict(pos="Напиток 0,25 л × 4", unit="шт", qty="2",
                           netPrice="50", netSum="100", vat="10", gross="110")])


class InvoiceVisionTest(unittest.IsolatedAsyncioTestCase):
    async def test_multimodal_request_and_checked_draft(self):
        def respond(request):
            payload = json.loads(request.content)
            self.assertFalse(payload["store"])
            self.assertEqual(len(payload["input"][0]["content"]), 3)
            self.assertEqual(payload["input"][0]["content"][1]["image_url"],
                             "data:image/jpeg;base64,one")
            self.assertTrue(payload["text"]["format"]["strict"])
            return httpx.Response(200, json={"status": "completed", "output": [
                {"type": "message", "content": [{"type": "output_text", "text": json.dumps(invoice())}]},
            ]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await read_visual_invoice(client, "test", "test", ["one", "two"])
        self.assertEqual(result["mode"], "visual-ocr")
        self.assertEqual(result["total"], "110.00")
        self.assertTrue(result["rows"][0]["needsReview"])

    def test_document_and_row_arithmetic_are_separate(self):
        broken = invoice()
        broken["rows"][0]["vat"] = "1"
        with self.assertRaises(VisionError):
            verified_draft(broken, [])
        broken = invoice()
        broken["total"] = "111"
        with self.assertRaises(VisionError):
            verified_draft(broken, [])

    def test_visual_is_a_fallback_for_incomplete_drafts(self):
        current = invoice()
        self.assertFalse(needs_visual(current))
        current["deliveryAddress"] = ""
        self.assertTrue(needs_visual(current))
        current["documentWarning"] = "ТТН"
        self.assertFalse(needs_visual(current))

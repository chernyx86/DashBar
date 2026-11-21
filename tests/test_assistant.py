import json
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import OPENAI_RESPONSES, app


QUESTION = {
    "question": "Что проверить по остаткам?",
    "context": {
        "invoices": 1, "price_items": 2, "stock_items": 3, "counts": 4, "sales_rows": 5,
    },
}
AUTH = {"Authorization": "Bearer " + "o" * 32}


class AssistantTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {
            "BM_DB": str(Path(directory) / "test.sqlite3"),
            "BM_OPERATOR_TOKEN": "o" * 32,
            "BM_PUSH_TOKEN": "",
            "BM_ENCRYPTION_KEY": Fernet.generate_key().decode(),
            "BM_AI_OPENAI_KEY": "",
            "BM_AI_OPENAI_MODEL": "",
        }))
        for key in tuple(os.environ):
            if key.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
                os.environ.pop(key)
        self.client = self.enterContext(TestClient(app))

    def test_operator_access_and_missing_provider(self):
        self.assertEqual(self.client.post("/api/intake/assistant", json=QUESTION).status_code, 401)
        self.assertFalse(self.client.get("/api/intake", headers=AUTH).json()["assistant_available"])
        self.assertEqual(
            self.client.post("/api/intake/assistant", json=QUESTION, headers=AUTH).status_code, 503
        )

    def test_request_contract_limits_audit_and_upstream_error(self):
        app.state.ai_key = "mock-api-key"
        app.state.ai_model = "mock-model"
        self.assertTrue(self.client.get("/api/intake", headers=AUTH).json()["assistant_available"])
        ok = httpx.Response(200, request=httpx.Request("POST", OPENAI_RESPONSES), json={
            "status": "completed", "output": [
                {"type": "reasoning", "content": []},
                {"type": "message", "content": [{"type": "output_text", "text": "Сверьте остатки."}]},
            ],
        })
        with patch.object(app.state.client, "post", new_callable=AsyncMock) as upstream:
            extra = {**QUESTION, "context": {**QUESTION["context"], "raw_invoice": "private"}}
            self.assertEqual(self.client.post("/api/intake/assistant", json=extra, headers=AUTH).status_code, 422)
            upstream.assert_not_awaited()
            upstream.return_value = ok
            reply = self.client.post("/api/intake/assistant", json=QUESTION, headers=AUTH)
            self.assertEqual(reply.json(), {"answer": "Сверьте остатки."})
            args, kwargs = upstream.await_args
            self.assertEqual(args, (OPENAI_RESPONSES,))
            self.assertEqual(kwargs["headers"], {"Authorization": "Bearer mock-api-key"})
            self.assertEqual(json.loads(kwargs["json"]["input"]), QUESTION)
            self.assertFalse(kwargs["json"]["store"])
            self.assertFalse(kwargs["follow_redirects"])
            upstream.side_effect = httpx.ConnectError("upstream internal error")
            failed = self.client.post("/api/intake/assistant", json=QUESTION, headers=AUTH)
            self.assertEqual(failed.status_code, 502)
            self.assertNotIn("upstream internal error", failed.text)
        with closing(app.state.store.connect()) as db:
            rows = db.execute("SELECT action,target FROM audit").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("assistant_requested", "openai")] * 2)

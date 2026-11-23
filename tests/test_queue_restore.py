import os
import secrets
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet, InvalidToken
from fastapi.testclient import TestClient

from app import Store, app


class QueueRestoreTest(unittest.TestCase):
    def test_restored_queue_is_readable_through_api(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder) / "current.db"
            restored = Path(folder) / "restored.db"
            key = Fernet.generate_key()
            cipher = Fernet(key)
            store = Store(original, cipher)
            payload = "Позиция;Количество\nТоник;2".encode()
            store.put("drive", "visible", "pending.csv", payload)
            store.put("drive", "reviewed", "reviewed.csv", payload + b"\n")
            store.reviewed(2)
            store.set_setting("restore_test", {"enabled": True}, audit=True)
            with closing(store.connect()) as source, closing(sqlite3.connect(restored)) as target:
                source.backup(target)

            operator = secrets.token_urlsafe(32)
            with patch.dict(os.environ, {"BM_DB": str(restored), "BM_ENCRYPTION_KEY": key.decode(),
                "BM_OPERATOR_TOKEN": operator, "BM_PUSH_TOKEN": "", "BM_AI_OPENAI_KEY": ""}):
                for name in tuple(os.environ):
                    if name.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
                        del os.environ[name]
                with TestClient(app) as client:
                    headers = {"Authorization": "Bearer " + operator}
                    self.assertEqual([row["id"] for row in client.get("/api/intake", headers=headers).json()["documents"]], [1])
                    response = client.get("/api/intake/documents/1", headers=headers)
                    self.assertEqual(response.content, payload)
                    self.assertEqual(client.get("/api/intake").status_code, 401)

            recovered = Store(restored, cipher)
            self.assertEqual(recovered.setting("restore_test"), {"enabled": True})
            self.assertFalse(recovered.put("drive", "visible", "repeat.csv", b"different"))
            with self.assertRaises(InvalidToken):
                Store(restored, Fernet(Fernet.generate_key())).download(1)

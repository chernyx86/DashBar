import asyncio
import importlib.util
import os
import secrets
import sys
import tempfile
from pathlib import Path

import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location("dashbar_server", root / "app.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
for key in list(os.environ):
    if key.lower() in {"http_proxy","https_proxy","all_proxy"}:
        os.environ.pop(key)
os.environ["BM_OPERATOR_TOKEN"] = secrets.token_urlsafe(32)
os.environ["BM_PUSH_TOKEN"] = secrets.token_urlsafe(32)
os.environ["BM_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
def auth(name):
    return {"Authorization": "Bearer " + os.environ[name]}
operator = auth("BM_OPERATOR_TOKEN")
push = auth("BM_PUSH_TOKEN")
requests = []
def remote(req):
    requests.append(req)
    if req.url.host == "sheets.googleapis.com":
        assert req.headers.get("Authorization") == "Bearer mocked"
        if req.url.path.endswith("/spreadsheets/testDoc123"):
            return httpx.Response(200,json={"properties":{"title":"Бар"},"sheets":[
              {"properties":{"sheetId":1,"title":"Лист 1","index":0}},
              {"properties":{"sheetId":22,"title":"Фрукты '2026'","index":1}}]})
        assert req.url.path.endswith("/values/'Фрукты ''2026'''")
        return httpx.Response(200,json={"values":[["Позиция","Цена","Единица","Поставщик"],["Лимон","198,00","кг","Фрукты"]]})
    if req.url.path.endswith("/files"):
        assert "'testFolder123' in parents" in req.url.params["q"]
        return httpx.Response(200,json={"files":[{"id":"testFile123","name":"invoice.csv","modifiedTime":"2026-11-20T20:00:00Z"}]})
    if req.url.path.endswith("/files/testFile123"):
        return httpx.Response(200, content="Позиция;Количество;Цена\nЛимон;2;198".encode())
    raise AssertionError(str(req.url))
mod.drive_auth = lambda: ({"Authorization": "Bearer mocked"}, {})
with tempfile.TemporaryDirectory(dir=".") as tmp:
    os.environ["BM_DB"] = str(Path(tmp) / "queue.sqlite3")
    with TestClient(mod.app) as c:
        mock = httpx.AsyncClient(transport=httpx.MockTransport(remote))
        mod.app.state.client = mock
        assert "./modules/receiving.js" in c.get("/").text
        assert "Источники и загрузка по ссылке" in c.get("/modules/receiving.js").text
        assert c.get("/api/intake",headers=push).status_code == 401
        assert c.post("/api/intake/sheets",json={"link":"https://attacker.invalid/test"},headers=operator).status_code == 422
        url="https://docs.google.com/spreadsheets/d/testDoc123/edit#gid=22"
        assert c.post("/api/intake/sheets",json={"link":url.replace("=22","=999")},headers=operator).status_code == 422
        for accepted in (True,False):
            r=c.post("/api/intake/sheets",json={"link":url},headers=operator)
            assert r.json() == {"accepted":accepted},r.text
        csv_bytes=c.get("/api/intake/documents/1",headers=operator).content
        assert "Лимон;198,00;кг;Фрукты" in csv_bytes.decode()
        assert c.put("/api/intake/drive",headers=operator,json={"link":"https://drive.google.com/drive/folders/testFolder123","since":"2026-11-01","recursive":False}).status_code == 200
        c.post("/api/intake/sync",headers=operator).raise_for_status()
        c.post("/api/intake/sync",headers=operator).raise_for_status()
        assert c.post("/api/intake/incoming?filename=external.tsv",headers=push,content=b"source").json()=={"accepted":True}
        assert c.post("/api/intake/incoming?filename=external.tsv",headers=operator,content=b"source").status_code==401
        rows=c.get("/api/intake",headers=operator).json()["documents"]
        assert [r["source"] for r in rows]==["sheets","drive","external"]
        c.post("/api/intake/documents/1/reviewed",headers=operator).raise_for_status()
        assert len(c.get("/api/intake",headers=operator).json()["documents"])==2
        from time import perf_counter
        start = perf_counter()
        existing = {row["id"] for row in c.get("/api/intake", headers=operator).json()["documents"]}
        for number in range(260):
            name=f"stress-{number}.csv"
            body=("Позиция;Количество;Цена;Номер накладной\n"+"".join(f"Позиция {i};1;100;{number}\n" for i in range(50))).encode()
            assert c.post("/api/intake/incoming",params={"filename":name},headers=push,content=body).json()=={"accepted":True}
        assert c.post("/api/intake/incoming",params={"filename":"duplicate.csv"},headers=push,content=body).json()=={"accepted":False}
        first=c.get("/api/intake",headers=operator).json()
        assert len(first["documents"])==250
        assert first["next_cursor"]==first["documents"][-1]["id"]
        assert c.get("/api/intake?after_id=-1",headers=operator).status_code==422
        c.post(f"/api/intake/documents/{first['next_cursor']}/reviewed",headers=operator).raise_for_status()
        second=c.get("/api/intake",params={"after_id":first["next_cursor"]},headers=operator).json()
        assert second["next_cursor"] is None
        seen=[row["id"] for row in [*first["documents"],*second["documents"]]]
        assert len(seen)==len(set(seen))==262
        assert len(set(seen)-existing)==260
        assert c.get(f"/api/intake/documents/{seen[-1]}",headers=operator).content==body
        print(f"PASS: 260 uploaded files × 50 rows; 250 + 12 queue items across two pages, including 2 prior fixtures ({perf_counter()-start:.2f} s)")
    asyncio.run(mock.aclose())
print("PASS: authenticated queue, Google Sheets gid, invalid links, Drive folder sync, inbound API, duplicate and reviewed handling")

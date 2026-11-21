"""Single-venue intake service for the BarManager browser prototype."""

import asyncio
import csv
import io
import hashlib
import hmac
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager, closing
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from cryptography.fernet import Fernet
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr

from edi import EdiError, parse_edi
from ocr import IMAGE_FORMATS, RecognitionError, recognize

HTML = Path(__file__).with_name("index.html")
FORMATS = {".pdf", ".xlsx", ".xls", ".csv", ".tsv", ".txt", ".xml"} | IMAGE_FORMATS
MAX_BYTES = 20 * 1024 * 1024
DRIVE = "https://www.googleapis.com/drive/v3"
SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
IIKO = "https://api-ru.iiko.services"
TELEGRAM = "https://api.telegram.org"
DRIVE_ID = re.compile(r"^[A-Za-z0-9_-]{8,200}$")


class RemoteError(Exception):
    pass


class Store:
    def __init__(self, path, cipher):
        self.path, self.cipher = Path(path), cipher
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.touch(mode=0o600, exist_ok=True)
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY, value BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY, digest TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL, source TEXT NOT NULL, data BLOB NOT NULL,
                    reviewed INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
                );
                CREATE TABLE IF NOT EXISTS seen (
                    source TEXT NOT NULL, external_id TEXT NOT NULL,
                    PRIMARY KEY (source, external_id)
                );
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
                );
            """)

    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def setting(self, key, default=None):
        with closing(self.connect()) as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(self.cipher.decrypt(row["value"])) if row else default

    def set_setting(self, key, value, audit=False):
        with closing(self.connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)",
                       (key, self.cipher.encrypt(json.dumps(value).encode())))
            if audit:
                db.execute("INSERT INTO audit(action,target) VALUES (?,?)", ("configure", key))

    def has_seen(self, source, external_id):
        with closing(self.connect()) as db:
            return db.execute("SELECT 1 FROM seen WHERE source=? AND external_id=?",
                              (source, external_id)).fetchone() is not None

    def put(self, source, external_id, name, data):
        name = clean_filename(name)
        if not data or len(data) > MAX_BYTES:
            raise ValueError("Допустимы файлы до 20 МБ.")
        digest = hashlib.sha256(data).hexdigest()
        protected_name = self.cipher.encrypt(name.encode())
        with closing(self.connect()) as db, db:
            if external_id and db.execute("SELECT 1 FROM seen WHERE source=? AND external_id=?",
                                          (source, external_id)).fetchone():
                return False
            inserted = db.execute(
                "INSERT OR IGNORE INTO documents(digest,name,source,data) VALUES (?,?,?,?)",
                (digest, protected_name, source, self.cipher.encrypt(data))
            ).rowcount > 0
            if external_id:
                db.execute("INSERT OR IGNORE INTO seen VALUES (?,?)", (source, external_id))
            if inserted:
                db.execute("INSERT INTO audit(action,target) VALUES (?,?)", ("received", digest))
            return inserted

    def list(self, after_id=0):
        page_size = 250
        with closing(self.connect()) as db:
            rows = db.execute(
                """SELECT id,name,source,created_at FROM documents
                   WHERE reviewed=0 AND id>? ORDER BY id LIMIT ?""",
                (after_id, page_size + 1),
            ).fetchall()
        visible = rows[:page_size]
        documents = [{**dict(row), "name": self.cipher.decrypt(row["name"]).decode()} for row in visible]
        return documents, visible[-1]["id"] if len(rows) > page_size else None

    def download(self, ident):
        with closing(self.connect()) as db:
            row = db.execute("SELECT name,data FROM documents WHERE id=?", (ident,)).fetchone()
        if not row:
            raise HTTPException(404, "Файл не найден.")
        return self.cipher.decrypt(row["name"]).decode(), self.cipher.decrypt(row["data"])

    def reviewed(self, ident):
        with closing(self.connect()) as db, db:
            changed = db.execute("UPDATE documents SET reviewed=1 WHERE id=? AND reviewed=0", (ident,)).rowcount
            if changed:
                db.execute("INSERT INTO audit(action,target) VALUES (?,?)", ("reviewed", str(ident)))


def clean_filename(name):
    name = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or len(name) > 240 or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError("Недопустимое имя файла.")
    if Path(name).suffix.lower() not in FORMATS:
        raise ValueError("Поддерживаются PDF, Excel, CSV, TSV, TXT, XML, JPG, PNG и WEBP.")
    return name


def parse_drive_folder(link):
    try:
        url = urlsplit(link)
        valid = url.scheme == "https" and url.netloc == "drive.google.com"
        match = re.fullmatch(r"/drive/(?:u/\d+/)?folders/([^/]+)/?", url.path)
        key = parse_qs(url.query).get("resourcekey", [""])[0]
        if valid and match and DRIVE_ID.fullmatch(match[1]) and (not key or DRIVE_ID.fullmatch(key)):
            return match[1], key
    except ValueError:
        pass
    raise ValueError("Нужна ссылка вида https://drive.google.com/drive/folders/…")


def parse_sheet_link(link):
    try:
        url = urlsplit(link)
        match = re.fullmatch(r"/spreadsheets/(?:u/\d+/)?d/([^/]+)(?:/edit|/view|/preview)?/?", url.path)
        params = parse_qs(url.query)
        gid = parse_qs(url.fragment).get("gid", params.get("gid", [""]))[0]
        key = params.get("resourcekey", [""])[0]
        if (url.scheme == "https" and url.netloc == "docs.google.com" and match
                and DRIVE_ID.fullmatch(match[1]) and (not key or DRIVE_ID.fullmatch(key))
                and (not gid or re.fullmatch(r"[0-9]{1,10}", gid))):
            return match[1], int(gid) if gid else None, key
    except ValueError:
        pass
    raise ValueError("Укажите ссылку Google Таблиц вида https://docs.google.com/spreadsheets/d/…/edit.")


def sheet_url(sheet_id):
    return f"{SHEETS}/{sheet_id}"


async def queue_sheet(store, client, link):
    sheet_id, gid, resource_key = parse_sheet_link(link)
    headers, params = await asyncio.to_thread(drive_auth)
    if resource_key:
        headers["X-Goog-Drive-Resource-Keys"] = f"{sheet_id}/{resource_key}"
    url = sheet_url(sheet_id)
    meta = await remote_json(client, "GET", url, "Google Таблицы", headers=headers,
                             params={**params, "fields": "properties(title),sheets(properties(sheetId,title,index))"})
    sheets = [item["properties"] for item in meta.get("sheets", []) if "properties" in item]
    if not sheets:
        raise ValueError("В Google Таблице нет доступных листов.")
    target = (min(sheets, key=lambda item: item.get("index", 0)) if gid is None else
              next((item for item in sheets if item.get("sheetId") == gid), None))
    if not target:
        raise ValueError("Лист из ссылки не найден. Откройте нужный лист и скопируйте его ссылку.")
    title = target["title"]
    cell_range = quote("'" + title.replace("'", "''") + "'", safe="")
    payload = await remote_file(client, url + "/values/" + cell_range, "Google Таблицы",
                                params={**params, "valueRenderOption": "FORMATTED_VALUE"}, headers=headers)
    try:
        values = json.loads(payload).get("values", [])
    except (ValueError, AttributeError) as error:
        raise RemoteError("Google Таблицы: не удалось прочитать ответ API.") from error
    if not values:
        raise ValueError("Выбранный лист пуст.")
    csv_file = io.StringIO(newline="")
    csv.writer(csv_file, delimiter=";").writerows(values)
    name = re.sub(r"[\x00-\x1f\x7f/\\]", " ", f"{meta.get('properties', {}).get('title', 'Таблица')} · {title}")
    return store.put("sheets", None, name[:225].strip() + ".csv", csv_file.getvalue().encode("utf-8"))


async def remote_json(client, method, url, service, **kwargs):
    try:
        response = await client.request(method, url, **kwargs)
        if response.is_error:
            raise RemoteError(f"{service}: HTTP {response.status_code}.")
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise RemoteError(f"{service}: запрос не выполнен или ответ не читается.") from error


async def remote_file(client, url, service, **kwargs):
    try:
        async with client.stream("GET", url, **kwargs) as response:
            if response.is_error:
                raise RemoteError(f"{service}: файл недоступен, HTTP {response.status_code}.")
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise ValueError("Файл превышает лимит 20 МБ.")
            return bytes(data)
    except httpx.HTTPError as error:
        raise RemoteError(f"{service}: не удалось скачать файл.") from error


def drive_auth():
    account = os.getenv("BM_DRIVE_SERVICE_ACCOUNT")
    if account:
        try:
            from google.auth.transport.requests import Request as GoogleRequest
            from google.oauth2 import service_account
            credentials = service_account.Credentials.from_service_account_file(
                account, scopes=["https://www.googleapis.com/auth/drive.readonly"]
            )
            credentials.refresh(GoogleRequest())
            return {"Authorization": "Bearer " + credentials.token}, {}
        except Exception as error:
            raise RemoteError("Google Drive: не удалось авторизовать сервисный аккаунт.") from error
    key = os.getenv("BM_DRIVE_API_KEY")
    if key:
        return {}, {"key": key}
    raise RemoteError("Google Drive: настройте сервисный аккаунт или ключ API для общей папки.")


async def sync_drive(store, client, config):
    headers, params = await asyncio.to_thread(drive_auth)
    pending = [(config["folder"], config["resource"])]
    visited = set()
    count, failed = 0, 0
    while pending:
        folder, key = pending.pop()
        if folder in visited:
            continue
        visited.add(folder)
        query = {**params, "q": f"'{folder}' in parents and trashed = false",
                 "supportsAllDrives": "true", "includeItemsFromAllDrives": "true", "pageSize": 1000,
                 "fields": "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,resourceKey)"}
        request_headers = {**headers, **({"X-Goog-Drive-Resource-Keys": f"{folder}/{key}"} if key else {})}
        while True:
            page = await remote_json(client, "GET", DRIVE + "/files", "Google Drive",
                                     params=query, headers=request_headers)
            for record in page.get("files", []):
                file_id, file_key = record.get("id", ""), record.get("resourceKey", "")
                if not DRIVE_ID.fullmatch(file_id) or (file_key and not DRIVE_ID.fullmatch(file_key)):
                    continue
                if record.get("mimeType") == "application/vnd.google-apps.folder":
                    if config["recursive"]:
                        pending.append((file_id, file_key))
                    continue
                try:
                    name = clean_filename(record.get("name"))
                except ValueError:
                    continue
                stamp = record.get("modifiedTime") or record.get("createdTime") or ""
                if stamp[:10] < config["since"] or int(record.get("size") or 0) > MAX_BYTES:
                    continue
                revision = file_id + ":" + stamp
                if store.has_seen("drive", revision):
                    continue
                file_headers = dict(headers)
                if file_key:
                    file_headers["X-Goog-Drive-Resource-Keys"] = f"{file_id}/{file_key}"
                try:
                    data = await remote_file(client, f"{DRIVE}/files/{file_id}", "Google Drive",
                                             params={**params, "alt": "media", "supportsAllDrives": "true"},
                                             headers=file_headers)
                    count += store.put("drive", revision, name, data)
                except (ValueError, RemoteError):
                    failed += 1
            if not page.get("nextPageToken"):
                break
            query["pageToken"] = page["nextPageToken"]
    return f"Добавлено: {count}." + (f" Ошибок скачивания: {failed}. Файлы будут проверены снова." if failed else "")


async def telegram_call(client, token, method, body):
    result = await remote_json(client, "POST", f"{TELEGRAM}/bot{token}/{method}", "Telegram", json=body)
    if not result.get("ok"):
        raise RemoteError("Telegram: запрос отклонён.")
    return result.get("result")


async def sync_telegram(store, client, config):
    token, chat = config["token"], config["chat"]
    offset_key = "telegram_offset:" + hashlib.sha256(token.encode()).hexdigest()
    offset = store.setting(offset_key, 0)
    updates = await telegram_call(client, token, "getUpdates",
                                  {"offset": offset, "limit": 100, "timeout": 1,
                                   "allowed_updates": ["message", "channel_post"]})
    count, skipped = 0, 0
    for update in updates:
        message = update.get("message") or update.get("channel_post") or {}
        if str(message.get("chat", {}).get("id")) == chat:
            document = message.get("document")
            photos = [photo for photo in (message.get("photo") or []) if photo.get("file_id")]
            if not document and photos:
                document = max(photos, key=lambda p: p.get("width", 0) * p.get("height", 0))
                document = {**document, "file_name": f"telegram-{update['update_id']}.jpg"}
            if document:
                try:
                    name = clean_filename(document.get("file_name"))
                    if int(document.get("file_size") or 0) > MAX_BYTES:
                        raise ValueError("Файл больше 20 МБ.")
                    external_id = str(document.get("file_unique_id") or update["update_id"])
                    if not store.has_seen("telegram", external_id):
                        info = await telegram_call(client, token, "getFile", {"file_id": document["file_id"]})
                        path = info.get("file_path")
                        if not path:
                            raise RemoteError("Telegram: у вложения нет пути для скачивания.")
                        data = await remote_file(client, f"{TELEGRAM}/file/bot{token}/{quote(path, safe='/')}", "Telegram")
                        count += store.put("telegram", external_id, name, data)
                except ValueError:
                    skipped += 1
        store.set_setting(offset_key, update["update_id"] + 1)
    return f"Добавлено: {count}." + (f" Неподдерживаемых вложений: {skipped}." if skipped else "")


class DriveConfig(BaseModel):
    link: str = Field(max_length=1000)
    since: date
    recursive: bool = False


class TelegramConfig(BaseModel):
    chat: str = Field(pattern=r"^-?\d{1,20}$")
    token: SecretStr | None = None


class IikoConfig(BaseModel):
    app_id: str = Field(min_length=1, max_length=250)
    client_secret: SecretStr
    api_key: SecretStr


async def iiko_read(client, values):
    result = await remote_json(client, "POST", IIKO + "/api/v2/access_token", "iiko", json={
        "appId": values["app_id"], "clientSecret": values["client_secret"], "apiKey": values["api_key"]
    })
    token = result.get("token")
    if not token:
        raise RemoteError("iiko: в ответе авторизации нет токена.")
    result = await remote_json(client, "POST", IIKO + "/api/1/organizations", "iiko", json={},
                               headers={"Authorization": "Bearer " + token})
    if not isinstance(result.get("organizations"), list):
        raise RemoteError("iiko: в ответе нет списка организаций.")
    return [str(org.get("name", "")) for org in result["organizations"]]


async def synchronize(app):
    if app.state.lock.locked():
        return
    async with app.state.lock:
        for name, worker in (("drive", sync_drive), ("telegram", sync_telegram)):
            config = app.state.store.setting(name)
            if not config:
                continue
            try:
                status = await worker(app.state.store, app.state.client, config)
            except RemoteError as error:
                status = str(error)
            except Exception:
                status = "Не удалось завершить синхронизацию. Попытка повторится."
            app.state.status[name] = status


@asynccontextmanager
async def lifespan(app):
    token = os.environ.get("BM_OPERATOR_TOKEN", "")
    if len(token) < 24:
        raise RuntimeError("BM_OPERATOR_TOKEN должен содержать минимум 24 символа.")
    if os.getenv("BM_PUSH_TOKEN") and (len(os.environ["BM_PUSH_TOKEN"]) < 24 or
                                       hmac.compare_digest(token.encode(), os.environ["BM_PUSH_TOKEN"].encode())):
        raise RuntimeError("BM_PUSH_TOKEN должен быть отдельным ключом минимум из 24 символов.")
    app.state.operator = token
    app.state.push = os.getenv("BM_PUSH_TOKEN", "")
    app.state.store = Store(os.getenv("BM_DB", "data/intake.sqlite3"), Fernet(os.environ["BM_ENCRYPTION_KEY"]))
    app.state.status, app.state.lock = {}, asyncio.Lock()
    app.state.ocr_lock = asyncio.Lock()
    async with httpx.AsyncClient(timeout=30) as client:
        app.state.client = client

        async def poll():
            while True:
                await synchronize(app)
                await asyncio.sleep(max(10, int(os.getenv("BM_INTERVAL_SECONDS", "60"))))

        task = asyncio.create_task(poll())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authenticate(provided, expected):
    if not expected or not hmac.compare_digest(provided.encode(), ("Bearer " + expected).encode()):
        raise HTTPException(401, "Нужен ключ доступа.")


def operator(request: Request, authorization: str = Header(default="")):
    authenticate(authorization, request.app.state.operator)


@app.get("/")
def index():
    return FileResponse(HTML, headers={"Cache-Control": "no-store"})


app.mount("/assets", StaticFiles(directory=HTML.parent / "assets"), name="assets")
app.mount("/modules", StaticFiles(directory=HTML.parent / "modules"), name="modules")


@app.get("/api/intake", dependencies=[Depends(operator)])
def queue(request: Request, after_id: int = Query(default=0, ge=0, le=2**63-1)):
    store = request.app.state.store
    drive = store.setting("drive")
    telegram = store.setting("telegram")
    documents, next_cursor = store.list(after_id)
    return {"documents": documents, "next_cursor": next_cursor, "status": request.app.state.status,
            "drive": ({k: drive[k] for k in ("since", "recursive")} if drive else None),
            "telegram": ({"chat": telegram["chat"]} if telegram else None),
            "iiko": bool(store.setting("iiko"))}


@app.put("/api/intake/drive", dependencies=[Depends(operator)])
def configure_drive(request: Request, values: DriveConfig):
    try:
        folder, key = parse_drive_folder(values.link)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    request.app.state.store.set_setting("drive", {"folder": folder, "resource": key,
        "since": values.since.isoformat(), "recursive": values.recursive}, audit=True)
    return {"ok": True}


class SheetLink(BaseModel):
    link: str = Field(max_length=2048)


@app.post("/api/intake/sheets", dependencies=[Depends(operator)])
async def import_sheet(request: Request, values: SheetLink):
    try:
        accepted = await queue_sheet(request.app.state.store, request.app.state.client, values.link)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except RemoteError as error:
        raise HTTPException(502, str(error)) from error
    return {"accepted": accepted}


@app.put("/api/intake/telegram", dependencies=[Depends(operator)])
def configure_telegram(request: Request, values: TelegramConfig):
    store = request.app.state.store
    old = store.setting("telegram", {})
    token = values.token.get_secret_value().strip() if values.token else old.get("token", "")
    if not re.fullmatch(r"\d{5,}:[A-Za-z0-9_-]{20,}", token):
        raise HTTPException(422, "Укажите токен Telegram-бота.")
    store.set_setting("telegram", {"chat": values.chat, "token": token}, audit=True)
    return {"ok": True}


@app.put("/api/intake/iiko", dependencies=[Depends(operator)])
async def configure_iiko(request: Request, values: IikoConfig):
    config = {"app_id": values.app_id.strip(), "client_secret": values.client_secret.get_secret_value(),
              "api_key": values.api_key.get_secret_value()}
    if not all(config.values()):
        raise HTTPException(422, "Нужны App ID, Client Secret и API Key.")
    try:
        organizations = await iiko_read(request.app.state.client, config)
    except RemoteError as error:
        raise HTTPException(502, str(error)) from error
    request.app.state.store.set_setting("iiko", config, audit=True)
    return {"organizations": organizations}


@app.post("/api/intake/sync", dependencies=[Depends(operator)])
async def sync(request: Request):
    await synchronize(request.app)
    return request.app.state.status


@app.get("/api/intake/documents/{ident}", dependencies=[Depends(operator)])
def download(request: Request, ident: int):
    name, data = request.app.state.store.download(ident)
    return Response(data, media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name, safe='')}",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"
    })


@app.post("/api/intake/exports", dependencies=[Depends(operator)])
async def enqueue_export(request: Request, filename: str, source: str):
    if source not in {"edi", "docsinbox"}:
        raise HTTPException(422, "Выберите ЭДО или DocsInBox.")
    try:
        accepted = request.app.state.store.put(source, None, filename, await bounded_body(request))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {"accepted": accepted}


@app.get("/api/intake/documents/{ident}/edi", dependencies=[Depends(operator)])
def edi_document(request: Request, ident: int):
    name, data = request.app.state.store.download(ident)
    if Path(name).suffix.lower() != ".xml":
        raise HTTPException(422, "Для этого способа нужен XML УПД.")
    try:
        return parse_edi(data)
    except EdiError as error:
        raise HTTPException(422, str(error)) from error


@app.post("/api/intake/documents/{ident}/recognize", dependencies=[Depends(operator)])
async def recognize_document(request: Request, ident: int):
    lock = request.app.state.ocr_lock
    if lock.locked():
        raise HTTPException(409, "Уже распознаётся другой документ. Повторите после завершения.")
    async with lock:
        store = request.app.state.store
        name, data = await asyncio.to_thread(store.download, ident)
        try:
            result = await asyncio.to_thread(recognize, name, data)
        except RecognitionError as error:
            raise HTTPException(422, str(error)) from error
        return Response(content=json.dumps(result, ensure_ascii=False),
                        media_type="application/json", headers={"Cache-Control": "no-store"})


@app.post("/api/intake/documents/{ident}/reviewed", dependencies=[Depends(operator)])
def reviewed(request: Request, ident: int):
    request.app.state.store.reviewed(ident)
    return {"ok": True}


async def bounded_body(request: Request):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Файл превышает лимит 20 МБ.")
    return bytes(data)


@app.post("/api/intake/incoming")
async def incoming(request: Request, filename: str, source: str = "external",
                   authorization: str = Header(default="")):
    authenticate(authorization, request.app.state.push)
    if source not in {"external", "edi", "docsinbox"}:
        raise HTTPException(422, "Неверный источник файла.")
    data = await bounded_body(request)
    try:
        accepted = request.app.state.store.put(source, None, filename, data)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {"accepted": accepted}

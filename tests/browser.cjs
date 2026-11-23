const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {spawn, execFileSync} = require("node:child_process");
const {once} = require("node:events");
const {chromium} = require("playwright");

const root = path.resolve(__dirname, "..");
const python = process.env.DASHBAR_PYTHON || "python3";
const token = () => crypto.randomBytes(32).toString("base64url");
const expectText = (page, text) => page.getByText(text).first().waitFor({timeout: 12000});
const button = (page, name) => page.getByRole("button", {name, exact: true});

async function startServer(dir) {
  const operator = token(), push = token();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:https?|all)_proxy$/i.test(key)));
  const server = spawn(python, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "0"],
    {cwd: root, env: {...env, BM_OPERATOR_TOKEN: operator, BM_PUSH_TOKEN: push,
      BM_ENCRYPTION_KEY: token() + "=", BM_DB: path.join(dir, "queue.sqlite3"),
      BM_AI_OPENAI_KEY: ""}});
  try {
    const url = await new Promise((resolve, reject) => {
      let logs = "";
      const timeout = setTimeout(() => reject(new Error("Сервер не запустился")), 8000);
      server.stderr.on("data", data => {
        logs += data;
        const ready = logs.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
        if (ready) { clearTimeout(timeout); resolve(ready[1]); }
      });
      server.once("error", error => { clearTimeout(timeout); reject(error); });
      server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Сервер завершился: ${code}\n${logs}`)); });
    });
    return {server, url, operator, push};
  } catch (error) {
    server.kill();
    throw error;
  }
}

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dashbar-qa-"));
  const launch = {};
  if (process.env.DASHBAR_CHROMIUM_ADAPTER) {
    const {default: engine} = await import(process.env.DASHBAR_CHROMIUM_ADAPTER);
    launch.executablePath = await engine.executablePath();
    const insecure = new Set(["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials"]);
    launch.args = engine.args.filter(flag => !insecure.has(flag));
  }
  let server;
  try {
    const fixture = path.join(dir, "УПД-тест.png");
    execFileSync(python, ["-c", "import sys; sys.path.insert(0, 'tests'); from test_ocr_russian import RussianInvoiceTest; RussianInvoiceTest().sample().save(sys.argv[1])", fixture], {cwd: root});
    const image = await fs.readFile(fixture);
    for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]]) {
      const live = await startServer(await fs.mkdtemp(path.join(dir,"profile-")));
      server = live.server;
      const browser = await chromium.launch(launch);
      try {
        const ctx = await browser.newContext({viewport:{width,height},isMobile:width<1000,hasTouch:width<1000,acceptDownloads:true});
        const page = await ctx.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const request = ctx.request;
        assert.ok((await request.post(live.url + "/api/intake/incoming?filename=" + encodeURIComponent(path.basename(fixture)),
          {headers:{Authorization:"Bearer " + live.push}, data:image})).ok());
        await page.goto(live.url);
        await button(page,"Начать со своим баром").click();
        await button(page,"Дальше").click();
        await page.getByLabel("Название точки").fill("Тестовый бар");
        await button(page,"Дальше").click();
        await button(page,"Инвентаризация и расхождения").click();
        await button(page,"iiko").click();
        await button(page,"Открыть приложение").click();
        for(const tab of ["Сегодня","Склад","Техкарты","Отчёты","ИИ","Приёмка"])
          await page.getByRole("navigation").getByRole("button",{name:tab,exact:true}).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await button(page,"Источники накладных").click();
        await page.getByLabel("Ключ оператора сервера").fill(live.operator);
        await button(page,"Подключить очередь").click();
        const original = page.waitForEvent("download");
        await button(page,"Скачать оригинал").click();
        assert.deepEqual(await fs.readFile(await (await original).path()), image);
        await button(page,"Распознать").click();
        await page.getByRole("heading",{name:"Проверить накладную"}).waitFor();
        const buyer = page.getByLabel("Покупатель",{exact:true});
        assert.equal(await buyer.inputValue(), "ООО Южный Бар");
        await buyer.fill("ООО Южный Бар · проверено");
        await button(page,"Подтвердить и сохранить").click();
        await expectText(page,"Накладная сохранена в реестре.");
        await button(page,"Закрыть").click();
        await page.locator("#invoice-results summary").first().click();
        await expectText(page,"Покупатель · ООО Южный Бар · проверено");
        await page.getByRole("navigation").getByRole("button",{name:"Склад",exact:true}).click();
        await page.locator('[data-doc="rest"]').setInputFiles({name:"Остатки.csv",mimeType:"text/csv",
          buffer:Buffer.from("На дату: 20.11.2026\nПозиция;Остаток;Единица\nСироп;9;шт")});
        await expectText(page,"Остатки: 1 позиций.");
        await button(page,"Начать ввод").click();
        assert.equal(await page.locator("#inv-date").getAttribute("type"),"date");
        await page.locator("#inv-date").fill("2099-12-31");
        await page.getByLabel("Сироп",{exact:true}).fill("0");
        await button(page,"Сохранить").click();
        await expectText(page,"Дата инвентаризации не может быть в будущем");
        await page.locator("#inv-date").fill("2026-11-21");
        assert.equal(await page.getByLabel("Сироп",{exact:true}).inputValue(),"0");
        await button(page,"Сохранить").click();
        await expectText(page,"Инвентаризация сохранена");
        await button(page,"Профиль и настройки").click();
        const backup = page.waitForEvent("download");
        await button(page,"Скачать копию").click();
        const downloaded = await backup;
        const json = await fs.readFile(await downloaded.path());
        assert.equal(JSON.parse(json).data.invoices[0].buyer,"ООО Южный Бар · проверено");
        await page.getByLabel("Название склада бара в учёте").fill("Временный склад");
        await page.locator("[data-import]").setInputFiles({name:"Копия.json",mimeType:"application/json",buffer:json});
        await expectText(page,"Копия загружена");
        await page.reload();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("barmanager-proto-v2")).venue.stockName),"");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("barmanager-proto-v2")).data.counts[0].rows[0].fact),0);
        assert.deepEqual(errors,[]);
        console.log(`PASS Chromium ${width}×${height}: вкладки, оригинал, OCR, покупатель, дата, JSON`);
      } finally {
        await browser.close();
      }
      const exited = once(server,"exit");
      server.kill();
      await exited;
      server = null;
    }
  } finally {
    if(server&&server.exitCode===null&&server.signalCode===null){
      const exited=once(server,"exit");
      server.kill();
      await exited;
    }
    await fs.rm(dir,{recursive:true,force:true});
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });

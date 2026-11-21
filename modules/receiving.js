"use strict";
/* ---------- Приёмка ---------- */
function sectionHelp(k){
  const answers=S.sec[k].q;
  if(k==="receiving"){
    const who={"Я в день поставки":"Сверьте документ в день поставки, пока можно уточнить расхождения.",
      "Бухгалтерия с задержкой":"Используйте реестр для передачи накладных бухгалтеру.",
      "Нерегулярно":"Проверьте проведение перед закрытием периода."}[answers.who];
    const price={"Есть":"Загрузите договорную матрицу вместе с первой накладной.","Частично":"Сверка покажет, для каких строк в матрице пока нет пары.",
      "Нет, собрать":"Добавьте согласованные цены вручную в конце раздела."}[answers.matrix];
    return [who,price].filter(Boolean).join(" ");
  }
  if(k==="stock")return S.ans.flow.includes("DocsInBox")?"Остатки ЕГАИС загружайте отдельно в карточке DocsInBox.":"";
  if(k==="cards"&&answers.prep==="Да")return "Для заготовки добавьте выход замеса и единицы измерения.";
  return "";
}
function setup(k){
  const c=SEC[k], st=S.sec[k], docs=docsFor(k);
  const note=sectionHelp(k);
  const help=note?`<p class="muted">${esc(note)}</p>`:"";
  const ans=c.qs.length?`<div class="card"><div class="between"><h3>Вопросы раздела</h3><button class="btn s" data-a="ask" data-k="${k}">${st.asked||Object.values(st.q).some(Boolean)?"Изменить":"Ответить"}</button></div>
    ${st.asked||Object.values(st.q).some(Boolean)?c.qs.map(x=>`<p class="muted">${esc(x[1])} <b style="color:var(--text2)">${esc(st.q[x[0]]||"не отвечено")}</b></p>`).join(""):`<p class="muted">${c.qs.length} вопроса. Можно отложить.</p>`}</div>`:"";
  const dl=docs.map(d=>{
    const r=st.docs[d[0]], b=busy[k+"."+d[0]];
    const receiving=k==="receiving";
    if(receiving&&d[0]==="invoice")return r||b?`<div class="doc"><h3>Последний импорт накладной</h3>
      ${b?`<p class="muted">Читаю «${esc(b)}»…</p>`:""}
      ${r?.err?`<p class="muted">${r.errName?esc(r.errName)+": ":""}${esc(r.err)}</p>`:""}
      ${r?.res?resBlock(r,true):""}</div>`:"";
    return `<div class="doc" id="doc-${d[0]}"><div class="between" style="align-items:flex-start"><div><h3>${esc(d[1])}</h3><p class="muted">${esc(d[2])}</p></div>${r&&r.res?`<span class="tag">Загружено</span>`:""}</div>
     <p class="muted"><b style="color:var(--text2)">Где взять:</b> ${esc(d[3])}</p>
     ${b?`<div class="res">Читаю «${esc(b)}»…</div>`:""}
     ${r&&r.err?`<div class="res" style="color:var(--warn)">${r.errName?esc(r.errName)+": ":""}${esc(r.err)}</div>`:""}
     ${r&&r.res?resBlock(r,receiving):""}
     <label class="btn s file" style="align-self:flex-start"> ${receiving?"Загрузить матрицу":(r&&r.res?"Загрузить другой файл":"Загрузить файл")}<input type="file" data-sec="${k}" data-doc="${d[0]}" accept="${receiving?"": "image/*,"}.pdf,.xlsx,.xls,.csv,.txt,.tsv" aria-label="${esc(d[1])}" ${b?"disabled":""}></label></div>`;
  }).join("");
  if(k==="receiving")return `<div class="sec"><h2>Загрузка документов</h2>${help}<div class="list">${dl}</div></div>${ans}`;
  return `${ans}<div class="sec"><div class="between"><h2>Документы</h2>${q("local")}</div>${help}<div class="list">${dl}</div>
   <p class="muted">Excel, CSV и текст разбираются на устройстве. Фото и сканы — через ИИ, если он подключён.</p></div>`;
}
const invoiceSearch={query:"",limit:25};
function invoicesByDate(){
  return S.data.invoices.slice().reverse().sort((a,b)=>b.date.localeCompare(a.date));
}
function invoiceReceiptStatus(invoice){
  if(invoice.receiptAt)return "На приходе BarManager";
  return invoice.status==="проведена"?"Проведена":"Ожидает прихода";
}
function invoiceResults(invoices){
  const words=receiveKey(invoiceSearch.query).split(" ").filter(Boolean);
  const found=words.length?invoices.filter(invoice=>{
    const metadata=receiveKey([invoice.supplier,invoice.number,invoice.filename].filter(Boolean).join(" "));
    if(words.every(word=>metadata.includes(word)))return true;
    return invoice.rows.some(row=>{
      const item=receiveKey(row.pos);
      return words.every(word=>metadata.includes(word)||item.includes(word));
    });
  }):invoices;
  const shown=found.slice(0,invoiceSearch.limit);
  return `<p class="muted" role="status">${words.length?`Найдено: ${found.length} из ${invoices.length}`:`Накладных: ${invoices.length}`}</p>
    ${shown.length?`<div class="list">${shown.map(invoice=>`<details class="doc invoice" data-invoice-id="${esc(invoice.id)}">
      <summary><b>${esc(invoice.supplier||"Поставщик не указан")}${invoice.number?" · № "+esc(invoice.number):""}</b>
      <span class="muted">${invoice.date?ruDate(invoice.date):"Дата не указана"} · ${invoice.rows.length} строк · ${exactMoney(invoice.sum)}</span></summary>
      <p class="muted">${invoiceReceiptStatus(invoice)}${invoice.filename?" · "+esc(invoice.filename):""}</p>
      ${invoice.receiptAt||invoice.status==="проведена"?"":`<button class="btn s" data-a="postreceipt" data-id="${esc(invoice.id)}">Поставить на приход</button>`}
      <div data-invoice-rows></div></details>`).join("")}</div>`:
      `<div class="card"><p class="muted">${invoices.length?"Ничего не найдено. Измените запрос.":"Подключите источник накладных или добавьте ссылку на файл."}</p></div>`}
    ${found.length>shown.length?`<button class="btn s" data-a="invoicemore">Показать ещё ${Math.min(25,found.length-shown.length)}</button>`:""}`;
}
function paintInvoiceResults(){
  const target=document.getElementById("invoice-results");
  if(target)target.innerHTML=invoiceResults(invoicesByDate());
}
function invoiceRows(invoice){
  const tax=invoice.taxBasis==="gross"?" с НДС":"";
  return table(["Позиция","Кол-во","Цена"+tax,"Сумма"+tax],invoice.rows.map(row=>[
    row.pos,fmt(row.qty,4)+(row.unit?" "+row.unit:""),exactMoney(row.price),exactMoney(row.sum)
  ]));
}
function vReceiving(){
  if(isDemo()) return `<div class="sec"><div class="between"><div class="row"><h2>Накладные</h2>${q("unposted")}</div><span class="muted">с 05.11</span></div>
   <div class="list">${DEMO.invoices.map(r=>`<div class="li"><div><b>${r[1]}</b><span class="muted">${r[0]} · ${r[2]} ₽</span></div><span class="tag ${r[4]}">${r[3]}</span></div>`).join("")}</div></div>
  <div class="sec"><div class="row"><h2>Цены против матрицы</h2>${q("matrix")}</div>
   ${table(["Позиция","Матрица","Накладная","Откл."],[["Лимон, кг","198,00","312,40","+58%"],["Тоник 0,2","74,00","86,00","+16%"],["Джин, л","1 480","1 480","0%"]])}</div>${secFindings("receiving")}`;
  const invoices=invoicesByDate();
  const comparisons=invoiceChecks();
  const matched=comparisons.filter(c=>c.matrix).length;
  const priceRows=priceControl(comparisons);
  return `<div class="sec" id="doc-invoice"><button class="btn" data-a="receivingsources" style="align-self:flex-start">Источники и загрузка по ссылке</button></div>
  ${S.data.docsInboxRegistry.length?'<button class="btn s" data-a="docsinboxregistry" style="align-self:flex-start">Реестр DocsInBox</button>':""}
  <div class="sec" id="invoice-register"><div class="row"><h2>Реестр накладных</h2>${q("r_reg")}</div>
    ${invoices.length?`<label class="field">Поиск накладных<input class="in search" id="invoice-search" type="search"
      placeholder="Поставщик, товар или номер" autocomplete="off" value="${esc(invoiceSearch.query)}"></label>`:""}
    <div class="col" id="invoice-results">${invoiceResults(invoices)}</div></div>
  ${setup("receiving")}
  <div class="sec" id="receiving-checks"><div class="row"><h2>Цены против матрицы</h2>${q("r_pricectl")}</div>
   ${comparisons.length?`<p class="muted">Сверено ${matched} из ${comparisons.length} строк. Для сверки нужны одинаковые позиция, единица и поставщик. Для распознанных накладных подтвердите также, что цена в матрице указана с НДС. Порог отклонения — 5%.</p>`:""}
   ${priceRows.length?table(["Позиция","Поставщик","Матрица","В накладной","Откл."],priceRows):`<p class="muted">${matched?"В сверенных строках отклонений от 5% нет.":Object.keys(S.data.prices).length&&invoices.length?"Совпадений с матрицей нет. Проверьте наименования, единицы и поставщиков.":"Загрузите накладную и матрицу цен."}</p>`}</div>
  ${matrixBlock()}
  ${secFindings("receiving")}`;
}
const incoming={token:"",queue:[],nextCursor:null,notice:"",connected:false,busy:false};
const scanImage=/\.(?:jpe?g|png|webp)$/i;
const incomingLabels={drive:"Google Drive",sheets:"Google Таблицы",telegram:"Telegram",external:"Входящий API",edi:"ЭДО",docsinbox:"DocsInBox"};
const intakeKind=`<select class="in" name="kind" aria-label="Тип документа"><option value="invoice">Накладная</option><option value="matrix">Матрица цен</option></select>`;
const intakeOnServer=()=>["http:","https:"].includes(location.protocol);
function blankOcrRow(){return {pos:"",unit:"",qty:"",netPrice:"",netSum:"",vat:"",gross:"",needsReview:false};}
function renderOcr(s){
  const input=(label,key,value,index)=>`<label class="field">${label}<input class="in" data-ocr-key="${key}" ${index==null?"":`data-ocr-index="${index}"`}
    ${["qty","netPrice","netSum","vat","gross","total"].includes(key)?'inputmode="decimal"':key==="date"?'type="date"':""} value="${esc(value)}" required></label>`;
  return `<h2>Проверить накладную</h2><p class="muted">${esc(s.name)} · ${s.mode==="edi-xml"?"XML УПД":"распознано на сервере BarManager"}</p>
    <p>Сверьте поставщика, дату, фасовку, количество, цену, НДС и итог с оригиналом. Все поля можно исправить.</p>
    ${s.mode==="local-ocr"&&!s.detectedRows?'<p class="muted">Строки таблицы не распознаны. Сверьте документ по изображению или загрузите выгрузку ЭДО.</p>':""}
    ${s.preview.length?`<details class="card" open><summary>Изображение документа</summary>
    ${s.preview.map((data,i)=>`<img style="width:100%;height:auto" src="data:image/jpeg;base64,${esc(data)}" alt="Страница ${i+1} накладной">`).join("")}</details>`:""}
    ${s.ocrText?`<details class="card"><summary>Распознанный текст</summary><p style="white-space:pre-wrap">${esc(s.ocrText)}</p></details>`:""}
    <form data-f="confirmocr" class="col">
    ${input("Поставщик","supplier",s.supplier)}
    ${input("Номер","number",s.number)}
    ${input("Дата","date",s.date)}
    ${s.rows.map((row,i)=>`<fieldset class="card"><legend>Строка ${i+1}</legend>
      ${row.calculatedGross?'<p class="muted">Сумма с НДС рассчитана по прочитанным полям и общему итогу. Сверьте её с оригиналом.</p>':""}
      ${row.needsReview&&!row.calculatedGross?'<p class="muted">Суммы распознаны не полностью или расходятся. Сверьте с оригиналом.</p>':row.rounding?'<p class="muted">Цена за единицу округлена. Сверьте сумму без НДС по оригиналу.</p>':""}
      ${input("Товар и фасовка","pos",row.pos,i)}
      <div class="row">${input("Единица","unit",row.unit,i)}${input("Количество","qty",row.qty,i)}</div>
      <div class="row">${input("Цена без НДС","netPrice",row.netPrice,i)}${input("Сумма без НДС","netSum",row.netSum,i)}</div>
      <div class="row">${input("НДС по строке","vat",row.vat,i)}${input("Сумма с НДС","gross",row.gross,i)}</div>
      ${s.rows.length>1?`<button class="link" type="button" data-a="ocrdel" data-i="${i}">Убрать строку</button>`:""}
    </fieldset>`).join("")}
    <button class="btn s" type="button" data-a="ocradd" ${s.rows.length>=100?"disabled":""}>Добавить строку</button>
    ${input("Итог по документу с НДС","total",s.total)}
    <p class="muted" role="status">${esc(s.error||"")}</p>
    <button class="btn p">Подтвердить и сохранить</button>
    </form>`;
}
async function openOcr(item,state,mode){
  const xml=/\.xml$/i.test(item.name);
  const result=await incomingRequest("/documents/"+item.id+(xml?"/edi":"/recognize"),{method:xml?"GET":"POST"});
  if(S!==state||S.mode!==mode||sheet?.t!=="receivingsources")return "Откройте документ в очереди для проверки.";
  sheet={t:"ocr",queueId:item.id,name:item.name,mode:result.mode,supplierInn:result.supplierInn||"",supplier:result.supplier||"",number:result.number||"",
    date:result.date||"",total:result.total||"",detectedRows:result.rows?.length||0,rows:result.rows?.length?result.rows:[blankOcrRow()],
    preview:(result.preview||[]).filter(data=>/^[a-z0-9+/=]+$/i.test(data)),ocrText:result.ocrText||""};
  render(true);
  return "Проверьте распознанную накладную.";
}
function confirmOcr(){
  const draft=sheet;
  if(draft?.t!=="ocr"||incoming.busy)return;
  try{
    if(!draft.supplier.trim()||!draft.number.trim()||parseDate(draft.date)!==draft.date||!draft.date)
      throw new Error("Проверьте поставщика, номер и дату накладной.");
    const total=cents(readNumber(draft.total));
    let declaredRows=0;
    const sourceRows=draft.rows.map((r,i)=>{
      const qty=readNumber(r.qty), net=readNumber(r.netPrice), vat=readNumber(r.vat), gross=readNumber(r.gross);
      const sum=cents(readNumber(r.netSum)), estimated=cents(net*qty), tax=cents(vat), grossCents=cents(gross);
      const unitRounding=Math.max(1,Math.ceil(qty*.5));
      if(!r.pos.trim()||!r.unit.trim()||!Number.isFinite(qty)||qty<=0||
        ![sum,estimated,tax,grossCents].every(x=>Number.isSafeInteger(x)&&x>=0)||net<0||vat<0||gross<0||
        Math.abs(sum-estimated)>unitRounding||sum+tax!==grossCents)
        throw new Error(`Строка ${i+1}: проверьте товар, количество, цену, НДС и сумму.`);
      declaredRows+=grossCents;
      return {pos:r.pos.trim(),unit:r.unit.trim(),qty:String(qty),price:String(gross/qty),sum:String(gross),
        supplier:draft.supplier.trim(),date:draft.date,number:draft.number.trim(),
        netPrice:net,vat,netSum:sum/100,sourceLine:i+1};
    });
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(declaredRows)||declaredRows!==total)
      throw new Error("Итог документа должен совпадать с суммой строк с НДС.");
    const rows=[...sourceRows,{pos:"Итого",sum:String(total/100)}];
    commitReceiving(()=>{
      const res=applyReceiving("invoice",{title:"Накладная · распознана и проверена",rows,metadata:[],
        sourceDocumentId:draft.queueId,supplierInn:draft.supplierInn,taxBasis:"gross"},{name:draft.name});
      S.sec.receiving.docs={...S.sec.receiving.docs,invoice:{name:draft.name,res,local:true}};
    });
    sheet={t:"receivingsources"};
    render(true);
    return runIncoming(async()=>{
      try{
        await incomingRequest("/documents/"+draft.queueId+"/reviewed",{method:"POST"});
        incoming.queue=incoming.queue.filter(r=>r.id!==draft.queueId);
        return "Накладная сохранена в реестре.";
      }catch(e){return "Накладная сохранена. Сервер не снял её с очереди. Уберите файл после проверки.";}
    });
  }catch(e){draft.error=e.message;render(true);}
}
function incomingQueue(){
  const items=incoming.queue.map(item=>`<div class="doc"><div><b>${esc(item.name)}</b><p class="muted">${esc(incomingLabels[item.source]||"Интеграция")}</p></div>
    <form class="row" data-f="importqueue" data-id="${esc(item.id)}">${scanImage.test(item.name)?'<input type="hidden" name="kind" value="invoice">':intakeKind}<button class="btn s" ${incoming.busy?"disabled":""}>${scanImage.test(item.name)?"Распознать":"Открыть"}</button></form>
    <button class="link" data-a="sourcefile" data-id="${esc(item.id)}">Скачать оригинал</button>
    <button class="link" data-a="skipqueue" data-id="${esc(item.id)}" ${incoming.busy?"disabled":""}>Убрать из очереди</button></div>`).join("")||
    (incoming.connected&&!incoming.nextCursor?`<p class="muted">Очередь пуста.</p>`:"");
  return items+(incoming.nextCursor?`<button class="btn s" data-a="queuemore" ${incoming.busy?"disabled":""}>Показать следующие документы</button>`:"");
}
function receivingSources(){
  return `<h2>Источники и загрузка по ссылке</h2>
  <details class="card"><summary>Прямая ссылка на файл</summary>
    <form class="col" data-f="directintake">
      <label class="field">HTTPS-ссылка<input class="in" type="url" name="link" required autocomplete="off"></label>
      ${intakeKind}<button class="btn s">Загрузить по ссылке</button>
    </form><p class="muted">Подходит ссылка на сам файл. Источник должен разрешать загрузку из браузера без входа.</p></details>
  ${intakeOnServer()?`<form class="col" data-f="connectintake">
    <label class="field">Ключ оператора сервера<input class="in" type="password" name="token" autocomplete="off" required></label>
    <button class="btn s">${incoming.connected?"Переподключить очередь":"Подключить очередь"}</button></form>
  <div class="btns"><button class="btn s" data-a="refreshintake">Обновить очередь</button>
    <button class="btn s" data-a="syncintake">Синхронизировать источники</button></div>
  <details class="card"><summary>Папка Google Drive</summary>
    <p class="muted">PDF и фото из папки появятся в очереди. Откройте документ для распознавания.</p>
    <form class="col" data-f="configureintake" data-source="drive">
      <label class="field">Ссылка на папку<input class="in" name="link" type="url" required></label>
      <label class="field">Файлы, изменённые с<input class="in" name="since" type="date" required></label>
      <label class="row"><input type="checkbox" name="recursive">Включить подпапки</label>
      <button class="btn s">Сохранить источник</button></form></details>
  <details class="card"><summary>Google Таблица</summary>
    <form class="col" data-f="configureintake" data-source="sheets">
      <label class="field">Ссылка на нужный лист<input class="in" name="link" type="url" required></label>
      <button class="btn s">Добавить лист в очередь</button></form></details>
  <details class="card"><summary>Telegram</summary>
    <p class="muted">Бот получает файлы и фото из указанного чата.</p>
    <form class="col" data-f="configureintake" data-source="telegram">
      <label class="field">ID чата<input class="in" name="chat" inputmode="numeric" required></label>
      <label class="field">Токен бота<input class="in" name="token" type="password" autocomplete="off"></label>
      <button class="btn s">Сохранить источник</button></form></details>
  <details class="card"><summary>Выгрузка ЭДО или DocsInBox</summary>
    <p class="muted">Добавьте пакет выгрузок. XML УПД откроется для проверки. Для автоматической подачи используйте подключённую папку или входящий API.</p>
    <form class="col" data-f="queuedexports">
      <label class="field">Источник<select class="in" name="source"><option value="edi">ЭДО</option><option value="docsinbox">DocsInBox</option></select></label>
      <label class="field">Файлы выгрузки<input class="in" type="file" name="exports" multiple accept=".xml,.csv,.xlsx,.xls,.tsv,.pdf" required></label>
      <button class="btn s">Добавить в очередь</button></form></details>
  <details class="card"><summary>iikoCloud</summary>
    <p class="muted">Проверка доступа к организациям.</p>
    <form class="col" data-f="configureintake" data-source="iiko">
      <label class="field">App ID<input class="in" name="app_id" required></label>
      <label class="field">Client Secret<input class="in" name="client_secret" type="password" autocomplete="off" required></label>
      <label class="field">API Key<input class="in" name="api_key" type="password" autocomplete="off" required></label>
      <button class="btn s">Проверить подключение</button></form></details>
  <p class="muted">Сторонние сервисы могут отправлять файлы через входящий API. Документы появятся в очереди.</p>`:
    `<p class="muted">Для папок Google Drive, Google Таблиц, Telegram и входящего API откройте приложение по адресу сервера приёмки. Инструкция в архиве сборки.</p>`}
  <div class="res" id="incoming-notice" role="status">${esc(incoming.notice)}</div>
  <div id="incoming-queue">${incomingQueue()}</div>`;
}
function paintIncoming(message){
  incoming.notice=message;
  const notice=document.getElementById("incoming-notice");
  if(notice)notice.textContent=message;
  const queue=document.getElementById("incoming-queue");
  if(queue)queue.innerHTML=incomingQueue();
}
async function incomingRequest(path,{method="GET",body,file,blob=false}={}){
  if(!intakeOnServer()||!incoming.token)throw new Error("Откройте сервер приёмки и подключите очередь ключом оператора.");
  const headers={Authorization:"Bearer "+incoming.token};
  if(body)headers["Content-Type"]="application/json";
  if(file)headers["Content-Type"]="application/octet-stream";
  const response=await fetch("/api/intake"+path,{method,headers,body:file||(body?JSON.stringify(body):undefined),
    credentials:"same-origin",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(90000)});
  if(response.status===401)throw new Error("Ключ оператора не принят сервером.");
  const type=response.headers.get("content-type")||"";
  const result=type.includes("application/json")?await response.json():null;
  if(!response.ok||(!blob&&!result)||(blob&&!type.includes("application/octet-stream"))){
    throw new Error(typeof result?.detail==="string"?result.detail:
      response.status===422?"Проверьте поля источника.":"Ответ очереди недоступен. Откройте приложение по адресу сервера приёмки.");
  }
  return blob?response.blob():result;
}
async function refreshIncoming(append=false){
  const data=await incomingRequest(append?`?after_id=${incoming.nextCursor}`:"");
  incoming.queue=append?incoming.queue.concat(data.documents):data.documents;
  incoming.nextCursor=data.next_cursor??null;
  incoming.connected=true;
  return data;
}
async function directIntake(link){
  const url=new URL(link);
  if(url.protocol!=="https:"||url.username||url.password)throw new Error("Укажите HTTPS-ссылку на файл.");
  if((url.hostname==="docs.google.com"&&url.pathname.startsWith("/spreadsheets/"))||
     (url.hostname==="drive.google.com"&&url.pathname.includes("/folders/"))){
    throw new Error("Используйте поле «Google Таблица» или «Папка Google Drive» на сервере приёмки.");
  }
  let response;
  try{response=await fetch(url.href,{credentials:"omit",referrerPolicy:"no-referrer",signal:AbortSignal.timeout(30000)});}
  catch(e){throw new Error("Не удалось скачать файл. Проверьте доступ или добавьте скачанный файл в подключённую папку или очередь.");}
  if(!response.ok||new URL(response.url||url.href).protocol!=="https:")throw new Error("Файл по ссылке недоступен.");
  const mime=(response.headers.get("content-type")||"").split(";")[0].toLowerCase();
  if(mime==="text/html"||mime==="application/xhtml+xml")throw new Error("По ссылке открывается страница. Нужна прямая ссылка на файл.");
  const sizeLimit=20*1024*1024;
  if(Number(response.headers.get("content-length"))>sizeLimit)throw new Error("Файл превышает лимит 20 МБ.");
  const finalUrl=new URL(response.url||url.href);
  const disposition=response.headers.get("content-disposition")||"";
  const encodedName=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const rawName=encodedName||disposition.match(/filename="?([^";]+)/i)?.[1]||finalUrl.pathname.split("/").pop();
  let name;
  try{name=decodeURIComponent(rawName);}catch(e){name=rawName;}
  name=name.split(/[\\/]/).pop().trim();
  if(!/\.(?:xlsx?|pdf|csv|tsv|txt)$/i.test(name)){
    const extension={"text/csv":"csv","text/tab-separated-values":"tsv","application/pdf":"pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx","application/vnd.ms-excel":"xls","text/plain":"txt"}[mime];
    if(!extension)throw new Error("Поддерживаются Excel, CSV, TSV, TXT и PDF.");
    name="Документ."+extension;
  }
  const reader=response.body?.getReader();
  if(!reader)throw new Error("Файл пуст.");
  const chunks=[];
  let size=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>sizeLimit){await reader.cancel();throw new Error("Файл превышает лимит 20 МБ.");}
    chunks.push(value);
  }
  if(!size)throw new Error("Файл пуст.");
  return new File(chunks,name,{type:mime});
}
async function runIncoming(action){
  if(incoming.busy)return;
  incoming.busy=true;paintIncoming("Загрузка…");
  try{paintIncoming(await action());}
  catch(e){paintIncoming(e.message||"Не удалось получить документ.");}
  finally{incoming.busy=false;paintIncoming(incoming.notice);}
}
async function importIncoming(file,kind,mode,state){
  if(S!==state||S.mode!==mode||isDemo())throw new Error("Вернитесь в свой бар и повторите загрузку.");
  const ok=await handleFile("receiving",kind,file);
  if(!ok)throw new Error(S.sec.receiving.docs[kind]?.err||"Документ не сохранён. Повторите загрузку после завершения предыдущей.");
  return ok;
}
function submitIncoming(form){
  const data=new FormData(form), link=String(data.get("link")||"").trim(), kind=data.get("kind");
  const mode=S.mode, state=S;
  return runIncoming(async()=>{
    if(form.dataset.f==="directintake"){
      const result=await importIncoming(await directIntake(link),kind,mode,state);
      if(result==="docsinboxRegistry")return "Открылся реестр DocsInBox. Проверьте и сохраните его.";
      if(result==="scan")throw new Error("Это PDF-скан. Добавьте его в папку Drive или отправьте боту, чтобы распознать из очереди.");
      return result==="preview"?"Проверьте лист и подтвердите загрузку.":"Документ по ссылке загружен.";
    }
    if(form.dataset.f==="connectintake"){
      incoming.token=String(data.get("token")||"").trim();
      incoming.connected=false;incoming.queue=[];incoming.nextCursor=null;
      form.reset();
      await refreshIncoming();
      return "Очередь подключена.";
    }
    if(form.dataset.f==="queuedexports"){
      const files=data.getAll("exports").filter(file=>file.size);
      if(!files.length||files.length>50)throw new Error("Выберите от одного до 50 файлов.");
      const source=data.get("source");
      let added=0, repeats=0;
      const failed=[];
      for(const file of files){
        try{
          const response=await incomingRequest(`/exports?source=${encodeURIComponent(source)}&filename=${encodeURIComponent(file.name)}`,{method:"POST",file});
          if(response.accepted)added++;else repeats++;
        }catch(e){failed.push(file.name+": "+e.message);}
      }
      await refreshIncoming();
      form.reset();
      return `Добавлено: ${added}. Повторов: ${repeats}.`+(failed.length?" Ошибки: "+failed.join(" · "):"");
    }
    if(form.dataset.f==="importqueue"){
      const item=incoming.queue.find(row=>String(row.id)===form.dataset.id);
      if(!item)throw new Error("Обновите очередь.");
      if(scanImage.test(item.name)||/\.xml$/i.test(item.name))return openOcr(item,state,mode);
      const blob=await incomingRequest("/documents/"+item.id,{blob:true});
      const result=await importIncoming(new File([blob],item.name,{type:blob.type}),kind,mode,state);
      if(result==="scan")return openOcr(item,state,mode);
      if(result==="docsinboxRegistry"){sheet.queueId=item.id;return "Открылся реестр DocsInBox. Проверьте и сохраните его.";}
      if(result==="preview"){sheet.queueId=item.id;return "Проверьте лист и подтвердите загрузку.";}
      try{
        await incomingRequest("/documents/"+item.id+"/reviewed",{method:"POST"});
        incoming.queue=incoming.queue.filter(row=>row.id!==item.id);
        return "Документ загружен.";
      }catch(e){return "Документ загружен. Сервер не снял его с очереди. Можно убрать его вручную.";}
    }
    const source=form.dataset.source;
    const body=source==="drive"?{link,since:data.get("since"),recursive:data.has("recursive")}:
      source==="sheets"?{link}:Object.fromEntries(data);
    if(source==="telegram"&&!body.token)delete body.token;
    const result=await incomingRequest("/"+source,{method:source==="sheets"?"POST":"PUT",body});
    form.reset();
    await refreshIncoming();
    if(source==="sheets")return result.accepted?"Лист добавлен в очередь. Выберите тип документа.":"Эта версия листа уже поступала в очередь.";
    if(source==="iiko")return "Доступных организаций: "+result.organizations.length+".";
    return "Источник сохранён. Нажмите «Синхронизировать источники».";
  });
}
function matrixByPosition(){
  const prices=new Map();
  for(const [pos,matrix] of Object.entries(S.data.prices)){
    const key=receiveKey(pos);
    prices.set(key,prices.has(key)?null:matrix);
  }
  return prices;
}
function invoiceChecks(){
  const prices=matrixByPosition();
  return S.data.invoices.flatMap(inv=>inv.rows.map((row,index)=>{
    const candidate=prices.get(receiveKey(row.pos));
    const sameUnit=receiveUnit(row.unit)&&receiveUnit(row.unit)===receiveUnit(candidate?.unit);
    const sameSupplier=receiveKey(inv.supplier)&&receiveKey(inv.supplier)===receiveKey(candidate?.supplier);
    const sameTaxBasis=!inv.taxBasis||inv.taxBasis===candidate?.taxBasis;
    const matrix=sameUnit&&sameSupplier&&sameTaxBasis&&num(candidate.price)>0&&num(row.price)>=0?candidate:null;
    const delta=matrix?(num(row.price)-num(matrix.price))/num(matrix.price)*100:null;
    return {inv,row,index,matrix,delta};
  }));
}
function priceControl(checks=invoiceChecks()){
  return checks.filter(c=>c.matrix&&Math.abs(c.delta)+1e-9>=5).map(c=>[
    c.row.pos,c.inv.supplier,exactMoney(c.matrix.price),exactMoney(c.row.price),(c.delta>0?"+":"")+pct(c.delta)
  ]);
}
function refreshReceivingFindings(checks){
  const generated=[];
  for(const {inv,row,index,matrix,delta} of checks){
    if(!matrix||Math.abs(delta)+1e-9<5)continue;
    const source="receiving.invoice."+inv.id;
    const higher=delta>0;
    const date=inv.date?" от "+ruDate(inv.date):"";
    const invoiceLabel=(inv.number?" № "+inv.number:"")+date;
    generated.push({id:source+"."+index+"."+matrix.price,src:source,sec:"receiving",
      title:`${row.pos}: цена ${higher?"выше":"ниже"} матрицы на ${pct(Math.abs(delta))}`,
      detail:`${inv.supplier}, накладная${invoiceLabel}: ${exactMoney(row.price)} за ${row.unit}, в матрице ${exactMoney(matrix.price)}. Разница по строке ${exactMoney(Math.abs(cents((row.price-matrix.price)*row.qty))/100)}.`,
      solution:higher?"Запросить у поставщика пересчёт по договорной цене.":"Проверить, актуальна ли цена в матрице.",
      value:(higher?"+":"")+pct(delta),
      req:higher?`Добрый день! В накладной${invoiceLabel} цена на ${row.pos} — ${exactMoney(row.price)} за ${row.unit}. По нашей договорённости цена ${exactMoney(matrix.price)}. Прошу проверить и сделать пересчёт. Спасибо.`:""});
  }
  const ids=new Set(generated.map(f=>f.id));
  S.findings=S.findings.filter(f=>{
    if(ids.has(f.id))return false;
    return f.src!=="receiving.invoice"&&!String(f.src).startsWith("receiving.invoice.")||!open(f);
  }).concat(generated);
  if(sheet?.id&&!findings().some(f=>f.id===sheet.id))sheet=null;
}
function storeMatrix(rows,date){
  const names=new Map(Object.keys(S.data.prices).map(p=>[receiveKey(p),p]));
  const changes=new Map(), labels=new Map();
  for(const row of rows){
    const key=receiveKey(row.pos);
    const previous=changes.get(key)||S.data.prices[names.get(key)];
    if(previous){
      const previousUnit=receiveUnit(previous.unit), nextUnit=receiveUnit(row.unit);
      const previousSupplier=receiveKey(previous.supplier), nextSupplier=receiveKey(row.supplier);
      if((previousUnit&&nextUnit&&previousUnit!==nextUnit)||(previousSupplier&&nextSupplier&&previousSupplier!==nextSupplier)){
        throw new Error(`«${row.pos}»: для позиции уже есть другая единица или поставщик. В текущей матрице можно хранить одну цену на позицию.`);
      }
      if(changes.has(key)&&previous.price!==row.price)throw new Error(`«${row.pos}»: в файле указаны разные цены на одну позицию.`);
    }
    if(!labels.has(key))labels.set(key,row.pos);
    changes.set(key,{price:row.price,unit:row.unit||previous?.unit||"",supplier:row.supplier||previous?.supplier||"",date,
      ...(row.taxBasis?{taxBasis:row.taxBasis}:{})});
  }
  const prices={...S.data.prices};
  for(const [key,value] of changes)Object.defineProperty(prices,names.get(key)||labels.get(key),{value,enumerable:true,writable:true,configurable:true});
  S.data.prices=prices;
  refreshReceivingFindings(invoiceChecks());
  return changes.size;
}

function matrixBlock(){
  const keys=Object.keys(S.data.prices);
  return `<div class="sec"><div class="between"><div class="row"><h2>Матрица цен</h2>${q("matrix")}</div><span class="muted">${keys.length?keys.length+" позиций":""}</span></div>
   ${keys.length?`<div class="list">${keys.map(k=>`<div class="li"><div><b>${esc(k)}</b><span class="muted">${esc([S.data.prices[k].supplier,S.data.prices[k].unit].filter(Boolean).join(" · ")||"Единица и поставщик не указаны")}</span></div><span class="val n">${exactMoney(S.data.prices[k].price)}</span></div>`).join("")}</div>`:`<div class="card"><p class="muted">Матрица пуста. Загрузите таблицу или добавьте позиции вручную.</p></div>`}
   <div class="row"><input class="in" id="mx-pos" placeholder="Позиция" aria-label="Позиция"><input class="in qty" id="mx-price" placeholder="Цена" inputmode="decimal" aria-label="Цена"></div><div class="row"><input class="in" id="mx-supplier" placeholder="Поставщик" aria-label="Поставщик"><input class="in qty" id="mx-unit" placeholder="Единица" aria-label="Единица"></div>
   <label class="row"><input type="checkbox" id="mx-tax-gross"> Цена с НДС</label>
   <button class="btn s" data-a="mxadd" style="align-self:flex-start">Сохранить цену</button></div>`;
}

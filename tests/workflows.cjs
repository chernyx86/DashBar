const vm=require("node:vm");
const fs=require("node:fs");
const assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const xlsx=require(path.join(root,"assets/xlsx.full.min.js"));
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const standalone=process.env.DASHBAR_STANDALONE&&fs.readFileSync(process.env.DASHBAR_STANDALONE,"utf8");
const js=standalone?[...standalone.matchAll(/<script>([\s\S]*?)<\/script>/g)].slice(1).map(m=>m[1]).join("\n"):
  [...html.matchAll(/src="\.\/(modules\/[^"]+)"/g)].map(m=>fs.readFileSync(path.join(root,m[1]),"utf8")).join("\n");
const storage=new Map();
const test=(seed,options={})=>{
  if(seed)storage.set("barmanager-proto-v2",JSON.stringify(seed));
  const elements=new Map(), events={}, appEvents={}, toasts=[];
  const make=()=>({value:"",scrollTop:0,classList:{add(){},remove(){}},appendChild(){},click(){},remove(){},querySelector(){return null;}});
  const get=id=>{if(!elements.has(id))elements.set(id,make());return elements.get(id);};
  const document={getElementById:get,documentElement:{classList:make().classList,getAttribute(){return "";},hasAttribute:name=>name==="data-standalone"&&options.standalone===true},querySelector(){return null;},createElement:make,body:make()};
  document.body.appendChild=element=>{if(element.className==="toast")toasts.push(element.textContent);};
  get("app").addEventListener=(type,cb)=>appEvents[type]=cb;
  const sandbox={
    document,XLSX:xlsx,window:{XLSX:xlsx, addEventListener:(type,cb)=>events[type]=cb},location:{hash:"",protocol:options.protocol||"https:"},history:{replaceState(){}},
    localStorage:{getItem:k=>{if(options.restricted)throw new DOMException("Storage disabled","SecurityError");return storage.get(k);},setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    confirm:()=>true,setTimeout:(f,ms)=>{if(ms===180)f();},TextDecoder,TextEncoder,Blob,File,URL,AbortSignal,DOMException,FormData:class {constructor(form){this.data=new Map(Object.entries(form.values));} get(k){return this.data.get(k);} has(k){return this.data.has(k);} [Symbol.iterator](){return this.data[Symbol.iterator]();}},FileReader:class {
      readAsText(file){this.result=file.text;this.onload();}
    }, console,
  };
  const context=vm.createContext(sandbox);
  vm.runInContext(js,context,{filename:"index.html"});
  return {get,events,appEvents,context,toasts,run:code=>vm.runInContext(code,context),state:()=>JSON.parse(storage.get("barmanager-proto-v2")),body:()=>get("app").innerHTML};
};
const header='"Позиция";"Количество";"Цена";"Сумма";"Единица";"Поставщик";"Дата";"Номер накладной"';
const good=(number,date="20.11.2026",price="101,25",sum="202,50",unit="кг",supplier="Фрукты")=>header+'\nЯблоко;2;'+price+';'+sum+';'+unit+';'+supplier+';'+date+';'+number+'\nИтого;;;'+sum;
(async()=>{
assert.match(html,/<title>DashBar/);
let t=test();
assert.match(t.body(),/DashBar/);
const text=x=>assert.match(t.body(),x);
const upload=async(d,n,content)=>{t.context.upload={name:n,type:n.endsWith("tsv")?"text/tab-separated-values":"text/csv",arrayBuffer:async()=>Buffer.isBuffer(content)?content:Buffer.from(content)};await t.run('handleFile(Object.keys(EXPECT).includes("'+d+'")?({rest:"stock",ttk:"cards",sales:"reports",inv:"stock"}["'+d+'"]||"receiving"):"receiving","'+d+'",upload)');};
t.run("A.demo()");
assert.equal(t.run("S.mode"),"demo");
t.run('A.tab({t:"receiving"})');text(/Фрукты и зелень/);
t.run('A.tab({t:"stock"});A.count();A.close();A.home();A.own();A.next({s:"venue"});A.next({s:"three"})');
t.run('S.user.name="  ";S.venue.name="Проверка";A.pick({n:"ans.problem",v:"Накладные и цены"});A.pick({n:"ans.system",v:"iiko"});A.enter();A.tab({t:"receiving"})');
assert.equal(t.run("sheet"),null);
await upload("invoice","a.csv",good("A"));text(/В реестре сохранено 1 строк/);
await upload("invoice","b.csv",good("B","21.11.2026","104","208","л"));text(/В реестре сохранено 1 строк/);
await upload("invoice","copy.csv",good("A"));text(/уже есть в реестре/);
await upload("invoice","bad.csv",good("C","22.11.2026","101","302"));text(/проверьте количество и сумму/);
await upload("invoice","total.csv",good("C").replace("Итого;;;202,50","Итого;;;203,50"));text(/Итог файла не сходится/);
await upload("invoice","date.csv",good("C","31.11.2026"));text(/Некорректная дата/);
await upload("invoice","wrong.csv","Позиция;Учёт;Факт\nЯблоко;2;3");text(/Распознан другой тип/);
assert.equal(t.state().data.invoices.length,2);
assert.equal(t.state().sec.receiving.docs.invoice.name,"b.csv");
await upload("matrix","matrix.tsv","Позиция\tЦена\tЕдиница\tПоставщик\nяблоко\t90,20\tкг\tФРУКТЫ");text(/Накладные пересверены/);
assert.equal(t.state().findings.filter(x=>x.sec==="receiving").length,1);
text(/Сверено 1 из 2 строк/);
text(/Ожидает прихода · b\.csv/);
t.run('A.tocal({id:S.findings[0].id});A.calpick({id:S.findings[0].id,i:0})');
const id=t.state().findings[0].id;
assert.equal(t.state().st[id].status,"cal");
t.run('A.tab({t:"reports"});A.report({k:"r_reg"})');text(/Фрукты/);
t.run('A.tab({t:"ai"})');await t.run('sendChat("Есть отклонения по ценам?")');text(/101,25 ₽/);
t.run('A.settings()');assert.equal(t.run("tabs().length"),6);
assert.doesNotMatch(t.body(),/data-a="viewas"|data-a="invite"/);
t.run('A.close();A.tab({t:"receiving"})');
await upload("invoice","c.csv",good("C","22.11.2026","110","220","кг","Другой"));text(/В реестре сохранено/);
assert.equal(t.state().findings.filter(x=>x.sec==="receiving").length,1);
t.run('A.tab({t:"stock"});A.close()');
await upload("rest","stock.csv","Позиция;Остаток;Единица\nЯблоко;4;кг");text(/Остатки: 1 позиций/);
t.run('A.count();S.draft.rows["Яблоко"]="1,5 кг";A.invsave()');
assert.equal(t.state().data.counts.length,0);
t.appEvents.input({target:{dataset:{inv:"Яблоко"},value:"1,5"}});
t.run("A.close()");t=test();t.run("A.count()");
assert.equal(t.state().draft.rows["Яблоко"],"1,5");
t.run("A.invsave()");assert.equal(t.state().data.stock["Яблоко"].qty,1.5);
t.get("ord-new").value="Яблоко, кг";t.run("A.ordadd()");
t.appEvents.input({target:{dataset:{ord:"0"},value:"2x"}});
assert.equal(t.run("orderText()"),"");
t.appEvents.input({target:{dataset:{ord:"0"},value:"2,5"}});
assert.match(t.run("orderText()"),/2,5/);
t.run('A.tab({t:"cards"});A.close()');
await upload("ttk","ttk.csv","Позиция;Брутто;Выход\nСироп;2;1,5");text(/Техкарта: 1 строк/);
t.run('A.tab({t:"today"});A.eventnew()');
t.get("ev-title").value="Заказ льда";
t.get("ev-date").value=t.run("todayISO()");
t.run('A.evrep({v:"week"})');text(/value="Заказ льда"/);
t.run("A.evsave()");text(/Заказ льда/);
assert.equal(t.run('eventsOn(S.cal.at(-1).iso).filter(e=>e.title==="Заказ льда").length'),1);
assert.equal(t.run('(()=>{const d=new Date(S.cal.at(-1).iso);d.setUTCDate(d.getUTCDate()+7);return eventsOn(d.toISOString().slice(0,10)).filter(e=>e.title==="Заказ льда").length})()'),1);
t.run('A.settings();importBackup({text:JSON.stringify({data:{invoices:[null]},step:"app"})})');
assert.equal(t.state().data.invoices.length,3);
const copy=JSON.stringify(t.state());
t.context.backup={text:copy};t.run("importBackup(backup)");
assert.equal(t.state().data.counts.length,1);
t.run('A.home();A.demo();A.tab({t:"stock"});S.order=[];save();A.home();A.own()');
assert.equal(t.state().order[0].qty,"2,5");
t.run('A.tab({t:"receiving"})');
const lines=Array.from({length:2500},(_,i)=>'Позиция '+i+';1;100;100;шт;Поставщик;23.11.2026;LARGE');
const start=performance.now();
await upload("invoice","large.csv",header+'\n'+lines.join('\n')+'\nИтого;;;250000');text(/В реестре сохранено 2500 строк/);
const ms=Math.round(performance.now()-start);
assert.equal(t.state().data.invoices.at(-1).rows.length,2500);
assert.equal(t.state().data.invoices.at(-1).sum,250000);
t=test();assert.equal(t.state().data.invoices.length,4);
assert.equal(t.run('readNumber("1 234 567,89 ₽")'),1234567.89);
assert.equal(t.run('parseDoc(parseCSV("Позиция;Сумма;Причина\\nЯблоко;240;порча"),"writeoff").type'),"writeoff");
assert.equal(t.run('parseDoc(parseCSV("Причина;Сумма\\nПорча;240"),"writeoff").type'),"writeoff");
t.run('A.tab({t:"reports"});A.close()');
await upload("sales","sales.csv","Позиция;Количество;Сумма\nЯблочный сок;2;500");
text(/Продажи: 1 позиций/);
assert.doesNotMatch(t.run("vToday()"),/≈ 24,6%/);
await upload("inv","inventory.csv","Позиция;Учёт;Факт;Единица\nБез цены;2;1;кг\nЯблоко;2;3;кг");
assert.equal(t.state().data.counts[0].short,0);
assert.equal(t.state().data.counts[0].unpriced,1);
assert.equal(t.run("possibleResort(S.data.counts[0])"),false);
t.run('A.tab({t:"receiving"})');
const persist=t.context.localStorage.setItem;
t.context.localStorage.setItem=()=>{throw new Error("QuotaExceededError");};
await upload("invoice","quota.csv",good("NEXT"));
text(/Не удалось сохранить данные в браузере/);
assert.equal(t.run("S.data.invoices.length"),4);
assert.equal(t.state().data.invoices.length,4);
t.context.localStorage.setItem=persist;
const legacy=t.state();
legacy.data.invoices=[{id:"old",src:"receiving.invoice",date:"2026-10-02",supplier:"Фрукты",status:"получена",sum:220,rows:[{pos:"Яблоко",qty:2,unit:"кг",price:110,sum:220}]}];
legacy.tab="receiving";
t=test(legacy);
text(/2 окт/);
await upload("invoice","new.csv",good("NEW"));
assert.equal(t.state().data.invoices.length,2);
t.run('A.receivingsources()');
text(/Папка Google Drive/);text(/Google Таблица/);text(/Прямая ссылка на файл/);
const calls=[];
const queue=[{id:1,name:"outer.csv",source:"drive"},{id:2,name:"bad.csv",source:"sheets"}];
t.context.fetch=async (url,opts)=>{
  calls.push({url,auth:opts.headers?.Authorization});
  if(url==="/api/intake")return Response.json({documents:queue});
  if(url==="/api/intake/documents/1")return new Response(good("QUEUE"),{headers:{"content-type":"application/octet-stream"}});
  if(url==="/api/intake/documents/2")return new Response(good("WRONG","20.11.2026","101","300"),{headers:{"content-type":"application/octet-stream"}});
  if(url.endsWith("/reviewed"))return Response.json({ok:true});
  if(url==="https://service.invalid/export.csv"){
    assert.equal(opts.credentials,"omit");
    return new Response(good("DIRECT"),{headers:{"content-type":"text/csv"}});
  }
  throw new Error("Unexpected fetch "+url);
};
const submit=async (f,values,id)=>{t.context.testForm={dataset:{f,id},values,reset(){}};await t.run("submitIncoming(testForm)");};
await submit("connectintake",{token:"test-fixture"});
assert.equal(t.run("incoming.queue.length"),2);
await submit("importqueue",{kind:"invoice"},"2");
assert.match(t.run("incoming.notice"),/проверьте количество и сумму/);
assert.equal(t.run("incoming.queue.length"),2);
assert.ok(!calls.some(c=>c.url.endsWith("/2/reviewed")));
await submit("importqueue",{kind:"invoice"},"1");
assert.equal(t.run("incoming.queue.length"),1);
assert.ok(calls.some(c=>c.url.endsWith("/1/reviewed")));
await submit("directintake",{kind:"invoice",link:"https://service.invalid/export.csv"});
assert.equal(t.run("incoming.notice"),"Документ по ссылке загружен.");
assert.ok(!calls.find(c=>c.url==="https://service.invalid/export.csv").auth);
assert.equal(t.state().data.invoices.length,4);
t.run('S.ans.problem="Накладные и цены";S.ans.access="Выгрузки через бухгалтера";S.ans.flow=["Бумажные накладные"];S.data.invoices=[];A.tab({t:"today"})');
text(/Запросите выгрузку у бухгалтера/);text(/бумажной накладной/);
t.run('S.ans.problem="Техкарты и себестоимость";S.sec.cards.q.where="На бумаге";S.sec.cards.q.prep="Да";render()');
text(/Перенесите карту в таблицу/);text(/Для заготовок укажите выход замеса/);
t.run('S.ans.problem="Заказы поставщикам";render()');text(/Проверить заказ/);
t.run('S.ans.problem="Инвентаризация и расхождения";S.sec.stock.q.freq="Раз в месяц";render()');text(/Плановый ориентир/);
assert.equal(t.run('scheduleCount("2026-01-31",[0,1])'),"2026-02-28");
t.run('A.survey();A.pick({n:"ans.access",v:"Доступа нет"});A.close()');
t=test();assert.equal(t.state().ans.access,"Доступа нет");
assert.equal(t.state().sec.cards.q.where,"На бумаге");
const batch=test({mode:"own",step:"app",tab:"receiving",ans:{problem:"Накладные и цены",system:"iiko"}});
const queueItems=Array.from({length:51},(_,i)=>({id:i+1,name:"invoice-"+(i+1)+".csv",source:"external"}));
const reviewed=new Set();
const bodyFor=(id,bad=false)=>header+"\n"+Array.from({length:50},(_,row)=>
  [row===0&&id===50?"Сироп бузины":"Товар "+(row+1),1,100,bad&&row===0?500:100,"шт",id%2===0?"Ёлка":"Линия","20.11.2026","B-"+id].join(";")
).join("\n")+"\nИтого;;;5000";
batch.context.fetch=async(url,options)=>{
  assert.equal(options.headers.Authorization,"Bearer batch-fixture");
  if(url==="/api/intake"){
    const pending=queueItems.filter(item=>!reviewed.has(item.id));
    return Response.json({documents:pending.slice(0,25),next_cursor:pending.length>25?pending[24].id:null});
  }
  if(url.startsWith("/api/intake?after_id=")){
    const cursor=Number(url.split("=").at(-1));
    const pending=queueItems.filter(item=>item.id>cursor&&!reviewed.has(item.id));
    return Response.json({documents:pending,next_cursor:null});
  }
  const match=url.match(/^\/api\/intake\/documents\/(\d+)(\/reviewed)?$/);
  assert.ok(match,url);
  const id=Number(match[1]);
  if(match[2]){
    assert.equal(options.method,"POST");
    reviewed.add(id);
    return Response.json({ok:true});
  }
  return new Response(bodyFor(id,id===51),{headers:{"content-type":"application/octet-stream"}});
};
const sendBatch=async(f,values,id)=>{
  batch.context.form={dataset:{f,id:id?String(id):undefined},values,reset(){}};
  await batch.run("submitIncoming(form)");
};
batch.run("A.receivingsources()");
await sendBatch("connectintake",{token:"batch-fixture"});
assert.match(batch.run("incomingQueue()"),/Показать следующие документы/);
await batch.run("A.queuemore()");
assert.equal(batch.run("incoming.queue.length"),51);
const batchStart=performance.now();
for(let id=1;id<=51;id++)await sendBatch("importqueue",{kind:"invoice"},id);
const batchTime=Math.round(performance.now()-batchStart);
assert.equal(reviewed.size,50);
assert.equal(batch.state().data.invoices.length,50);
assert.equal(batch.state().data.invoices.reduce((n,i)=>n+i.rows.length,0),2500);
assert.deepEqual(JSON.parse(batch.run("JSON.stringify(incoming.queue.map(x=>x.id))")),[51]);
assert.match(batch.run("incoming.notice"),/проверьте количество и сумму/);
batch.run("A.close()");
assert.doesNotMatch(batch.body(),/data-doc="invoice"/);
assert.match(batch.body(),/Накладных: 50/);
assert.equal((batch.body().match(/data-invoice-id=/g)||[]).length,25);
batch.run("A.invoicemore()");
assert.equal((batch.get("invoice-results").innerHTML.match(/data-invoice-id=/g)||[]).length,50);
batch.appEvents.input({target:{id:"invoice-search",value:"елка бузины",dataset:{}}});
assert.match(batch.get("invoice-results").innerHTML,/Найдено: 1 из 50/);
assert.match(batch.get("invoice-results").innerHTML,/B-50/);
assert.doesNotMatch(batch.get("invoice-results").innerHTML,/<table/);
const holder={firstChild:null};
batch.appEvents.toggle({target:{open:true,dataset:{invoiceId:batch.state().data.invoices[49].id},querySelector:()=>holder}});
assert.match(holder.innerHTML,/Сироп бузины/);
batch.appEvents.input({target:{id:"invoice-search",value:"нет такого",dataset:{}}});
assert.match(batch.get("invoice-results").innerHTML,/Ничего не найдено/);
for(const invoice of batch.state().data.invoices.slice(0,10)){
  batch.context.receiptId=String(invoice.id);
  batch.run("postReceipt(receiptId);postReceipt(receiptId)");
}
assert.equal(batch.state().data.receipts.length,10);
assert.equal(batch.run('effectiveStock()["Товар 1"].qty'),10);
assert.equal(test().run('effectiveStock()["Товар 1"].qty'),10);
batch.run('S.data.stock["Пустая полка"]={qty:0,unit:"шт"};S.data.sales=[];A.tab({t:"ai"})');
assert.match(batch.run('localAnswer("Что заканчивается?")'),/Пустая полка.*проверьте наличие/);
assert.match(batch.run('localAnswer("Что заканчивается?")'),/Загрузите продажи/);
assert.doesNotMatch(batch.body(),/name="external"/);
batch.run('incoming.assistantAvailable=true;render()');
assert.match(batch.body(),/Использовать внешний ИИ для этого вопроса/);
assert.equal((batch.body().match(/<button[^>]*>Спросить<\/button>/g)||[]).length,1);
let aiRequests=0;
batch.context.fetch=async (url,options)=>{
  aiRequests++;
  assert.equal(url,"/api/intake/assistant");
  const payload=JSON.parse(options.body);
  assert.equal(payload.question,"Что заканчивается?");
  assert.equal(payload.context.invoices,50);
  assert.ok(!options.body.includes("Пустая полка"));
  return Response.json({answer:"Сверьте дефицит с последней инвентаризацией."});
};
const submitChat=batch.appEvents.submit;
batch.get("chat-in").value="Что заканчивается?";
submitChat({target:{dataset:{f:"chat"},elements:{external:{checked:false}}},preventDefault(){}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(aiRequests,0);
batch.get("chat-in").value="Что заканчивается?";
submitChat({target:{dataset:{f:"chat"},elements:{external:{checked:true}}},preventDefault(){}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(aiRequests,1);
assert.match(batch.body(),/Ответ внешнего ИИ/);
assert.match(batch.body(),/Пустая полка/);
batch.context.fetch=async ()=>new Response("Unavailable",{status:502});
await batch.run('sendChat("Что заканчивается?",true)');
assert.match(batch.body(),/Внешний ИИ недоступен/);
console.log("PASS: 10 receipts post exactly once; assistant opt-in, data limits, stockout and fallback");
console.log("PASS queue batch: 50 valid invoices × 50 rows, one invalid retained; search, lazy details, register pagination ("+batchTime+" ms in JS harness)");

t.run('S.venue.stockName="Напитки";S.data.stock={};S.data.counts=[];S.draft=null;delete S.sec.stock.docs.rest;A.tab({t:"stock"});A.close()');
const uploadBook=async(doc,name,cols,rows)=>{
  const workbook=xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([...cols,...rows]),name);
  t.context.example=new File([xlsx.write(workbook,{type:"buffer",bookType:"xlsx"})],name+".xlsx");
  return t.run('handleFile("stock","'+doc+'",example)');
};
assert.equal(await uploadBook("rest","Склад",[["Остатки на складах"],["На 28.10.2026"],["Название товара","Ед. изм.","Напитки","Кухня","Итого"]],[["Сироп","л",4,99,103]]),"preview");
await t.run("commitWorkbookPreview()");
assert.equal(t.state().data.stock["Сироп"].qty,4);
assert.equal(await uploadBook("inv","Факт",[["Бланк инвентаризации"],["На дату:","","28.10.2026"],["Склад","","Напитки"],["Товар","","","","","Ед. изм.","Остаток фактический"],["Код","","","Наименование"]],[["TEST","","","Сироп","","л",0]]),"preview");
text(/Совпали с учётом по названию и единице: 1/);
await t.run("commitWorkbookPreview()");
assert.equal(t.state().draft.rows["Сироп"],"0");
assert.equal(t.state().draft.reference["Сироп"].qty,4);
t.run('A.invsave()');
assert.equal(t.state().data.counts[0].rows[0].book,4);
assert.equal(t.state().data.counts[0].rows[0].fact,0);
assert.equal(t.state().data.stock["Сироп"].qty,4);
t.run('A.tab({t:"reports"})');
for(const key of JSON.parse(t.run('JSON.stringify(REPORTS.flatMap(g=>g[2].map(r=>r[0])))'))){t.run('A.report({k:"'+key+'"});A.close()');}
await upload("inv","count-source.csv","Позиция;Учёт;Факт;Единица\nТоник;4;3;шт");
assert.match(t.run('localAnswer("Расхождения инвентаризации")'),/count-source\.csv, строка 2/);
assert.match(t.run('localAnswer("Расхождения инвентаризации")'),/учёт 4 шт, факт 3 шт/);
t.run('S.data.stock={"Сироп":{qty:4,unit:"л"},"Тоник":{qty:0,unit:"шт"},"Лёд":{qty:2,unit:"кг"}}');
const usageCSV="Период с 22.10.2026 по 28.10.2026\nПозиция;Количество;Единица;Сумма;Категория\nСироп;14;л;700;Бар\nСироп;40;л;100;Кухня\nЛёд;14;шт;140;Бар";
await upload("sales","period.csv",usageCSV);
assert.equal(t.run('dailyUse("Сироп","л")'),2);
assert.equal(t.run('dailyUse("Лёд","кг")'),null);
assert.equal(t.run('JSON.stringify(computeReport("r_rest").rows.find(row=>row[0]==="Сироп"))'),'["Сироп","4 л","2"]');
assert.equal(t.run('computeReport("r_rest").rows.find(row=>row[0]==="Лёд")[2]'),"—");
assert.match(t.run("lowStockBlock()"),/period\.csv/);
assert.match(t.run("lowStockBlock()"),/нулевой остаток/);
assert.equal(t.run('suggestOrder()[0].qty'),10);
t.run('S.sec.stock.docs.rest.res.snapshot.date="2026-10-27"');
assert.equal(t.run('dailyUse("Сироп","л")'),null);
assert.match(t.run("lowStockBlock()"),/старше отчёта/);
assert.match(t.run('computeReport("r_rest").note'),/старше отчёта/);
assert.equal(t.run("suggestOrder().length"),0);
await upload("sales","undated.csv",usageCSV.split("\n").slice(1).join("\n"));
assert.equal(t.run('dailyUse("Сироп","л")'),null);
assert.match(t.run("lowStockBlock()"),/Для расчёта нужен период/);
console.log("PASS: actual sales period, unit and category compatibility, stale and missing evidence");
const recovery=test({mode:"own",step:"app",tab:"stock",venue:{name:"Исходный бар"},
  draft:{date:"2026-11-20",rows:{Тоник:"0"}},data:{stock:{Тоник:{qty:4,unit:"шт"}}}});
recovery.run("A.count()");
const beforeRecovery=recovery.state(), storeProfile=recovery.context.localStorage.setItem;
recovery.context.localStorage.setItem=()=>{throw new Error("QuotaExceededError");};
recovery.run("A.invsave()");
assert.equal(recovery.run("S.data.stock.Тоник.qty"),4);
assert.equal(recovery.run("S.data.counts.length"),0);
assert.equal(recovery.run("sheet.t"),"inv");
assert.equal(recovery.run("S.draft.rows.Тоник"),"0");
assert.match(recovery.toasts.at(-1),/Не удалось сохранить/);
recovery.context.backup={text:JSON.stringify({...beforeRecovery,venue:{...beforeRecovery.venue,name:"Новый бар"}})};
recovery.run("importBackup(backup)");
assert.match(recovery.toasts.at(-1),/Прежние данные сохранены/);
assert.equal(recovery.run("S.venue.name"),"Исходный бар");
assert.deepEqual(recovery.state(),beforeRecovery);
const stockFile="На дату: 21.11.2026\nПозиция;Количество;Единица\nТоник;9;шт";
recovery.context.stockFile={name:"stock.csv",type:"text/csv",arrayBuffer:async()=>Buffer.from(stockFile)};
assert.equal(await recovery.run('handleFile("stock","rest",stockFile)'),undefined);
assert.equal(recovery.run("S.data.stock.Тоник.qty"),4);
assert.match(recovery.run("S.sec.stock.docs.rest.err"),/Не удалось сохранить/);
recovery.context.localStorage.setItem=storeProfile;
assert.equal(await recovery.run('handleFile("stock","rest",stockFile)'),true);
assert.equal(recovery.state().data.stockReference.snapshot.date,"2026-11-21");
assert.equal(recovery.state().data.stockReference.stock.Тоник.qty,9);
recovery.run("A.invsave()");
assert.equal(recovery.state().data.counts.length,1);
assert.equal(recovery.state().data.counts[0].rows[0].fact,0);
assert.equal(recovery.state().data.counts[0].rows[0].book,null);
recovery.run("importBackup(backup)");
assert.equal(recovery.state().venue.name,"Новый бар");
let pendingRead;
recovery.context.FileReader=class {readAsText(file){this.result=file.text;pendingRead=()=>this.onload();}};
recovery.run("importBackup(backup);A.demo()");
pendingRead();
assert.match(recovery.toasts.at(-1),/Профиль изменился/);
recovery.run("A.home();A.own()");
assert.equal(recovery.state().venue.name,"Новый бар");
console.log("PASS: storage failure rollback for inventory, CSV and backup; retry and safe demo isolation");

const countDate=test({mode:"own",step:"app",tab:"stock",venue:{name:"Бар"},
  ans:{system:"iiko"}});
countDate.context.stockFile={name:"stock.csv",type:"text/csv",
  arrayBuffer:async()=>Buffer.from("На дату: 28.10.2026\nПозиция;Количество;Единица\nТоник;9;шт")};
assert.equal(await countDate.run('handleFile("stock","rest",stockFile)'),true);
countDate.run("A.count()");
const today=countDate.run("todayISO()");
assert.ok(countDate.body().includes('max="'+today+'"'));
countDate.appEvents.input({target:{dataset:{invd:"1"},value:"2099-12-31"}});
countDate.appEvents.input({target:{dataset:{inv:"Тоник"},value:"2"}});
const beforeCount=countDate.state();
countDate.run("A.invsave()");
assert.match(countDate.toasts.at(-1),/не может быть в будущем/);
assert.deepEqual(countDate.state(),beforeCount);
assert.equal(countDate.run("S.data.stock.Тоник.qty"),9);
assert.equal(countDate.run("S.data.counts.length"),0);
assert.equal(countDate.run("sheet.t"),"inv");
const receiptFile=header+"\nТоник;1;100;100;шт;Поставщик;"+today+";COUNT-DATE";
countDate.context.receiptFile={name:"receipt.csv",type:"text/csv",arrayBuffer:async()=>Buffer.from(receiptFile)};
await countDate.run('handleFile("receiving","invoice",receiptFile)');
countDate.run("postReceipt(String(S.data.invoices[0].id));postReceipt(String(S.data.invoices[0].id))");
assert.equal(countDate.state().data.receipts.length,1);
assert.equal(countDate.run('effectiveStock().Тоник.qty'),10);
countDate.run('A.close();A.tab({t:"reports"})');
assert.match(countDate.body(),/Напомнить о выгрузке из iiko/);
countDate.run("A.reportreminder()");
assert.match(countDate.body(),/Выгрузить продажи и остатки из iiko/);
countDate.get("ev-title").value="Выгрузить продажи и остатки из iiko";
countDate.get("ev-date").value=today;
countDate.run('A.evrep({v:"week"});A.evsave()');
assert.equal(countDate.state().cal.at(-1).rep,"week");
assert.equal(countDate.run("eventsOn(todayISO()).some(event=>event.title.includes('iiko'))"),true);
console.log("PASS: future count keeps draft and stock, receipt posts once, iiko calendar reminder");

const pilot=test({mode:"own",step:"app",tab:"stock",venue:{name:"Петровка",stockName:"Бар (Петровка)"},ans:{system:"iiko"}});
const pilotUpload=(sec,doc,name,tabs)=>{
  const workbook=xlsx.utils.book_new();
  for(const [title,rows] of tabs)xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet(rows),title);
  pilot.context.pilotFile={name,arrayBuffer:async()=>xlsx.write(workbook,{type:"array",bookType:"xlsx"})};
  return pilot.run(`handleFile("${sec}","${doc}",pilotFile)`);
};
assert.equal(await pilotUpload("stock","rest","Остатки.xlsx",[["Остатки",[
  ["Остатки на складах"],["На 28.10.2026"],[],
  ["Артикул","Название товара","Ед. измерения","Бар (Петровка)","Итого"],
  ["100","Тоник","шт",9,90],["200","Биттер","л",1,5]
]]]),"preview");
await pilot.run("A.importpreview()");
assert.equal(await pilotUpload("stock","inv","Пересчёт.xlsx",[
  ["Товары",[[],[null,null,null,"Ед. изм.","Бар","Склад","Всего"],["Артикул","Наименование"],
    ["100","Тоник новый","шт","шт",0,5,5],["200","Биттер",null,"л",null,3,3]]],
  ["Блюда,Заготовки",[["Бланк инвентаризации"],["На дату:",null,"26.10.2026"]]]
]),"preview");
pilot.appEvents.change({target:{dataset:{countDate:""},value:"2026-10-26"}});
pilot.appEvents.change({target:{dataset:{countWarehouse:""},checked:true}});
await pilot.run("A.importpreview()");
assert.equal(pilot.run("S.draft"),null);
pilot.appEvents.change({target:{dataset:{countDate:""},value:"2026-10-28"}});
await pilot.run("A.importpreview()");
assert.deepEqual(pilot.state().draft.rows,{"Тоник":"0"});
pilot.run("A.invsave()");
const count=pilot.state().data.counts[0];
assert.equal(count.date,"2026-10-28");
assert.equal(count.formDate,"2026-10-26");
assert.equal(count.rows[0].book,9);
assert.equal(count.rows[0].fact,0);
assert.equal(count.rows[0].sources.fact.line,4);
assert.equal(count.rows[0].sources.book.line,5);
assert.equal(pilot.run('effectiveStock().Тоник.qty'),9);
pilot.context.pilotReceipt={name:"Приход.csv",type:"text/csv",arrayBuffer:async()=>Buffer.from(receiptFile)};
assert.equal(await pilot.run('handleFile("receiving","invoice",pilotReceipt)'),true);
pilot.run("postReceipt(String(S.data.invoices[0].id));postReceipt(String(S.data.invoices[0].id))");
assert.equal(pilot.state().data.receipts.length,1);
assert.equal(pilot.run('effectiveStock().Тоник.qty'),10);
pilot.run('A.tab({t:"reports"});A.reportreminder()');
pilot.get("ev-title").value="Выгрузить продажи и остатки из iiko";
pilot.get("ev-date").value=today;
pilot.run('A.evrep({v:"week"});A.evsave()');
assert.equal(pilot.state().cal.at(-1).rep,"week");
assert.equal(pilot.run("eventsOn(todayISO()).some(event=>event.title.includes('iiko'))"),true);

pilot.run('A.tab({t:"cards"})');
const cards=[["Классика",[
  ["Negroni"],[null,"Цедра",null,5],[],["Метод-Стир"],["Boulevardier"],
  [null,"Jim Beam",null,40],[null,"Ангостура",null,"3 ДЕШ (3 мл)"]
]],["ТК ПФ",[
  ["П/Ф","Ингредиенты","Объём"],["Сироп","Сахар","200гр"],[null,"Выход","1400 мл"]
]]];
assert.equal(await pilotUpload("cards","ttk","ТТК.xlsx",cards),"preview");
await pilot.run("A.importpreview()");
assert.equal(pilot.state().data.ttk.length,2);
assert.equal(pilot.state().data.ttk[1].rows[0].sourceLine,6);
assert.equal(pilot.state().data.ttk[1].rows[0].unit,"");
assert.equal(pilot.state().data.ttk[1].rows[1].unit,"мл");
pilot.get("recipe-unit-1-6").value="мл";
pilot.run('A.recipeunit({index:"1",line:"6"})');
assert.equal(pilot.state().data.ttk[1].rows[0].confirmedUnit,"мл");
await pilotUpload("cards","ttk","ТТК.xlsx",cards);
await pilot.run("A.importpreview()");
assert.equal(pilot.state().data.ttk.length,2);
assert.equal(pilot.state().data.ttk[1].rows[0].confirmedUnit,"мл");
await pilotUpload("cards","ttk","ТТК.xlsx",cards);
pilot.appEvents.change({target:{dataset:{uploadSelect:""},value:"1"}});
await pilot.run("A.importpreview()");
const syrup=pilot.state().data.ttk[2];
assert.equal(syrup.rows.length,1);
assert.equal(syrup.outputs[0].qty,1400);
assert.equal(syrup.outputs[0].unit,"мл");
console.log("PASS: split bar inventory, separate dates, row provenance, recipe units and reimport, prep yield");
const chain=test({mode:"own",step:"app",tab:"reports",venue:{name:"Сверка",stockName:"Бар (Сверка)"},set:{lowDays:5}},
  standalone?{standalone:true,protocol:"file:"}:{});
const chainUpload=(sec,doc,name,content)=>{
  chain.context.chainFile={name,arrayBuffer:async()=>Buffer.isBuffer(content)?content:Buffer.from(content)};
  return chain.run(`handleFile("${sec}","${doc}",chainFile)`);
};
const dateStock=date=>`На дату: ${date}\nПозиция;Остаток;Единица\nJim Beam;0,3;л\nСахар;1;кг`;
assert.equal(await chainUpload("stock","rest","Остатки-21.csv",dateStock("21.10.2026")),true);
chain.run("A.count()");
chain.appEvents.input({target:{dataset:{invd:"1"},value:"2026-10-21"}});
chain.appEvents.input({target:{dataset:{inv:"Jim Beam"},value:"0,3"}});
chain.appEvents.input({target:{dataset:{inv:"Сахар"},value:"1"}});
chain.run("A.invsave()");
assert.equal(chain.state().data.counts[0].warehouse,"Бар (Сверка)");
const bourbon=header+"\nJim Beam;0,2;1000;200;л;Поставщик;23.10.2026;OCT-23";
assert.equal(await chainUpload("receiving","invoice","Приход-23.csv",bourbon),true);
chain.run("postReceipt(String(S.data.invoices[0].id))");
assert.equal(chain.state().data.receipts.length,1);
assert.equal(await chainUpload("stock","rest","Остатки-28.csv",dateStock("28.10.2026").replace("0,3","0,25")),true);
const chainBook=xlsx.utils.book_new();
xlsx.utils.book_append_sheet(chainBook,xlsx.utils.aoa_to_sheet([
  ["Boulevardier"],[null,"Jim Beam",null,40],[null,"Сироп",null,"20 мл"]
]),"Классика");
xlsx.utils.book_append_sheet(chainBook,xlsx.utils.aoa_to_sheet([
  ["П/Ф","Ингредиенты","Объём"],["Сироп","Сахар","200 г"],[null,"Выход","1 л"]
]),"ТК ПФ");
const chainCards=xlsx.write(chainBook,{type:"buffer",bookType:"xlsx"});
await chainUpload("cards","ttk","Рабочие карты.xlsx",chainCards);
await chain.run("A.importpreview()");
await chainUpload("cards","ttk","Рабочие карты.xlsx",chainCards);
chain.appEvents.change({target:{dataset:{uploadSelect:""},value:"1"}});
await chain.run("A.importpreview()");
chain.run("A.count()");
chain.appEvents.input({target:{dataset:{invd:"1"},value:"2026-10-28"}});
chain.appEvents.input({target:{dataset:{inv:"Jim Beam"},value:"0,2"}});
chain.run("A.invsave()");
const chainSales="Период с 22.10.2026 по 28.10.2026\nБлюдо;Количество;Единица;Сумма;Категория\nBoulevardier;7;порция;700;Бар\nBoulevardier;100;порция;200;Кухня\nИтого;107;;900";
assert.equal(await chainUpload("reports","sales","Продажи.csv",chainSales),true);
assert.equal(chain.state().data.sales.length,2);
assert.equal(chain.run('dailyUse("Jim Beam","л")'),null);
assert.match(chain.run('computeReport("r_variance").issues[0][1]'),/строка 2.*дозировку и единицу/);
chain.get("recipe-unit-0-2").value="мл";
chain.run('A.recipeunit({index:"0",line:"2"})');
assert.equal(chain.run('Math.round(dailyUse("Jim Beam","л")*1000)'),40);
assert.equal(chain.run('Math.round(salesConsumption().totals.get("сахар")*1000)'),28);
assert.equal(chain.run('effectiveStock()["Jim Beam"].qty'),0.2);
assert.equal(chain.run('JSON.stringify(computeReport("r_variance").rows.find(row=>row[0]==="Jim Beam"))'),
  '["Jim Beam","0,28 л","0,2 л","0,25 л","0,22 л","-0,02 л"]');
chain.run('A.tab({t:"reports"});A.report({k:"r_variance"})');
assert.match(chain.body(),/Расчётный остаток/);
assert.match(chain.body(),/Рабочие карты.xlsx · Классика · строка 1/);
assert.match(chain.body(),/Сверьте полноту приходов, списания и перемещения/);
chain.run('A.close();A.tab({t:"stock"});A.ordsuggest()');
assert.equal(chain.state().order[0].pos,"Jim Beam");
await chainUpload("reports","sales","Продажи-неполные.csv",chainSales+"\nДругая позиция;1;порция;100;Бар");
assert.equal(chain.run('suggestOrder().length'),0);
assert.equal(chain.run('computeReport("r_variance").rows.find(row=>row[0]==="Jim Beam")[4]'),"—");
chain.run('A.tab({t:"reports"});A.report({k:"r_variance"})');
assert.match(chain.body(),/Проверить продажи/);
console.log("PASS: opening count, receipt, sales by portion, recipe unit confirmation, prep yield, closing count, order and reconciliation");


const appClick=(profile,action,fields={})=>{
  const target={dataset:{a:action,...fields},closest(){return this;}};
  return profile.appEvents.click({target,stopPropagation(){}});
};
const actionCount=(body,action)=>(body.match(new RegExp(`data-a="${action}"`,"g"))||[]).length;
appClick(chain,"tab",{t:"today"});
assert.match(chain.body(),/<main class="main page"/);
assert.match(chain.body(),/<nav[^>]*aria-label="Разделы"/);
assert.equal(actionCount(chain.body(),"tab"),6);
assert.equal(actionCount(chain.body(),"theme"),0);
assert.equal(actionCount(chain.body(),"survey"),0);
assert.equal(actionCount(chain.body(),"tocal"),0);
appClick(chain,"settings");
assert.equal(actionCount(chain.body(),"survey"),1);
appClick(chain,"settheme",{v:"dark"});
assert.equal(chain.state().theme,"dark");
chain.appEvents.keydown({key:"Escape",target:{getAttribute(){return null;}}});
assert.doesNotMatch(chain.body(),/role="dialog"/);
appClick(chain,"tab",{t:"receiving"});
assert.doesNotMatch(chain.body(),/role="dialog"/);
assert.equal(actionCount(chain.body(),"receivingsources"),1);
appClick(chain,"receivingsources");
assert.equal(actionCount(chain.body(),"syncintake"),0);
if(standalone){
  assert.doesNotMatch(chain.body(),/Ключ оператора сервера/);
  assert.match(chain.body(),/Прямая ссылка на файл/);
}
const connected=standalone?test({mode:"own",step:"app",tab:"receiving"}):chain;
if(standalone)appClick(connected,"receivingsources");
connected.run("incoming.connected=true;render()");
assert.equal(actionCount(connected.body(),"syncintake"),1);
assert.equal(actionCount(connected.body(),"refreshintake"),0);
const sourceRequests=[];
connected.context.fetch=async(url,opts)=>{
  sourceRequests.push([url,opts.method]);
  if(url.endsWith("/sync"))return Response.json({detail:"Сбой источника."},{status:503});
  return Response.json({documents:[],next_cursor:null});
};
connected.run('incoming.token="test-operator-token"');
await connected.run("A.syncintake()");
assert.deepEqual(sourceRequests,[["/api/intake/sync","POST"],["/api/intake","GET"]]);
assert.match(connected.run("incoming.notice"),/Очередь обновлена.*Сбой источника/);
appClick(chain,"tab",{t:"stock"});
assert.equal(actionCount(chain.body(),"count"),1);
assert.match(chain.body(),/Экспорт заказа/);
assert.equal(actionCount(chain.body(),"ordcopy"),1);
assert.equal(actionCount(chain.body(),"ordshare"),0);
appClick(chain,"count");
chain.appEvents.input({target:{dataset:{inv:"Jim Beam"},value:"0"}});
appClick(chain,"close");
assert.match(chain.body(),/Продолжить ввод/);
appClick(chain,"count");
assert.equal(chain.state().draft.rows["Jim Beam"],"0");
appClick(chain,"close");
appClick(chain,"tab",{t:"reports"});
assert.match(chain.body(),/<button class="li report-row" data-a="report" data-k="r_variance">/);
assert.match(chain.body(),/Себестоимость продаж<\/b><span class="muted">В разработке/);
assert.doesNotMatch(chain.body(),/data-a="report" data-k="r_(bevcost|turn)"/);
assert.equal(chain.run('JSON.stringify(computeReport("r_abc").rows)'), '[["A","1","87,5%"],["B","1","12,5%"],["C","0","0%"]]');
appClick(chain,"tab",{t:"ai"});
const messageCount=chain.state().chat.length;
appClick(chain,"sugg",{v:"Что заканчивается?"});
assert.equal(chain.get("chat-in").value,"Что заканчивается?");
assert.equal(chain.state().chat.length,messageCount);
appClick(chain,"tab",{t:"reports"});
appClick(chain,"report",{k:"r_variance"});
assert.match(chain.body(),/Проверить продажи/);
console.log("PASS: manager navigation, optional section questions, one refresh/decision/export entry, failure recovery, dark theme, draft and report");
const russian=test({mode:"own",step:"app",tab:"ai",ans:{system:"iiko"},data:{
  stock:{"Джин":{qty:-0.2,unit:"л"},"Лайм":{qty:0,unit:"кг"}},ttk:[{name:"Сироп",rows:[]}]
}});
const russianCases=[
  ["Что такое П/Ф?",/полуфабрикат или заготовка/],
  ["Расшифруй ОСВ",/оборотно-сальдовая ведомость/],
  ["Что значит бевкост?",/доля себестоимости/],
  ["Что такое пересорт?",/перенос остатка/],
  ["Какие минуса по инвенту?",/Инвентаризаций пока нет/],
  ["Что в минусе по остаткам?",/Отрицательные остатки:[\s\S]*Джин/],
  ["Что поставить в стоп-лист?",/Заканчивается:[\s\S]*Лайм/],
  ["Кто поднял закуп и где наклы?",/Отклонений цен/],
  ["Где выход П/Ф и граммовки в TTK?",/Загружено карт: 1/],
  ["Где проливы, бой и перемещения?",/акты[\s\S]*документы с количеством/],
  ["Мне нужна оборотка",/продажи за месяц/],
  ["Покажи факт и норму расхода",/Факт и норма/],
  ["Стоп и прайс",/Отклонений цен[\s\S]*Заканчивается/],
  ["Что с выручкой и ABC?",/Загрузите продажи/]
];
for(const [phrase,expected] of russianCases)assert.match(russian.run(`localAnswer(${JSON.stringify(phrase)})`),expected,phrase);
assert.doesNotMatch(russian.run('localAnswer("Минуса по остаткам")'),/Лайм/);

const offline=test(null,{standalone:true,protocol:"https:"});
assert.equal(offline.run("intakeOnServer()"),false);
const limited=test(null,{restricted:true,standalone:true,protocol:"file:"});
limited.run('S.step="app";S.mode="own";S.tab="stock";render()');
assert.match(limited.body(),/Браузер запретил сохранение/);
limited.context.sample={name:"Русская сличительная.csv",arrayBuffer:async()=>Buffer.from(
  "Наименование;Учётный остаток;Фактический остаток;Ед. изм.\nСироп;5;3;л")};
assert.equal(await limited.run('handleFile("stock","inv",sample)'),true);
assert.equal(limited.run("S.data.counts[0].rows[0].fact"),3);
assert.equal(limited.run("S.data.counts[0].rows[0].book"),5);
const noStorage=test(null,{restricted:true});
noStorage.run('S.step="app";S.mode="own";S.tab="receiving";A.receivingsources();incoming.token="operator";incoming.queue=[{id:1,name:"pending.csv"}]');
const queueRequests=[];
noStorage.context.fetch=async(url)=>{
  queueRequests.push(url);
  return new Response(good("STORAGE"),{headers:{"content-type":"application/octet-stream"}});
};
noStorage.context.form={dataset:{f:"importqueue",id:"1"},values:{kind:"invoice"}};
await noStorage.run("submitIncoming(form)");
assert.deepEqual(queueRequests,["/api/intake/documents/1"]);
assert.equal(noStorage.run("S.data.invoices.length"),0);
assert.equal(noStorage.run("incoming.queue.length"),1);
assert.match(noStorage.run("incoming.notice"),/Не удалось сохранить/);

const dated=test({mode:"own",step:"app",tab:"stock",venue:{stockName:"Бар"},
  data:{receipts:[{date:"2026-10-23",warehouse:"Бар",rows:[{pos:"Тоник",qty:4,unit:"шт"}]}]}});
const datedFile=(name,content)=>{dated.context.file={name,arrayBuffer:async()=>Buffer.from(content)};return dated.run('handleFile("stock",'+JSON.stringify(name.startsWith("Факт")?"inv":"rest")+',file)');};
assert.equal(await datedFile("Факт.csv","На дату: 31.12.2099\nПозиция;Учёт;Факт;Единица\nТоник;4;2;шт"),undefined);
assert.match(dated.state().sec.stock.docs.inv.err,/не может быть в будущем/);
assert.equal(await datedFile("Остатки.csv","На дату: 31.12.2099\nПозиция;Остаток;Единица\nТоник;8;шт"),undefined);
assert.match(dated.state().sec.stock.docs.rest.err,/не может быть в будущем/);
assert.equal(await datedFile("Факт.csv","На дату: 24.10.2026\nПозиция;Учёт;Факт;Единица\nТоник;4;0;шт\nСироп;2;;л"),true);
assert.equal(dated.state().data.counts[0].rows.length,1);
assert.equal(dated.state().data.counts[0].rows[0].fact,0);
dated.run('A.count();S.draft.date="2026-10-25";S.draft.rows.Тоник="2";A.invsave()');
assert.equal(dated.state().data.counts[0].rows[0].unit,"шт");
assert.equal(dated.run('effectiveStock().Тоник.qty'),2);
dated.context.pending={name:"Приход.csv",arrayBuffer:async()=>Buffer.from(header+
  "\nТоник;1;10;10;шт;Поставщик;31.12.2099;FUTURE")};
assert.equal(await dated.run('handleFile("receiving","invoice",pending)'),true);
dated.run("postReceipt(String(S.data.invoices[0].id))");
assert.match(dated.toasts.at(-1),/будущей датой/);
assert.equal(dated.state().data.receipts.length,1);
const datedBook=xlsx.utils.book_new();
xlsx.utils.book_append_sheet(datedBook,xlsx.utils.aoa_to_sheet([
  ["Остатки на складах"],["На 31.12.2099"],["Название товара","Ед. изм.","Бар"],["Тоник","шт",100]
]),"Остатки");
dated.context.pending={name:"Остатки.xlsx",arrayBuffer:async()=>xlsx.write(datedBook,{type:"buffer",bookType:"xlsx"})};
assert.equal(await dated.run('handleFile("stock","rest",pending)'),"preview");
assert.match(dated.body(),/Дата остатков не может быть в будущем/);
await dated.run("commitWorkbookPreview()");
assert.equal(dated.run('effectiveStock().Тоник.qty'),2);
console.log("PASS: queue retained with blocked storage; future CSV dates, empty fact, explicit zero and receipt-only units");
const priceDoc=(date,price,supplier="Поставщик",unit="л",taxBasis="")=>({date,supplier,taxBasis,rows:[{pos:"Сироп",unit,price}]});
const pricesAcrossYears=test({mode:"own",step:"app",tab:"reports",data:{invoices:[
  priceDoc("2025-01-22",120),priceDoc("2024-12-20",100),priceDoc("2025-01-01",99),
  priceDoc("2025-02-01",900,"Другой"),priceDoc("2025-02-02",900,"Поставщик","кг"),
  priceDoc("2025-02-03",900,"Поставщик","л","gross"),priceDoc("",900)
]}});
assert.deepEqual(JSON.parse(pricesAcrossYears.run('JSON.stringify(computeReport("r_pricedyn").rows)')),
  [["Сироп","Поставщик","л","20.12.2024 · 100 ₽","22.01.2025 · 120 ₽","+20%"]]);
pricesAcrossYears.context.sales={name:"Продажи.csv",arrayBuffer:async()=>Buffer.from(
  "Позиция;Количество;Цена;Выручка;Категория\nСироп;2;100;0;Бар")};
assert.equal(await pricesAcrossYears.run('handleFile("reports","sales",sales)'),true);
assert.equal(pricesAcrossYears.state().data.sales[0].sum,0);
assert.match(pricesAcrossYears.run('computeReport("r_sales").note'),/Всего 0 ₽/);
console.log("PASS: chronological prices across calendar years, supplier/unit/VAT separation and accurate zero revenue");
const asOf=test({mode:"own",step:"app",tab:"stock",venue:{stockName:"Бар"},data:{stock:{Тоник:{qty:9,unit:"шт",countDate:"2026-10-20"}},receipts:[
  {date:"2026-10-21",warehouse:"Бар",rows:[{pos:"Тоник",qty:1,unit:"шт"}]},
  {date:"2026-10-22",warehouse:"Бар",rows:[{pos:"Тоник",qty:5,unit:"шт"}]}
]}});
asOf.run('A.count();S.draft.date="2026-10-21";S.draft.rows.Тоник="8";A.invsave()');
assert.equal(asOf.state().data.counts[0].rows[0].book,10);
assert.equal(asOf.run("effectiveStock().Тоник.qty"),13);
asOf.run('A.count();S.draft.date="2026-10-20";S.draft.rows.Тоник="3";A.invsave()');
assert.equal(asOf.state().data.counts.length,2);
const historical=asOf.state().data.counts.find(count=>count.date==="2026-10-20");
assert.equal(historical.rows[0].fact,3);
assert.equal(historical.rows[0].book,null);
assert.equal(historical.rows[0].diff,null);
assert.equal(historical.withoutBook,1);
assert.equal(asOf.run("effectiveStock().Тоник.qty"),13);
asOf.run('S.data.invoices=[{id:"same",date:"2026-10-21",supplier:"Поставщик",number:"1",rows:[{pos:"Тоник",qty:1,unit:"шт"}]}];postReceipt("same")');
assert.match(asOf.toasts.at(-1),/может быть уже включён в пересчёт/);
assert.equal(asOf.state().data.receipts.length,2);
console.log("PASS: dated inventory excludes later receipts and detects same-day duplicate accounting");
console.log("PASS: 14 Russian bar phrases, slang definitions, multiple intents, standalone protocol and restricted storage");
console.log("PASS. Manager workflow through application actions, import including TSV, wrong types, duplicate, totals and invalid date, price scope, findings and calendar, local answer, draft, order, backup, demo isolation, 2500 rows ("+ms+" ms in JS harness).");
})().catch(e=>{console.error(e);process.exit(1);});

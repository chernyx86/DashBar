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
  const answers=c.qs.length?`<button class="link" data-a="ask" data-k="${k}">Вопросы о разделе</button>`:"";
  const dl=docs.map(d=>{
    const r=st.docs[d[0]], b=busy[k+"."+d[0]];
    const receiving=k==="receiving";
    if(receiving&&d[0]==="invoice")return r||b?`<div class="doc"><h3>Последний импорт накладной</h3>
      ${b?`<p class="muted">Читаю «${esc(b)}»…</p>`:""}
      ${r?.err?`<p class="muted">${r.errName?esc(r.errName)+": ":""}${esc(r.err)}</p>`:""}
      ${r?.res?resBlock(r,true):""}</div>`:"";
    return `<div class="doc" id="doc-${d[0]}"><div class="between" style="align-items:flex-start"><div><h3>${esc(d[1])}</h3><p class="muted">${esc(d[2])}</p></div></div>
     <details><summary class="muted">Формат и источник</summary><p class="muted">${esc(d[3])}</p></details>
     ${b?`<div class="res">Читаю «${esc(b)}»…</div>`:""}
     ${r&&r.err?`<div class="res" style="color:var(--warn)">${r.errName?esc(r.errName)+": ":""}${esc(r.err)}</div>`:""}
     ${r&&r.res?resBlock(r,receiving):""}
     <label class="btn s file" style="align-self:flex-start"> ${receiving?"Загрузить матрицу":(r&&r.res?"Загрузить другой файл":"Загрузить файл")}<input type="file" data-sec="${k}" data-doc="${d[0]}" accept="${receiving?"": "image/*,"}.pdf,.xlsx,.xls,.csv,.txt,.tsv" aria-label="${esc(d[1])}" ${b?"disabled":""}></label></div>`;
  }).join("");
  return `<div class="sec"><div class="between"><h2>${k==="receiving"?"Документы приёмки":"Документы"}</h2>${answers}</div>
    ${help}<div class="list">${dl}</div></div>`;
}
const invoiceSearch={query:"",limit:25};
function invoicesByDate(){
  return S.data.invoices.slice().reverse().sort((a,b)=>b.date.localeCompare(a.date));
}
function invoiceReceiptStatus(invoice){
  if(invoice.receiptAt)return invoice.automaticReceipt?"На приходе DashBar · автоматически":"На приходе DashBar";
  return invoice.status==="проведена"?"Проведена":"Ожидает прихода";
}
// Original invoice quantities are not changed. Multipliers apply only to
// an explicitly marked packaging unit, never to a count of bottles/items.
function invoicePack(row){
  const qty=readNumber(row.qty), unit=receiveUnit(row.unit), name=String(row.pos||"");
  const unitAliases={бутылка:"бут",бутылки:"бут",бутылок:"бут",упак:"уп",упаковка:"уп",упаковки:"уп",коробка:"кор",коробок:"кор",ящик:"ящ",банка:"шт",банок:"шт",кега:"кег"};
  const source=Object.hasOwn(unitAliases,unit)?unitAliases[unit]:unit;
  if(!Number.isFinite(qty)||qty<=0)return null;
  if(["л","мл","кг","г"].includes(source)){
    const scale=STOCK_UNIT_SCALE[source];return {baseUnit:scale[0],baseQty:qty*scale[1],pieceQty:null,packCount:null,volume:null,volumeUnit:scale[0]};
  }
  const explicit=[...name.matchAll(/(?:^|[^\d\p{L}])(\d+(?:[,.]\d+)?)\s*(мл|л|кг|г)(?![\p{L}])(?:\s*[*×xх]\s*(\d{1,4})(?!\d))?/giu)];
  const implicit=[...name.matchAll(/(?:бутылка|бут\.?|банка|кег)\s*(\d+[,.]\d{1,3})\s*(?:[*×xх]\s*(\d{1,4}))?(?![\d.,])/giu)];
  const sizes=explicit.map(m=>({amount:readNumber(m[1]),unit:receiveUnit(m[2]),pack:m[3]?Number(m[3]):null}));
  if(!sizes.length)for(const m of implicit)sizes.push({amount:readNumber(m[1]),unit:"л",pack:m[2]?Number(m[2]):null});
  const reverse=[...name.matchAll(/(?:^|[^\d\p{L}])(\d{1,4})\s*(?:[*×xх]|(?:шт\.?\s*)?по)\s*(\d+(?:[,.]\d+)?)\s*(мл|л|кг|г)(?![\p{L}])/giu)];
  if(sizes.length===1&&reverse.length===1&&sizes[0].amount===readNumber(reverse[0][2])&&sizes[0].unit===receiveUnit(reverse[0][3])){
    if(sizes[0].pack&&sizes[0].pack!==Number(reverse[0][1]))return null;
    sizes[0].pack=Number(reverse[0][1]);
  }
  if(sizes.length>1)return null;
  const size=sizes[0];
  const packed=["уп","кор","ящ"].includes(source), countable=["бут","шт","кег"].includes(source);
  if(!packed&&!countable)return null;
  if(packed&&!size?.pack){
    if(size)return null;
    const counts=[...name.matchAll(/(?:^|[^\d\p{L}])(\d{1,4})\s*(?:шт\.?|штук)(?![\p{L}])/giu)];
    if(counts.length!==1)return null;
    const pieces=qty*Number(counts[0][1]);
    return Number.isSafeInteger(pieces)&&pieces>0?{baseUnit:"шт",baseQty:pieces,pieceQty:pieces,packCount:Number(counts[0][1]),volume:null,volumeUnit:"шт"}:null;
  }
  const pieces=qty*(packed?size.pack:1);
  if(!Number.isFinite(pieces)||pieces<=0||!Number.isSafeInteger(pieces))return null;
  if(size){
    const scale=STOCK_UNIT_SCALE[size.unit], single=size.amount*scale[1];
    if(!Number.isFinite(single)||single<=0||single>1000||size.pack>1000)return null;
    return {baseUnit:scale[0],baseQty:pieces*single,pieceQty:pieces,packCount:size.pack||null,volume:single,volumeUnit:scale[0]};
  }
  return countable?{baseUnit:"шт",baseQty:pieces,pieceQty:pieces,packCount:null,volume:null,volumeUnit:"шт"}:null;
}
function invoiceQuantityIn(row,target){
  const direct=convertQuantity(readNumber(row.qty),row.unit,target);
  if(direct!==null)return direct;
  const pack=invoicePack(row);
  if(!pack)return null;
  if(receiveUnit(target)==="шт"&&pack.pieceQty!==null)return pack.pieceQty;
  if(receiveUnit(target)==="бут"&&pack.pieceQty!==null&&/(?:бутыл|(?:^|\s)бут(?:[.\s]|$))/i.test(row.pos+" "+row.unit))return pack.pieceQty;
  return convertQuantity(pack.baseQty,pack.baseUnit,target);
}
function invoicePackLabel(row){
  const p=invoicePack(row);
  if(!p)return "Не определено";
  return [p.volume!==null?fmt(p.volume,4)+" "+p.volumeUnit+"/ед.":"",p.packCount?fmt(p.packCount,0)+" ед./уп.":"",fmt(p.baseQty,4)+" "+p.baseUnit].filter(Boolean).join(" · ");
}
function ocrRowSummary(row){
  const qty=readNumber(row.qty),gross=readNumber(row.gross),pack=invoicePack(row);
  return [invoicePackLabel(row),qty>0&&Number.isFinite(gross)?"Цена единицы: "+exactMoney(gross/qty):"Цена будет рассчитана из суммы и количества",pack&&Number.isFinite(gross)?exactMoney(gross/pack.baseQty)+"/"+pack.baseUnit:""].filter(Boolean).join(" · ");
}
function addressKey(value){return receiveKey(value).replace(/[.,;:()№]/g," ").replace(/\s+/g," ").trim();}
// Build the vocabulary from this bar's own stock, count sheets and confirmed
// receipts. No extra stock movement or product is created by a suggestion.
function invoiceCatalog(){
  const entries=new Map(),add=(name,unit)=>{
    name=String(name||"").trim();unit=receiveUnit(unit);
    if(!name||!unit)return;
    const key=receiveKey(name)+"|"+unit;
    if(!entries.has(key))entries.set(key,{name,unit});
  };
  for(const [name,row] of Object.entries(effectiveStock()))add(name,row.unit);
  for(const count of S.data.counts)for(const row of count.rows||[])add(row.pos,row.unit);
  for(const inv of S.data.invoices)if(inv.receiptAt)for(const row of inv.rows||[])if(row.stockMatch)add(row.stockMatch.name,row.stockMatch.unit);
  return [...entries.values()];
}
const catalogGeneric=new Set(["пиво","пивной","напиток","вино","игр","сортовое","сух","сухое","бел","белое","красное","чай","кофе","водка","ром","джин","виски","ликер","бут","бутылка","упак","категории","креп","емк","шт","грамм","бар"]);
function catalogTokens(value){
  // Fold visually identical OCR characters inside a word, including mixed Cyrillic/Latin brand names.
  const fold={а:"a",в:"b",е:"e",к:"k",м:"m",н:"h",о:"o",р:"p",с:"c",т:"t",у:"y",х:"x"};
  return [...new Set((receiveKey(value).match(/[\p{L}]{3,}/gu)||[]).filter(t=>!catalogGeneric.has(t)).map(t=>t.replace(/[авекмнорстух]/g,c=>fold[c])))];
}
function catalogWordSimilarity(a,b){
  if(a===b)return 1;
  if(Math.min(a.length,b.length)<4||Math.abs(a.length-b.length)>2)return 0;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=next;
  }
  return Math.max(0,1-prev[b.length]/Math.max(a.length,b.length));
}
function catalogSizes(value){
  return [...new Set([...String(value||"").matchAll(/(?:^|[^\d\p{L}])(\d+(?:[,.]\d+)?)\s*(мл|л|кг|г)(?![\p{L}/])/giu)].map(m=>{
    const scale=STOCK_UNIT_SCALE[receiveUnit(m[2])];return scale?scale[0]+":"+readNumber(m[1])*scale[1]:"";
  }).filter(Boolean))];
}
function sameCatalogSupplier(invoice,prior){
  if(invoice.supplierInn&&prior.supplierInn)return invoice.supplierInn===prior.supplierInn;
  return !!receiveKey(invoice.supplier)&&receiveKey(invoice.supplier)===receiveKey(prior.supplier);
}
function catalogSuggestions(invoice,row,catalog=invoiceCatalog()){
  const tokens=catalogTokens(row.pos);if(!tokens.length)return [];
  const sourceSizes=catalogSizes(row.pos),history=new Map();
  for(const inv of S.data.invoices)if(inv.receiptAt&&inv.id!==invoice.id&&sameCatalogSupplier(invoice,inv))for(const old of inv.rows||[])if(old.stockMatch){
    const key=receiveKey(old.stockMatch.name)+"|"+receiveUnit(old.stockMatch.unit);
    if(!history.has(key))history.set(key,[]);history.get(key).push(old.pos);
  }
  function score(name){
    const target=catalogTokens(name);if(!target.length)return 0;
    const hits=target.map(t=>Math.max(0,...tokens.map(v=>catalogWordSimilarity(v,t)))).filter(v=>v>=.77);
    if(!hits.length||hits.length===1&&!(target.length===1&&target[0].length>=5&&hits[0]===1))return 0;
    return hits.reduce((s,v)=>s+v,0)/target.length;
  }
  return catalog.flatMap(item=>{
    const targetSizes=catalogSizes(item.name);
    if(sourceSizes.length===1&&targetSizes.length===1&&sourceSizes[0]!==targetSizes[0])return [];
    const key=receiveKey(item.name)+"|"+item.unit,aliases=history.get(key)||[];
    const direct=receiveKey(row.pos)===receiveKey(item.name)?1:score(item.name);
    const alias=Math.max(0,...aliases.map(a=>receiveKey(row.pos)===receiveKey(a)?1:score(a)));
    const best=Math.max(direct,alias);if(best<.60)return [];
    return [{...item,score:best+(alias>=.60?.15:0),learned:alias>=.60}];
  }).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,3);
}
function ocrCatalogHints(invoice,row,index,catalog){
  const chosen=row.stockMatch;
  if(chosen)return `<p class="res">Сопоставлено: ${esc(chosen.name)} · ${esc(chosen.unit)} <button type="button" class="link" data-a="ocrcatalogclear" data-i="${index}">Отменить</button></p>`;
  const candidates=catalogSuggestions(invoice,row,catalog);
  if(!candidates.length)return "";
  return `<div class="res"><b>Возможные позиции вашего бара</b>${candidates.map((item,j)=>`<button type="button" class="link" data-a="ocrcatalog" data-i="${index}" data-j="${j}">${esc(item.name)} · ${esc(item.unit)}${item.learned?" · история поставщика":" · справочник"}</button>`).join("")}</div>`;
}
function selectOcrCatalog(index,choice){
  if(sheet?.t!=="ocr"||!sheet.rows[index])return;
  const row=sheet.rows[index],item=catalogSuggestions(sheet,row)[choice];
  if(!item)return;
  row.stockMatch={name:item.name,unit:item.unit};render(true);
}
function suggestedStockMatch(invoice,row){
  if(row.stockMatch)return row.stockMatch;
  const prior=S.data.invoices.filter(inv=>inv.id!==invoice.id&&inv.receiptAt&&sameCatalogSupplier(invoice,inv))
    .flatMap(inv=>inv.rows.filter(r=>receiveKey(r.pos)===receiveKey(row.pos)&&receiveUnit(r.unit)===receiveUnit(row.unit)&&r.stockMatch).map(r=>r.stockMatch));
  const unique=new Map(prior.map(m=>[receiveKey(m.name)+"|"+receiveUnit(m.unit),m]));
  return unique.size===1?[...unique.values()][0]:null;
}
function renderInvoiceMapping(s){
  const inv=S.data.invoices.find(i=>i.id===s.id);
  if(!inv)return '<p>Накладная не найдена.</p>';
  const names=Object.keys(effectiveStock());
  return `<h2>Сопоставление со складом</h2><p class="muted">Выберите точное название из склада iiko или введите проверенное название новой позиции. Похожие названия не объединяются автоматически.</p>
    <form data-f="mapinvoice" class="col"><label class="field">Адрес поставки<input class="in" name="address" value="${esc(inv.deliveryAddress||"")}" placeholder="Адрес грузополучателя, если указан"></label>
    <datalist id="stock-names">${names.map(name=>`<option value="${esc(name)}"></option>`).join("")}</datalist>
    ${inv.rows.map((row,i)=>`<label class="field">${esc(row.pos)} · ${esc(invoicePackLabel(row))}<input class="in" name="row${i}" list="stock-names" value="${esc(suggestedStockMatch(inv,row)?.name||"")}" placeholder="Оставить исходное название"></label>`).join("")}
    <p class="muted">Складское количество пересчитывается только при однозначной фасовке. Исходное название и количество накладной сохраняются.</p><p role="status">${esc(s.error||"")}</p><button class="btn p">Сохранить сопоставление</button></form>`;
}
function saveInvoiceMapping(form){
  const s=sheet,inv=S.data.invoices.find(i=>i.id===s?.id);
  if(!inv||inv.receiptAt||inv.status==="проведена")return;
  try{
    const fields=new FormData(form),stock=effectiveStock(),index=stockIndex(stock);
    const rows=inv.rows.map((row,i)=>{
      const name=String(fields.get("row"+i)||"").trim();
      if(!name){const {stockMatch,...rest}=row;return rest;}
      const key=receiveKey(name),existing=index.get(key);
      if(index.has(key)&&!existing)throw new Error(`«${name}»: несколько складских позиций с таким названием.`);
      const unit=existing?.unit||invoicePack(row)?.baseUnit||receiveUnit(row.unit);
      if(invoiceQuantityIn(row,unit)===null)throw new Error(`«${row.pos}»: не удалось перевести количество в ${unit}. Проверьте фасовку.`);
      return {...row,stockMatch:{name:existing?.name||name,unit}};
    });
    let posted=false;
    commitReceiving(()=>{
      const updated={...inv,deliveryAddress:String(fields.get("address")||"").trim(),rows};
      S.data.invoices=S.data.invoices.map(i=>i.id===inv.id?updated:i);
      if(S.venue.autoReceipt!==false&&updated.totalVerified){
        try{const prepared=prepareReceipt(updated,true);recordReceipt(updated,prepared,true);posted=true;}
        catch(error){updated.autoReceiptIssue=error.message;}
      }
      refreshReceivingFindings(invoiceChecks());
    });
    sheet=null;render(true);toast(posted?"Сопоставление сохранено. Приход автоматически отражён на складе DashBar.":"Сопоставление сохранено. Приход ещё не проведён.");
  }catch(error){s.error=error.message;render(true);}
}
function invoiceResults(invoices){
  const words=receiveKey(invoiceSearch.query).split(" ").filter(Boolean);
  const found=words.length?invoices.filter(invoice=>{
    const metadata=receiveKey([invoice.supplier,invoice.number,invoice.filename,invoice.deliveryAddress].filter(Boolean).join(" "));
    if(words.every(word=>metadata.includes(word)))return true;
    return invoice.rows.some(row=>{
      const item=receiveKey([row.pos,row.stockMatch?.name].filter(Boolean).join(" "));
      return words.every(word=>metadata.includes(word)||item.includes(word));
    });
  }):invoices;
  const shown=found.slice(0,invoiceSearch.limit);
  return `<p class="muted" role="status">${words.length?`Найдено: ${found.length} из ${invoices.length}`:`Накладных: ${invoices.length}`}</p>
    ${shown.length?`<div class="list">${shown.map(invoice=>`<details class="doc invoice" data-invoice-id="${esc(invoice.id)}">
      <summary><b>${esc(invoice.supplier||"Поставщик не указан")}${invoice.number?" · № "+esc(invoice.number):""}</b>
      <span class="muted">${invoice.date?ruDate(invoice.date):"Дата не указана"} · ${invoice.rows.length} строк · ${exactMoney(invoice.sum)}</span></summary>
      <p class="muted">${invoiceReceiptStatus(invoice)}${invoice.filename?" · "+esc(invoice.filename):""}</p>
      ${invoice.autoReceiptIssue&&!invoice.receiptAt?`<p class="muted">${esc(invoice.autoReceiptIssue)}</p>`:""}
      ${invoice.buyer?`<p class="muted">Покупатель · ${esc(invoice.buyer)}</p>`:""}
      <p class="muted">Адрес поставки · ${esc(invoice.deliveryAddress||"не указан")}</p>
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
  const rows=invoice.rows.map(row=>{const p=invoicePack(row);return [row.stockMatch?.name||row.pos,fmt(row.qty,4)+(row.unit?" "+row.unit:""),invoicePackLabel(row),exactMoney(row.sum/row.qty),p?exactMoney(row.sum/p.baseQty)+"/"+p.baseUnit:"—",exactMoney(row.sum)];});
  const canMap=!invoice.receiptAt&&invoice.status!=="проведена";
  return table(["Позиция","Кол-во","Фасовка и объём","Цена"+tax,"Цена ед. учёта","Сумма"+tax],rows)+
    (!invoice.taxBasis?'<p class="muted">Налоговая основа стоимости в исходнике не подтверждена.</p>':"")+
    (invoice.rows.some(r=>r.calculatedSum)?'<p class="muted">Для строк без суммы в исходнике стоимость рассчитана из количества и указанной цены. Сверьте с оригиналом.</p>':"")+
    (canMap?`<button class="btn s" data-a="mapinvoice" data-id="${esc(invoice.id)}">Сопоставить со складом</button>`:"");
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
  return `<div class="sec" id="invoice-register">
    <div class="between section-actions" id="doc-invoice"><h2>Реестр накладных</h2>
      <button class="btn s p" data-a="receivingsources">Источники накладных</button></div>
    ${S.data.docsInboxRegistry.length?'<button class="link" data-a="docsinboxregistry" style="align-self:flex-start">Реестр DocsInBox</button>':""}
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
const incoming={driveLink:"",token:"",queue:[],nextCursor:null,notice:"",connected:false,assistantAvailable:false,busy:false};
const scanImage=/\.(?:jpe?g|png|webp)$/i;
const incomingLabels={drive:"Google Drive",sheets:"Google Таблицы",telegram:"Telegram",external:"Входящий API",edi:"ЭДО",docsinbox:"DocsInBox"};
const intakeKind=`<select class="in" name="kind" aria-label="Тип документа"><option value="invoice">Накладная</option><option value="matrix">Матрица цен</option></select>`;
const intakeOnServer=()=>!document.documentElement.hasAttribute?.("data-standalone")&&
  ["http:","https:"].includes(location.protocol);
function blankOcrRow(){return {pos:"",unit:"",qty:"",netPrice:"",netSum:"",vat:"",gross:"",needsReview:false};}
function renderOcr(s){
  const catalog=invoiceCatalog();
  const input=(label,key,value,index,required=true)=>`<label class="field">${label}<input class="in" data-ocr-key="${key}" ${index==null?"":`data-ocr-index="${index}"`}
    ${["qty","netPrice","netSum","vat","gross","total"].includes(key)?'inputmode="decimal"':key==="date"?'type="date"':""} value="${esc(value)}" ${required?"required":""}></label>`;
  const calculatedLabels={qty:"количество",netPrice:"цена",netSum:"сумма без НДС",vat:"НДС",gross:"сумма с НДС"};
  const pending=s.rows.filter(row=>row.needsReview||!row.pos||!row.unit||["qty","gross"].some(key=>row[key]==="" )).length;
  return `<h2>Проверить накладную</h2><p class="muted">${esc(s.name)} · ${s.mode==="edi-xml"?"XML УПД":"распознано на сервере DashBar"}</p>
    <p>Сверьте поставщика, покупателя, дату, фасовку, количество, цену, НДС и итог с оригиналом. Все поля можно исправить.</p>
    <p class="muted">${catalog.length?`Справочник бара: ${catalog.length} позиций. Выберите подходящее название, если оно предложено.`:"Загрузите остатки или инвентаризацию в разделе «Склад», чтобы получать подсказки по названиям товаров."}</p>
    <div class="res" role="status"><b>Строк распознано: ${s.detectedRows}</b><span>${pending?`Нужно проверить: ${pending}.`:"Сверьте данные с оригиналом перед сохранением."}</span></div>
    ${s.documentWarning?`<p class="res">${esc(s.documentWarning)}</p>`:""}
    ${s.mode==="local-ocr"&&!s.detectedRows?'<p class="muted">Строки таблицы не распознаны. Сверьте документ по изображению или загрузите выгрузку ЭДО.</p>':""}
    ${s.preview.length?`<details class="card"><summary>Изображение документа</summary>
    ${s.preview.map((data,i)=>`<img style="width:100%;height:auto" src="data:image/jpeg;base64,${esc(data)}" alt="Страница ${i+1} накладной">`).join("")}</details>`:""}
    <form data-f="confirmocr" class="col">
    ${input("Поставщик","supplier",s.supplier)}
    ${input("ИНН поставщика (необязательно)","supplierInn",s.supplierInn||"",null,false)}
    ${input("Покупатель","buyer",s.buyer,null,false)}
    ${input("Адрес поставки / грузополучателя","deliveryAddress",s.deliveryAddress||"",null,false)}
    ${s.deliveryAddress?"":'<p class="muted">Адрес не удалось прочитать надёжно. При нескольких заведениях сверьте адрес грузополучателя с оригиналом.</p>'}
    ${s.buyer?"":'<p class="muted">Если в оригинале указан покупатель, внесите его из документа.</p>'}
    ${input("Номер","number",s.number)}
    ${input("Дата","date",s.date)}
    ${s.rows.map((row,i)=>`<fieldset class="card"><legend>Строка ${i+1}</legend>
      ${row.calculatedFields?.length?`<p class="muted">Предложено расчётом: ${esc(row.calculatedFields.map(key=>calculatedLabels[key]||key).join(", "))}. Обязательно сверьте с оригиналом.</p>`:""}
      ${row.calculatedGross?'<p class="muted">Сумма с НДС рассчитана по прочитанным полям и общему итогу. Сверьте её с оригиналом.</p>':""}
      ${row.needsReview&&!row.calculatedGross?'<p class="muted">Проверьте наименование, фасовку и суммы по оригиналу. Пустые поля не удалось определить надёжно.</p>':row.rounding?'<p class="muted">Цена за единицу округлена. Сверьте сумму без НДС по оригиналу.</p>':""}
      ${input("Товар и фасовка","pos",row.pos,i)}
      <div id="ocr-catalog-${i}">${ocrCatalogHints(s,row,i,catalog)}</div>
      <div class="row">${input("Единица","unit",row.unit,i)}${input("Количество","qty",row.qty,i)}</div>
      ${input(s.documentWarning?"Сумма позиции":"Сумма с НДС","gross",row.gross,i)}
      <p class="res" id="ocr-summary-${i}">${esc(ocrRowSummary(row))}</p>
      <details><summary>Реквизиты для сверки НДС (если указаны)</summary>
      <div class="col">${input("Цена без НДС","netPrice",row.netPrice,i,false)}${input("Сумма без НДС","netSum",row.netSum,i,false)}${input("НДС по строке","vat",row.vat,i,false)}</div></details>
      ${s.rows.length>1?`<button class="link" type="button" data-a="ocrdel" data-i="${i}">Убрать строку</button>`:""}
    </fieldset>`).join("")}
    <button class="btn s" type="button" data-a="ocradd" ${s.rows.length>=100?"disabled":""}>Добавить строку</button>
    ${input(s.documentWarning?"Итог по документу":"Итог по документу с НДС","total",s.total)}
    <p class="muted" role="status">${esc(s.error||"")}</p>
    <button class="btn p">Подтвердить и сохранить</button>
    ${S.venue.autoReceipt!==false?'<p class="muted">При полном совпадении адреса и складских позиций накладная автоматически попадёт на склад DashBar.</p>':""}
    </form>
    ${s.ocrText?`<details class="card"><summary>Исходный текст распознавания (для диагностики)</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;margin:0">${esc(s.ocrText)}</pre></details>`:""}`;
}
async function openOcr(item,state,mode){
  const xml=/\.xml$/i.test(item.name);
  const result=await incomingRequest("/documents/"+item.id+(xml?"/edi":"/recognize"),{method:xml?"GET":"POST"});
  if(S!==state||S.mode!==mode||sheet?.t!=="receivingsources")return "Откройте документ в очереди для проверки.";
  sheet={t:"ocr",queueId:item.id,name:item.name,mode:result.mode,supplierInn:result.supplierInn||"",supplier:result.supplier||"",buyer:result.buyer||"",number:result.number||"",
    date:result.date||"",deliveryAddress:result.deliveryAddress||"",total:result.total||"",documentWarning:result.documentWarning||"",detectedRows:result.rows?.length||0,rows:result.rows?.length?result.rows:[blankOcrRow()],
    preview:(result.preview||[]).filter(data=>/^[a-z0-9+/=]+$/i.test(data)),ocrText:result.ocrText||""};
  const draft=sheet;
  if(S.venue.autoReceipt!==false&&draft.detectedRows&&draft.buyer&&draft.rows.every(row=>draft.mode==="edi-xml"||
      (draft.mode==="local-ocr"&&row.needsReview===false&&!row.calculatedGross&&!row.calculatedFields?.length))){
    try{
      const res=persistOcrDraft(draft,true);
      sheet={t:"receivingsources"};render(true);
      return await acknowledgeOcr(draft,res);
    }catch(error){draft.error=error.message;}
  }
  render(true);
  return "Проверьте распознанную накладную.";
}
function persistOcrDraft(draft,automaticOnly=false){
    if(!draft.supplier.trim()||!draft.number.trim()||parseDate(draft.date)!==draft.date||!draft.date)
      throw new Error("Проверьте поставщика, номер и дату накладной.");
    if(draft.supplierInn&&!/^(?:\d{10}|\d{12})$/.test(draft.supplierInn.trim()))
      throw new Error("ИНН поставщика должен содержать 10 или 12 цифр.");
    const total=cents(readNumber(draft.total));
    let declaredRows=0;
    const sourceRows=draft.rows.map((r,i)=>{
      const qty=readNumber(r.qty), gross=readNumber(r.gross), grossCents=cents(gross);
      const present=key=>String(r[key]??"").trim()!=="";
      const net=readNumber(r.netPrice),vat=readNumber(r.vat),netSum=readNumber(r.netSum);
      const sum=cents(netSum), estimated=cents(net*qty), tax=cents(vat);
      const unitRounding=Math.max(1,Math.ceil(qty*.5));
      if(!r.pos.trim()||!r.unit.trim()||!Number.isFinite(qty)||qty<=0||
        !Number.isSafeInteger(grossCents)||grossCents<0||
        (present("netPrice")&&(!Number.isFinite(net)||net<0))||
        (present("netSum")&&(!Number.isSafeInteger(sum)||sum<0||sum>grossCents))||
        (present("vat")&&(!Number.isSafeInteger(tax)||tax<0||tax>grossCents))||
        (present("netSum")&&present("netPrice")&&(!Number.isSafeInteger(estimated)||Math.abs(sum-estimated)>unitRounding))||
        (present("netSum")&&present("vat")&&sum+tax!==grossCents))
        throw new Error(`Строка ${i+1}: проверьте товар, количество, цену, НДС и сумму.`);
      declaredRows+=grossCents;
      if(r.stockMatch&&invoiceQuantityIn(r,r.stockMatch.unit)===null)throw new Error(`Строка ${i+1}: уточните фасовку для сопоставления со складом или отмените сопоставление.`);
      return {pos:r.pos.trim(),unit:r.unit.trim(),qty:String(qty),price:String(gross/qty),sum:String(gross),...(r.stockMatch?{stockMatch:r.stockMatch}:{}),
        supplier:draft.supplier.trim(),date:draft.date,number:draft.number.trim(),
        ...(present("netPrice")?{netPrice:net}:{}),...(present("vat")?{vat}:{}),...(present("netSum")?{netSum:sum/100}:{}),sourceLine:i+1};
    });
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(declaredRows)||declaredRows!==total)
      throw new Error("Итог документа должен совпадать с суммой строк.");
    const rows=[...sourceRows,{pos:"Итого",sum:String(total/100)}];
    let res;
    commitReceiving(()=>{
      res=applyReceiving("invoice",{title:"Накладная · распознана и проверена",rows,metadata:[],automaticOnly,
        sourceDocumentId:draft.queueId,supplierInn:draft.supplierInn?.trim(),buyer:draft.buyer?.trim(),deliveryAddress:draft.deliveryAddress?.trim(),taxBasis:draft.documentWarning?"":"gross"},{name:draft.name});
      S.sec.receiving.docs={...S.sec.receiving.docs,invoice:{name:draft.name,res,local:true}};
    });
    return res;
}
async function acknowledgeOcr(draft,res){
  const message=res.automaticReceipt?"Накладная сохранена, приход автоматически отражён на складе DashBar.":"Накладная сохранена в реестре.";
  try{
    await incomingRequest("/documents/"+draft.queueId+"/reviewed",{method:"POST"});
    incoming.queue=incoming.queue.filter(r=>r.id!==draft.queueId);
    return message;
  }catch(e){return message+" Сервер не снял её с очереди. Уберите файл после проверки.";}
}
function confirmOcr(){
  const draft=sheet;
  if(draft?.t!=="ocr"||incoming.busy)return;
  try{
    const res=persistOcrDraft(draft);
    sheet={t:"receivingsources"};
    render(true);
    return runIncoming(()=>acknowledgeOcr(draft,res));
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
      <label class="field">HTTPS-ссылка<input class="in" type="url" name="link" data-intake-link required autocomplete="off"></label>
      <p class="muted" data-drive-link-hint hidden>${intakeOnServer()?"Ссылка ведёт на папку Google Drive. Продолжите в настройках папки.":"Ссылка ведёт на папку Google Drive. Подключите её в разделе «Папка Google Drive» на сервере DashBar. В этой HTML-сборке доступны отдельные файлы."}</p>
      ${intakeKind}<button class="btn s">Загрузить по ссылке</button>
    </form><p class="muted">Прямая ссылка позволяет загрузить один файл. Папка Google Drive подключается через сервер приёмки.</p></details>
  ${intakeOnServer()?`<form class="col" data-f="connectintake">
    <label class="field">Ключ оператора сервера<input class="in" type="password" name="token" autocomplete="off" required></label>
    <button class="btn s">${incoming.connected?"Переподключить очередь":"Подключить очередь"}</button></form>
  ${incoming.connected?'<div class="btns"><button class="btn s" data-a="syncintake">Обновить документы</button></div>':""}
  <details class="card" id="drive-intake" ${incoming.driveLink?"open":""}><summary>Папка Google Drive</summary>
    <p class="muted">PDF и фото из папки появятся в очереди. Откройте документ для распознавания.</p>
    <form class="col" data-f="configureintake" data-source="drive">
      <label class="field">Ссылка на папку<input class="in" name="link" type="url" value="${esc(incoming.driveLink)}" required></label>
      <label class="field">Дата изменения в Drive (необязательно)<input class="in" name="since" type="date"></label>
      <label class="row"><input type="checkbox" name="recursive">Включить подпапки</label>
      <label class="row"><input type="checkbox" name="bar_only" checked>Только файлы с пометкой «Бар»</label>
      <button class="btn s">Подключить и загрузить документы</button></form></details>
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
  incoming.assistantAvailable=data.assistant_available===true;
  return data;
}
function isDriveFolderLink(link){
  try{
    const url=new URL(link);
    return url.protocol==="https:"&&!url.username&&!url.password&&url.hostname==="drive.google.com"&&
      /^\/drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]{8,200}\/?$/.test(url.pathname);
  }catch{return false;}
}
function showIntakeLinkHint(input){
  const form=input.form;
  if(!form)return;
  const hint=form.querySelector("[data-drive-link-hint]");
  if(hint)hint.hidden=!isDriveFolderLink(input.value.trim());
}
function routeDriveFolder(link){
  if(!intakeOnServer()){
    paintIncoming("Это папка Google Drive. Откройте серверную сборку DashBar и подключите её в «Приёмка → Источники накладных → Папка Google Drive».");
    return;
  }
  incoming.driveLink=link;
  const settings=document.getElementById("drive-intake");
  const field=settings?.querySelector('input[name="link"]');
  if(field){
    settings.open=true;
    field.value=link;
    (incoming.connected?field:document.querySelector('[data-f="connectintake"] input[name="token"]'))?.focus?.();
  }
  paintIncoming(incoming.connected?"Проверьте фильтр и нажмите «Подключить и загрузить документы».":"Сначала подключите очередь ключом оператора. Ссылка уже внесена в настройки папки.");
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
  if(form.dataset.f==="directintake"&&isDriveFolderLink(link))return routeDriveFolder(link);
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
    const body=source==="drive"?{link,since:data.get("since")||null,recursive:data.has("recursive"),bar_only:data.has("bar_only")}:
      source==="sheets"?{link}:Object.fromEntries(data);
    if(source==="telegram"&&!body.token)delete body.token;
    const result=await incomingRequest("/"+source,{method:source==="sheets"?"POST":"PUT",body});
    if(source==="drive"){
      incoming.driveLink=link;
      try{
        const status=await incomingRequest("/sync?source=drive",{method:"POST"});
        return "Источник сохранён. "+(status.drive||"Очередь обновлена.");
      }finally{await refreshIncoming();}
    }
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
function invoiceAccountingRow(row){
  const match=row.stockMatch;
  if(!match)return row;
  const qty=invoiceQuantityIn(row,match.unit),sum=readNumber(row.sum);
  return qty>0&&Number.isFinite(sum)?{...row,pos:match.name,unit:match.unit,qty,price:sum/qty}:row;
}
function invoiceChecks(){
  const prices=matrixByPosition();
  return S.data.invoices.flatMap(inv=>inv.rows.map((source,index)=>{
    const row=invoiceAccountingRow(source);
    const candidate=prices.get(receiveKey(row.pos));
    const sameUnit=receiveUnit(row.unit)&&receiveUnit(row.unit)===receiveUnit(candidate?.unit);
    const sameSupplier=receiveKey(inv.supplier)&&receiveKey(inv.supplier)===receiveKey(candidate?.supplier);
    const sameTaxBasis=(inv.taxBasis||"")===(candidate?.taxBasis||"");
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

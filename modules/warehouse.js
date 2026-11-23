"use strict";
/* ---------- Склад ---------- */
function stockEntries(){
  return Object.entries(effectiveStock());
}
function stockIndex(stock){
  const keys=new Map();
  for(const [name,entry] of Object.entries(stock)){
    const key=receiveKey(name);
    keys.set(key,keys.has(key)?null:{name,unit:receiveUnit(entry.unit)});
  }
  return keys;
}
function effectiveStock(asOf=""){
  const stock={...S.data.stock};
  const keys=stockIndex(stock);
  const snapshotDate=S.sec.stock.docs.rest?.res?.snapshot?.date||"";
  const warehouse=S.sec.stock.docs.rest?.res?.snapshot?.warehouse||S.venue.stockName.trim()||"Бар";
  for(const receipt of S.data.receipts){
    if(asOf&&receipt.date>asOf)continue;
    if(receiveKey(receipt.warehouse)!==receiveKey(warehouse)||(snapshotDate&&receipt.date<=snapshotDate))continue;
    for(const row of receipt.rows){
      const key=receiveKey(row.pos);
      const item=keys.get(key);
      if(keys.has(key)&&(!item||item.unit!==receiveUnit(row.unit)))continue;
      const name=item?.name||row.pos;
      if(Object.hasOwn(S.data.stock,name)&&S.data.stock[name].countDate>=receipt.date)continue;
      const previous=Object.hasOwn(stock,name)?num(stock[name].qty):0;
      Object.defineProperty(stock,name,{value:{qty:previous+row.qty,unit:row.unit},enumerable:true,writable:true,configurable:true});
      keys.set(key,{name,unit:receiveUnit(row.unit)});
    }
  }
  return stock;
}
function postReceipt(id){
  const invoice=S.data.invoices.find(item=>String(item.id)===id);
  if(!invoice||isDemo())return;
  try{
    if(invoice.receiptAt||invoice.status==="проведена"||S.data.receipts.some(record=>record.invoiceId===invoice.id))
      throw new Error("Накладная уже проведена. Остаток сохранён без изменений.");
    if(!invoice.number||!invoice.supplier||!invoice.date||parseDate(invoice.date)!==invoice.date)
      throw new Error("Для прихода нужны поставщик, номер и дата накладной.");
    const date=invoice.date;
    if(date>todayISO())throw new Error("Накладную с будущей датой пока нельзя поставить на приход.");
    const from=S.sec.stock.docs.rest?.res?.snapshot?.date;
    if(Object.keys(S.data.stock).length&&!from&&!S.data.counts.some(c=>c.date))
      throw new Error("Загрузите датированный остаток бара перед приходом. Так можно исключить двойной учёт.");
    if(from&&date<=from)throw new Error("Дата накладной совпадает с датой учётных остатков или раньше неё. Проверьте приход в учёте.");
    const stock=effectiveStock(), index=stockIndex(stock);
    const rows=invoice.rows.map(row=>{
      const qty=readNumber(row.qty);
      const unit=receiveUnit(row.unit);
      const key=receiveKey(row.pos);
      const existing=index.get(key);
      if(!key||!unit||!Number.isFinite(qty)||qty<=0)throw new Error(`«${row.pos}»: проверьте количество и единицу.`);
      if(index.has(key)&&(!existing||existing.unit!==unit))throw new Error(`«${row.pos}»: единица или название неоднозначны. Сверьте позицию на складе.`);
      if(existing&&S.data.stock[existing.name]?.countDate>=date)
        throw new Error(`«${row.pos}»: приход может быть уже включён в пересчёт.`);
      const name=existing?.name||row.pos;
      index.set(key,{name,unit});
      return {pos:name,unit:row.unit,qty};
    });
    if(!rows.length)throw new Error("В накладной нет товарных строк.");
    const warehouse=S.sec.stock.docs.rest?.res?.snapshot?.warehouse||S.venue.stockName.trim()||"Бар";
    if(!confirm(`Поставить ${rows.length} строк накладной № ${invoice.number} на склад «${warehouse}»? Подтвердите, что все строки относятся к бару.`))return;
    const receiptAt=new Date().toISOString();
    commitReceiving(()=>{
      S.data.receipts=S.data.receipts.concat({invoiceId:invoice.id,date,warehouse,receiptAt,rows});
      S.data.invoices=S.data.invoices.map(item=>item.id===invoice.id?{...item,receiptAt}:item);
    });
    render(true);toast("Приход отражён на складе DashBar");
  }catch(e){toast(e.message);}
}
function stockReceiptsBlock(){
  if(!S.data.receipts.length)return "";
  const baseDate=S.sec.stock.docs.rest?.res?.snapshot?.date;
  const recent=S.data.receipts.slice(-10).reverse();
  return `<div class="sec"><h2>Приходы в DashBar</h2><p class="muted">Проведено: ${S.data.receipts.length}. ${baseDate?"На остаток влияют приходные движения позже "+ruDate(baseDate)+". ":""}Изменения отражаются в локальном складе.</p>
    ${table(["Дата","Склад","Строк"],recent.map(entry=>[ruDate(entry.date),entry.warehouse,String(entry.rows.length)]))}
    <details class="card"><summary>Текущие остатки с приходами</summary>${table(["Позиция","Количество"],stockEntries().map(([name,item])=>[name,fmt(item.qty,4)+" "+item.unit]))}</details></div>`;
}
function inventoryTotals(count){
  if(count.unpriced==null)return `сохранённая оценка: недостачи ${money(count.short)}, излишки ${money(count.over)}`;
  return `недостачи ${money(count.short)}, излишки ${money(count.over)}${count.unpriced?` · без оценки: ${count.unpriced} строк`:""}${count.withoutBook?` · без учётного остатка: ${count.withoutBook}`:""}`;
}
function inventoryPrice(row,prices){
  const matrix=prices.get(receiveKey(row.pos));
  return receiveUnit(row.unit)&&receiveUnit(row.unit)===receiveUnit(matrix?.unit)?num(matrix.price):0;
}
function possibleResort(count){
  return !count.withoutBook&&count.unpriced===0&&count.short>0&&count.over>0&&Math.abs(count.short-count.over)/Math.max(count.short,count.over)<0.15;
}
function countSources(count){
  if(!count.warehouse||!count.rows.some(row=>row.sources))return "";
  const source=entry=>entry?.file&&entry?.sheet&&entry.line?`${esc(entry.file)} · ${esc(entry.sheet)}, строка ${entry.line}`:"—";
  return `<details><summary>Позиции и источники</summary>
    <p class="muted">${esc(count.warehouse)}${count.formDate?` · бланк от ${ruDate(count.formDate)}`:""}</p>
    <div class="list">${count.rows.filter(r=>r.sources).map(r=>`<div class="li"><div><b>${esc(r.pos)}</b>
      <p class="muted">Факт ${fmt(r.fact,4)} · учёт ${fmt(r.book,4)} · разница ${fmt(r.diff,4)} ${esc(r.unit)}</p>
      <p class="muted">Факт · ${source(r.sources.fact)}${r.sources.factEdited?" · изменён в черновике":""}<br>Учёт · ${source(r.sources.book)}</p>
      </div></div>`).join("")}</div></details>`;
}
function vStock(){
  if(isDemo()) return `<div class="sec"><div class="between"><div class="row"><h2>Три инвентаризации</h2>${q("shortage")}</div>${q("resort")}</div>
   ${table(["Дата","Недостачи, тыс. ₽","Излишки, тыс. ₽"],DEMO.inv)}<p class="muted">Суммы почти равны во всех трёх: это пересортица, а не потери.</p></div>
  <div class="sec"><div class="row"><h2>Заканчивается</h2>${q("stockdays")}</div><div class="list">${DEMO.low.map(r=>`<div class="li"><div><b>${r[0]}</b><span class="muted">остаток ${r[1]}</span></div><span class="val">${r[2]}</span></div>`).join("")}</div></div>
  ${orderBlock()}
  <div class="sec"><div class="row"><h2>Инвентаризация</h2>${q("inventory")}</div><div class="card"><p class="muted">В примере ввод только демонстрационный. В своём баре он работает полностью.</p><button class="btn" data-a="count">Посмотреть ввод</button></div></div>${secFindings("stock")}`;
  const workStarted=stockEntries().length||S.data.counts.length||S.draft;
  const documents=setup("stock");
  return `${workStarted?"":documents}
  <div class="sec" id="stock-count"><div class="between"><div class="row"><h2>Инвентаризация</h2>${q("inventory")}</div><button class="btn s p" data-a="count">${S.draft?"Продолжить ввод":"Начать ввод"}</button></div>
   ${S.data.counts.length?`<div class="list">${S.data.counts.slice(0,5).map(c=>`<div class="li"><div><b>${ruDate(c.date)}</b><span class="muted">${c.rows.length} позиций · ${inventoryTotals(c)}</span>${countSources(c)}</div><span class="val n">${possibleResort(c)?"возможна пересортица":"—"}</span></div>`).join("")}</div>`:`<div class="card"><p class="muted">Инвентаризаций пока нет. Загрузите ведомость или начните ввод вручную.</p></div>`}</div>
  <div class="sec"><div class="row"><h2>Заканчивается</h2>${q("stockdays")}</div>${lowStockBlock()}</div>
  ${orderBlock()}
  ${stockReceiptsBlock()}
  ${secFindings("stock")}
  ${workStarted?documents:""}`;
}
function barSalesPeriod(){
  const sales=S.sec.reports.docs.sales, period=sales?.res?.usagePeriod;
  if(!S.data.sales.some(row=>row.src===BAR_SALES_SOURCE))return {note:"Загрузите продажи бара в разделе «Отчёты»."};
  if(!period)return {note:"Для расчёта нужен период продаж. Укажите над таблицей «с ДД.ММ.ГГГГ по ДД.ММ.ГГГГ»."};
  const {start,end}=period;
  if(!start||!end||parseDate(start)!==start||parseDate(end)!==end||end<start)
    return {note:"Проверьте даты периода продаж."};
  const duration=(Date.parse(end)-Date.parse(start))/86400000+1;
  return {start,end,duration,note:`Продажи с ${ruDate(start)} по ${ruDate(end)} · ${sales.name||"отчёт"}.`};
}
function stockUsage(stock=effectiveStock()){
  const sales=barSalesPeriod();
  if(!sales.duration)return sales;
  const snapshot=S.sec.stock.docs.rest?.res?.snapshot?.date;
  if(!snapshot)return {note:"Для расчёта загрузите датированный снимок остатков."};
  if(snapshot<sales.end)return {note:"Снимок остатков старше отчёта о продажах. Загрузите более свежие остатки."};
  const consumption=salesConsumption(stock);
  const note=consumption.recipeSales?
    consumption.skipped.size?" Заказ по ТТК доступен после проверки несопоставленных продаж в отчёте «Факт и норма».":
    " Нормативный расход рассчитан по загруженным рабочим ТТК. Проверьте, что они действовали в период продаж.":"";
  return {...sales,consumption,note:`Остатки на ${ruDate(snapshot)}. ${sales.note}${note}`};
}
function dailyUse(pos,unit,usage=stockUsage()){
  const data=usage.consumption, key=receiveKey(pos);
  if(!data||!receiveUnit(unit)||(data.recipeSales&&data.skipped.size)||data.skipped.has(key))return null;
  const total=data.totals.get(key);
  const stockUnit=data.positions.get(key)?.unit;
  const qty=convertQuantity(total,stockUnit,unit);
  return qty!==null&&qty>=0?qty/usage.duration:null;
}
function lowStockBlock(){
  const stock=effectiveStock(), usage=stockUsage(stock), rows=[];
  for(const [p,item] of Object.entries(stock)){
    const q=num(item.qty), u=dailyUse(p,item.unit,usage);
    if(q<=0)rows.push([p,fmt(q),"нулевой остаток"]);
    else if(u>0&&q/u<=S.set.lowDays)rows.push([p,fmt(q),fmt(q/u,1)+" дн."]);
  }
  const note=`<p class="muted">${esc(usage.note)}</p>`;
  if(!rows.length)return `<div class="card">${note}${usage.duration&&!(usage.consumption.recipeSales&&usage.consumption.skipped.size)?
    '<p class="muted">Среди позиций с сопоставимыми продажами запас ниже порога не найден.</p>':""}</div>`;
  return note+`<div class="list">${rows.slice(0,10).map(r=>`<div class="li"><div><b>${esc(r[0])}</b><span class="muted">остаток ${esc(r[1])}</span></div><span class="val">${esc(r[2])}</span></div>`).join("")}</div>`;
}
function orderBlock(){
  const rows=S.order;
  return `<div class="sec" id="stock-order"><div class="between"><div class="row"><h2>Заказ</h2>${q("order")}</div><button class="btn s" data-a="ordsuggest">Собрать из остатков</button></div>
   <div class="list">${rows.length?rows.map((r,i)=>`<div class="li"><div><b>${esc(r.pos)}</b>${r.unit?`<span class="muted">${esc(r.unit)}</span>`:""}</div><div class="row"><input class="in qty" data-ord="${i}" value="${esc(r.qty)}" inputmode="decimal" aria-label="Количество"><button class="q" data-a="orddel" data-i="${i}" aria-label="Убрать">×</button></div></div>`).join(""):`<div class="li"><div><span class="muted">Заказ пуст. Соберите из остатков или добавьте позицию.</span></div></div>`}</div>
   <div class="row"><input class="in" id="ord-new" placeholder="Позиция, например «Лайм, кг»" aria-label="Новая позиция"><button class="btn" data-a="ordadd">Добавить</button></div>
   ${rows.length?`<details class="card disclosure order-export"><summary>Экспорт заказа</summary>
    <div class="btns"><button class="btn s" data-a="ordcopy">Скопировать текст</button><button class="btn s" data-a="orddown">Скачать TXT</button>
    ${typeof navigator!=="undefined"&&typeof navigator.share==="function"?'<button class="btn s" data-a="ordshare">Поделиться</button>':""}</div></details>`:""}</div>`;
}
function orderText(){
  if(S.order.some(r=>!Number.isFinite(readNumber(r.qty))||readNumber(r.qty)<=0)){
    toast("Укажите количество больше нуля для каждой позиции заказа");
    return "";
  }
  return "Заказ, "+venueName()+":\n"+S.order.map(r=>"• "+r.pos+": "+fmt(readNumber(r.qty),4)+(r.unit?" "+r.unit:"")).join("\n");
}
function suggestOrder(stock=effectiveStock(),usage=stockUsage(stock)){
  const out=[];
  for(const [p,item] of Object.entries(stock)){
    const q=num(item.qty), unit=item.unit||"", u=dailyUse(p,unit,usage);
    if(u>0){const d=q/u; if(d<=S.set.lowDays) out.push({pos:p,qty:Math.max(1,Math.ceil(u*7-q)),unit});}
  }
  return out;
}

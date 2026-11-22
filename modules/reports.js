"use strict";
/* ---------- Отчёты ---------- */
const REPORTS=[
["Оперативный контроль","Каждый день и после поставки",[
 ["r_inv","Итоги инвентаризации",["Позиция","Учёт","Факт","Разница"],[["Водка для коктейлей, л","9,4","8,7","−0,7"],["Сироп сахарный, л","4,0","4,6","+0,6"],["Лайм, кг","3,2","2,9","−0,3"]]],
 ["r_rest","Остатки и запас в днях",["Позиция","Остаток","Дней"],[["Лайм, кг","1,4","1"],["Апероль, л","2,1","2"],["Тоник 0,2, шт","46","3"]]],
 ["r_move","Движение товара",["Позиция","Приход","Расход","Остаток"],[["Джин, л","18,0","16,2","11,5"],["Лимон, кг","24,0","22,8","3,1"]]],
 ["r_reg","Реестр накладных",["Дата","Поставщик","Сумма","Статус"],[["11.11","Фрукты","8 420","не проведена"],["10.11","Алкоголь 1","21 300","не проведена"]]],
 ["r_pricectl","Контроль закупочных цен",["Позиция","Матрица","Накладная","Откл."],[["Лимон, кг","198,00","312,40","+58%"],["Тоник 0,2","74,00","86,00","+16%"]]],
 ["r_pricedyn","Динамика цен",["Позиция","Сент.","Окт.","Нояб."],[["Лимон, кг","205","240","312"]]],
 ["r_writeoff","Списания",["Причина","Сумма, ₽"],[["Бой","3 200"],["Порча","1 850"]]],
 ["r_staff","Персонал и представительские",["Тип","Позиций","Себестоимость, ₽"],[["Угощение гостям","112","24 600"]]]
]],
["Управленческие","За месяц, для владельца",[
 ["r_sales","Продажи бара",["Категория","Выручка, ₽","Доля"],[["Коктейли","1 420 000","50%"],["Крепкий алкоголь","610 000","21%"]]],
 ["r_abc","ABC-анализ",["Группа","Позиций","Доля выручки"],[["A","28","78%"],["B","41","17%"],["C","63","5%"]]],
 ["r_menueng","Меню-инжиниринг",["Группа","Пример","Что делать"],[["Звёзды","Апероль Шприц","Держать на виду"]]],
 ["r_bevcost","Себестоимость продаж",["Категория","Cost","Цель"],[["Коктейли","22,8%","22%"]]],
 ["r_variance","Факт и норма",["Позиция","Норма","Факт","Разница"],[["Водка, л","31,6","33,7","+2,1"]]],
 ["r_turn","Оборачиваемость запасов",["Категория","Дней"],[["Крепкий алкоголь","34"]]],
 ["r_purch","Закупки по поставщикам",["Поставщик","Сумма, ₽","Доля"],[["Алкоголь 1","412 000","58%"]]]
]]];
const PREVIEW_REPORTS=new Set(["r_move","r_staff","r_menueng","r_bevcost","r_turn"]);
function findReport(k){let r=null;REPORTS.forEach(g=>g[2].forEach(x=>{if(x[0]===k)r=x;}));return r;}
const NEED={r_inv:"Нужна инвентаризация: «Склад» → «Инвентаризация и сличительная ведомость».",
 r_rest:"Нужны остатки и продажи: «Склад» → «Остатки», «Отчёты» → «Продажи».",
 r_move:"Нужны накладные, продажи и инвентаризация.",
 r_reg:"Нужны накладные: «Приёмка» → «Накладные».",
 r_pricectl:"Нужны накладные и матрица цен.",
 r_pricedyn:"Нужны накладные за два-три месяца.",
 r_writeoff:"Нужны акты списания: «Отчёты» → «Списания».",
 r_staff:"Нужна выгрузка продаж с типами оплаты из учётной системы.",
 r_sales:"Нужны продажи бара за месяц.",
 r_abc:"Нужны продажи бара за месяц.",
 r_menueng:"Нужны продажи и техкарты с себестоимостью.",
 r_bevcost:"Нужны продажи, техкарты и закупочные цены.",
 r_variance:"Нужны продажи, техкарты и инвентаризации.",
 r_turn:"Нужны остатки и продажи.",
 r_purch:"Нужны накладные."};
function secForReport(k){return k==="r_reg"||k==="r_pricectl"||k==="r_pricedyn"?"receiving":k==="r_sales"||k==="r_abc"||k==="r_writeoff"||k==="r_purch"?"reports":k==="r_menueng"||k==="r_bevcost"||k==="r_variance"?"cards":"stock";}
function computeReport(key){
  const P=S.data.prices;
  const sales=barSalesRows(), stock=effectiveStock(), inv=S.data.counts, invoices=S.data.invoices;
  if(key==="r_variance")return inventoryNormReport(stock);
  if(key==="r_inv"){
    const c=inv[0]; if(!c) return null;
    const prices=matrixByPosition();
    const rows=c.rows.slice().sort((a,b)=>Math.abs((b.fact-b.book)*inventoryPrice(b,prices))-Math.abs((a.fact-a.book)*inventoryPrice(a,prices))).slice(0,40)
      .map(r=>[r.pos,fmt(r.book),fmt(r.fact),(r.fact-r.book>0?"+":"")+fmt(r.fact-r.book)]);
    return {cols:["Позиция","Учёт","Факт","Разница"],rows,note:`Инвентаризация от ${ruDate(c.date)}. ${inventoryTotals(c)}.`};
  }
  if(key==="r_rest"){
    const usage=stockUsage(stock);
    const rows=Object.entries(stock).map(([pos,item])=>{
      const use=dailyUse(pos,item.unit,usage);
      const qty=fmt(item.qty)+(item.unit?" "+item.unit:"");
      return [pos,qty,use>0?fmt(num(item.qty)/use,0):"—"];
    });
    return rows.length?{cols:["Позиция","Остаток","Дней"],rows:rows.slice(0,40),note:usage.note}:null;
  }
  if(key==="r_reg"){
    return invoices.length?{cols:["Дата","Поставщик","Позиций","Сумма","Статус"],rows:invoices.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,40).map(i=>[i.date?ruDate(i.date):"—",i.supplier||"—",String(i.rows.length),exactMoney(i.sum),invoiceReceiptStatus(i)])}:null;
  }
  if(key==="r_pricectl"){
    if(!invoices.length||!Object.keys(P).length)return null;
    const checks=invoiceChecks();
    return {cols:["Позиция","Поставщик","Матрица","В накладной","Откл."],rows:priceControl(checks),
      note:`Сверено ${checks.filter(c=>c.matrix).length} из ${checks.length} строк. Порог отклонения — 5%.`};
  }
  if(key==="r_pricedyn"){
    const series=new Map();
    for(const invoice of invoices){
      if(!invoice.date||parseDate(invoice.date)!==invoice.date||!receiveKey(invoice.supplier))continue;
      const month=invoice.date.slice(0,7);
      for(const row of invoice.rows){
        const unit=receiveUnit(row.unit), price=readNumber(row.price);
        if(!receiveKey(row.pos)||!unit||!Number.isFinite(price)||price<=0)continue;
        const key=JSON.stringify([receiveKey(row.pos),receiveKey(invoice.supplier),unit,invoice.taxBasis||""]);
        if(!series.has(key))series.set(key,{pos:row.pos,supplier:invoice.supplier,unit:row.unit,months:new Map()});
        const {months}=series.get(key);
        if((months.get(month)?.date||"")<=invoice.date)months.set(month,{date:invoice.date,price});
      }
    }
    const rows=[];
    for(const {pos,supplier,unit,months} of series.values()){
      if(months.size<2)continue;
      const dates=[...months.keys()].sort();
      const first=months.get(dates[0]), last=months.get(dates.at(-1));
      const change=(last.price-first.price)/first.price*100;
      if(first.price===last.price)continue;
      rows.push([pos,supplier,unit,
        `${first.date.split("-").reverse().join(".")} · ${exactMoney(first.price)}`,
        `${last.date.split("-").reverse().join(".")} · ${exactMoney(last.price)}`,(change>0?"+":"")+pct(change)]);
    }
    return rows.length?{cols:["Позиция","Поставщик","Единица","Раньше","Позже","Изм."],rows:rows.slice(0,30),
      note:"Сравниваются последние цены первого и последнего доступных месяцев для одной позиции, поставщика, единицы и базы НДС."}:null;
  }
  if(key==="r_writeoff"){
    const by={};S.data.writeoffs.forEach(w=>{by[w.reason]=(by[w.reason]||0)+num(w.sum);});
    const rows=Object.keys(by).map(k=>[k,money(by[k])]);
    return rows.length?{cols:["Причина","Сумма"],rows}:null;
  }
  if(key==="r_sales"){
    if(!sales.length) return null;
    const by={};sales.forEach(s=>{const c=s.category||"без категории";by[c]=by[c]||{q:0,s:0};by[c].q+=num(s.qty);by[c].s+=num(s.sum);});
    const total=Object.values(by).reduce((a,b)=>a+b.s,0);
    return {cols:["Категория","Выручка","Доля"],rows:Object.keys(by).sort((a,b)=>by[b].s-by[a].s).map(k=>[k,money(by[k].s),total?pct(by[k].s/total*100):"—"]),note:`Всего ${money(total)} за загруженный период.`};
  }
  if(key==="r_abc"){
    const byPosition=new Map();
    for(const row of sales)byPosition.set(row.pos,(byPosition.get(row.pos)||0)+num(row.sum));
    const revenues=[...byPosition.values()].filter(value=>value>0).sort((a,b)=>b-a);
    const total=revenues.reduce((sum,value)=>sum+value,0);
    if(!total)return null;
    const groups=[{name:"A",count:0,revenue:0},{name:"B",count:0,revenue:0},{name:"C",count:0,revenue:0}];
    let cumulative=0;
    for(const value of revenues){
      const group=groups[cumulative/total<0.8?0:cumulative/total<0.95?1:2];
      group.count++;
      group.revenue+=value;
      cumulative+=value;
    }
    return {cols:["Группа","Позиций","Доля выручки"],
      rows:groups.map(group=>[group.name,String(group.count),pct(group.revenue/total*100)]),
      note:"По позициям с положительной выручкой за загруженный период."};
  }
  if(key==="r_purch"){
    if(!invoices.length) return null;
    const by={};invoices.forEach(i=>{by[i.supplier||"без поставщика"]=(by[i.supplier||"без поставщика"]||0)+num(i.sum);});
    const total=Object.values(by).reduce((a,b)=>a+b,0)||1;
    return {cols:["Поставщик","Сумма","Доля"],rows:Object.keys(by).sort((a,b)=>by[b]-by[a]).map(k=>[k,money(by[k]),pct(by[k]/total*100)])};
  }
  return null;
}
function vReports(){
  const top=!isDemo()?setup("reports"):"";
  const reminder=!isDemo()&&S.ans.system==="iiko"?
    '<div class="sec"><button class="btn s" data-a="reportreminder">Напомнить о выгрузке из iiko</button></div>':"";
  return top+reminder+REPORTS.map(g=>`<div class="sec"><div class="col" style="gap:2px"><h2>${g[0]}</h2><span class="muted">${g[1]}</span></div>
   <div class="list">${g[2].map(r=>{
     if(!isDemo()&&PREVIEW_REPORTS.has(r[0]))
       return `<div class="li"><div><b>${r[1]}</b><span class="muted">В разработке</span></div></div>`;
     const report=isDemo()?null:computeReport(r[0]);
     const ok=isDemo()||!!(r[0]==="r_variance"?report?.rows.length:report);
     const status=isDemo()?"":ok?"Данные есть":r[0]==="r_variance"?"Проверьте документы для сверки":"Нужны документы";
     return `<button class="li report-row" data-a="report" data-k="${r[0]}"><span><b>${r[1]}</b>${status?`<small class="muted">${status}</small>`:""}</span><span class="row-arrow" aria-hidden="true">›</span></button>`;
   }).join("")}</div></div>`).join("");
}
/* ---------- ИИ ---------- */

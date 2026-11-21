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
  const sales=S.data.sales, stock=effectiveStock(), inv=S.data.counts, invoices=S.data.invoices;
  if(key==="r_inv"){
    const c=inv[0]; if(!c) return null;
    const prices=matrixByPosition();
    const rows=c.rows.slice().sort((a,b)=>Math.abs((b.fact-b.book)*inventoryPrice(b,prices))-Math.abs((a.fact-a.book)*inventoryPrice(a,prices))).slice(0,40)
      .map(r=>[r.pos,fmt(r.book),fmt(r.fact),(r.fact-r.book>0?"+":"")+fmt(r.fact-r.book)]);
    return {cols:["Позиция","Учёт","Факт","Разница"],rows,note:`Инвентаризация от ${ruDate(c.date)}. ${inventoryTotals(c)}.`};
  }
  if(key==="r_rest"){
    const rows=Object.keys(stock).map(p=>{const u=dailyUse(p);return [p,fmt(stock[p].qty),u>0?fmt(num(stock[p].qty)/u,0):"—"];});
    return rows.length?{cols:["Позиция","Остаток","Дней"],rows:rows.slice(0,40)}:null;
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
    const byPos={};
    invoices.forEach(inv2=>inv2.rows.forEach(r=>{if(!r.price)return;const m=new Date(inv2.date+"T12:00:00").getMonth();(byPos[r.pos]=byPos[r.pos]||{})[m]=num(r.price);}));
    const rows=Object.keys(byPos).map(p=>{const ms=Object.keys(byPos[p]).map(Number).sort((a,b)=>a-b);const first=byPos[p][ms[0]],last=byPos[p][ms[ms.length-1]];const d=first?(last-first)/first*100:0;return [p,money(first),money(last),(d>0?"+":"")+pct(d)];}).filter(r=>r[3]!=="0,0%");
    return rows.length?{cols:["Позиция","Раньше","Сейчас","Изм."],rows:rows.slice(0,30)}:null;
  }
  if(key==="r_writeoff"){
    const by={};S.data.writeoffs.forEach(w=>{by[w.reason]=(by[w.reason]||0)+num(w.sum);});
    const rows=Object.keys(by).map(k=>[k,money(by[k])]);
    return rows.length?{cols:["Причина","Сумма"],rows}:null;
  }
  if(key==="r_sales"){
    if(!sales.length) return null;
    const by={};sales.forEach(s=>{const c=s.category||"без категории";by[c]=by[c]||{q:0,s:0};by[c].q+=num(s.qty);by[c].s+=num(s.sum);});
    const total=Object.values(by).reduce((a,b)=>a+b.s,0)||1;
    return {cols:["Категория","Выручка","Доля"],rows:Object.keys(by).sort((a,b)=>by[b].s-by[a].s).map(k=>[k,money(by[k].s),pct(by[k].s/total*100)]),note:`Всего ${money(total)} за загруженный период.`};
  }
  if(key==="r_abc"){
    if(!sales.length) return null;
    const by={};sales.forEach(s=>{by[s.pos]=(by[s.pos]||0)+num(s.sum);});
    const arr=Object.keys(by).map(k=>[k,by[k]]).sort((a,b)=>b[1]-a[1]);
    const total=arr.reduce((a,b)=>a+b[1],0)||1;
    let cum=0,A=0,B=0,C=0;
    arr.forEach(x=>{cum+=x[1]/total;if(cum<=0.8)A++;else if(cum<=0.95)B++;else C++;});
    /* FIX: убран битый return */
    return {cols:["Группа","Позиций","Доля выручки"],rows:[["A",String(A),"≈80%"],["B",String(B),"≈15%"],["C",String(C),"≈5%"]]};
  }
  if(key==="r_turn"){
    const rows=Object.keys(stock).map(p=>{const u=dailyUse(p);return [p,u>0?fmt(num(stock[p].qty)/u,0):"—"];}).filter(r=>r[1]!=="—");
    return rows.length?{cols:["Позиция","Дней на складе"],rows:rows.slice(0,30)}:null;
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
  return top+REPORTS.map(g=>`<div class="sec"><div class="col" style="gap:2px"><h2>${g[0]}</h2><span class="muted">${g[1]}</span></div>
   <div class="list">${g[2].map(r=>{
     const ok=isDemo()||!!computeReport(r[0]);
     return `<div class="li" data-a="report" data-k="${r[0]}" role="button" tabindex="0" style="cursor:pointer"><div><b>${r[1]}</b><span class="muted">${ok?"данные есть":"нужно загрузить: "+r[2].join(", ")}</span></div>${q(r[0])}</div>`;
   }).join("")}</div></div>`).join("");
}
/* ---------- ИИ ---------- */

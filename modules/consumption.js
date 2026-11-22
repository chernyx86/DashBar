"use strict";
const BAR_SALES_SOURCE="reports.sales";
const PORTION_UNITS=new Set(["шт","порц","порция","порции","порций"]);
const STOCK_UNIT_SCALE={
  "мл":["л",0.001],"л":["л",1],"г":["кг",0.001],"кг":["кг",1],"шт":["шт",1]
};

function convertQuantity(qty,from,to){
  const a=receiveUnit(from), b=receiveUnit(to);
  if(!a||!b||!Number.isFinite(qty))return null;
  if(a===b)return qty;
  const first=Object.hasOwn(STOCK_UNIT_SCALE,a)?STOCK_UNIT_SCALE[a]:null;
  const second=Object.hasOwn(STOCK_UNIT_SCALE,b)?STOCK_UNIT_SCALE[b]:null;
  return first&&second&&first[0]===second[0]?qty*first[1]/second[1]:null;
}

function groupByPosition(rows){
  const result=new Map();
  for(const row of rows){
    const key=receiveKey(row.pos);
    if(!result.has(key))result.set(key,[]);
    result.get(key).push(row);
  }
  return result;
}

function barSalesRows(){
  return S.data.sales.filter(row=>!itemTotal(row.pos)&&!/(кухн|кальян|хука)/i.test(row.category||""));
}

function salesConsumption(stock=effectiveStock()){
  const positions=stockIndex(stock);
  const cards=new Map();
  for(const card of S.data.ttk){
    if(!recipeLayout(card.sheet))continue;
    const key=receiveKey(card.name);
    if(!cards.has(key))cards.set(key,[]);
    cards.get(key).push(card);
  }
  const rows=barSalesRows().filter(row=>row.src===BAR_SALES_SOURCE);
  const totals=new Map(), skipped=new Map(), sources=[];
  let recipeSales=0;
  function ingredientUse(line,multiplier,visited,amounts){
    const key=receiveKey(line.pos), unit=line.unit||line.confirmedUnit;
    if(!unit||!Number.isFinite(line.qty)||line.qty<=0)return `«${line.pos}», строка ${line.sourceLine}: проверьте дозировку и единицу`;
    const stockItem=positions.get(key);
    if(positions.has(key)){
      const amount=stockItem?convertQuantity(line.qty*multiplier,unit,stockItem.unit):null;
      if(amount===null||!Number.isFinite(amount))return `«${line.pos}»: неоднозначная позиция или несовместимая единица склада`;
      amounts.push([key,amount]);
      return "";
    }
    const prep=cards.get(key)?.filter(card=>recipeLayout(card.sheet)==="prep")||[];
    if(prep.length!==1||visited.has(key))return `«${line.pos}»: проверьте позицию склада или карту заготовки`;
    const outputs=prep[0].outputs||[], output=outputs[0];
    const qty=output?convertQuantity(line.qty,unit,output.unit||output.confirmedUnit):null;
    if(outputs.length!==1||qty===null||!Number.isFinite(output.qty)||output.qty<=0)
      return `«${line.pos}»: проверьте выход заготовки и единицу`;
    const next=new Set(visited).add(key);
    for(const input of prep[0].rows){
      const issue=ingredientUse(input,multiplier*qty/output.qty,next,amounts);
      if(issue)return issue;
    }
    return "";
  }
  for(const [key,sales] of groupByPosition(rows)){
    const cardMatches=cards.get(key)||[], stockItem=positions.get(key);
    const label=sales[0].pos, amounts=[];
    let issue="", source=null;
    if(cardMatches.length)recipeSales++;
    if(sales.some(row=>row.qtyKnown===false||!Number.isFinite(row.qty)))issue="проверьте количество в продажах";
    else if(sales.every(row=>row.qty===0))continue;
    else if(cardMatches.length){
      const [card]=cardMatches;
      if(cardMatches.length!==1||recipeLayout(card.sheet)==="prep"||positions.has(key))issue="проверьте связь продажи с ТТК или складской позицией";
      else if(sales.some(row=>!PORTION_UNITS.has(receiveUnit(row.unit))))issue="укажите единицу продажи «порция» или «шт»";
      else{
        const portions=sales.reduce((sum,row)=>sum+row.qty,0);
        if(portions===0)continue;
        for(const line of card.rows){
          issue=ingredientUse(line,portions,new Set([key]),amounts);
          if(issue)break;
        }
        if(issue)issue+=` · ${card.file}, лист «${card.sheet}»`;
        else source=[label,fmt(portions,4),`${card.file} · ${card.sheet} · строка ${card.sourceLine}`];
      }
    }else if(stockItem){
      for(const row of sales){
        const amount=convertQuantity(row.qty,row.unit,stockItem.unit);
        if(amount===null){issue="единица продажи не совпадает со складской";break;}
        amounts.push([key,amount]);
      }
    }else issue="сопоставьте название с рабочей ТТК или складской позицией";
    if(issue){skipped.set(key,[label,issue]);continue;}
    if(source)sources.push(source);
    for(const [position,amount] of amounts)totals.set(position,(totals.get(position)||0)+amount);
  }
  return {positions,totals,skipped,recipeSales,sources};
}

function inventoryWindow(start,end,warehouse){
  const openingDate=new Date(Date.parse(start)-86400000).toISOString().slice(0,10);
  const pick=date=>{
    const sameDay=S.data.counts.filter(count=>count.date===date&&count.warehouse&&receiveKey(count.warehouse)===receiveKey(warehouse));
    if(sameDay.length!==1)return {rows:new Map(),note:`На ${ruDate(date)} нужен один сохранённый пересчёт склада «${warehouse}».`};
    return {count:sameDay[0],rows:groupByPosition(sameDay[0].rows)};
  };
  const receipts=S.data.receipts.filter(receipt=>receipt.date>=start&&receipt.date<=end&&receiveKey(receipt.warehouse)===receiveKey(warehouse));
  return {opening:pick(openingDate),closing:pick(end),received:groupByPosition(receipts.flatMap(receipt=>receipt.rows))};
}

function inventoryNormReport(stock){
  const period=barSalesPeriod();
  const cols=["Позиция","Норма расхода","Факт остатка","Остаток iiko","Расчётный остаток¹","Факт − расчёт¹"];
  if(!period.duration)return {cols,rows:[],note:period.note};
  const usage=salesConsumption(stock);
  const warehouse=S.sec.stock.docs.rest?.res?.snapshot?.warehouse||S.venue.stockName.trim()||"Бар";
  const {opening,closing,received}=inventoryWindow(period.start,period.end,warehouse);
  const reference=S.data.stockReference;
  const endStock=reference?.snapshot?.date===period.end&&receiveKey(reference.snapshot.warehouse)===receiveKey(warehouse)?
    stockIndex(reference.stock):new Map();
  const amount=(qty,unit)=>Number.isFinite(qty)?`${fmt(qty,4)} ${unit}`:"—";
  const rows=[];
  for(const [key,item] of usage.positions){
    if(!item?.unit)continue;
    const consumed=usage.totals.get(key), endRows=closing.rows.get(key)||[], startRows=opening.rows.get(key)||[];
    const last=endRows.length===1?endRows[0]:null;
    if(!Number.isFinite(consumed)&&!last)continue;
    const first=startRows.length===1?startRows[0]:null;
    const fact=last?convertQuantity(last.fact,last.unit,item.unit):null;
    const refItem=endStock.get(key);
    const book=last&&(closing.count.bookVerified||last.sources?.book)?
      convertQuantity(last.book,last.unit,item.unit):refItem?
        convertQuantity(reference.stock[refItem.name].qty,refItem.unit,item.unit):null;
    const initial=first?convertQuantity(first.fact,first.unit,item.unit):null;
    const additions=(received.get(key)||[]).map(row=>convertQuantity(row.qty,row.unit,item.unit));
    const estimate=!usage.skipped.size&&Number.isFinite(consumed)&&initial!==null&&fact!==null&&additions.every(Number.isFinite)?
      initial+additions.reduce((sum,qty)=>sum+qty,0)-consumed:null;
    rows.push([item.name,amount(consumed,item.unit),amount(fact,item.unit),amount(book,item.unit),
      amount(estimate,item.unit),amount(estimate===null?null:fact-estimate,item.unit)]);
  }
  const notes=[period.note,`Склад «${warehouse}».`];
  if(opening.note)notes.push(opening.note);
  if(closing.note)notes.push(closing.note);
  if(usage.skipped.size)notes.push(`Норма рассчитана по сопоставленным продажам. Проверьте позиций: ${usage.skipped.size}.`);
  if(!usage.totals.size)notes.push("Нет расхода, сопоставленного со складом. Загрузите остатки и проверьте названия и единицы.");
  if(usage.recipeSales)notes.push("Использованы загруженные рабочие ТТК. Проверьте их действие на даты продаж.");
  notes.push("¹ Предварительно: факт на конец дня перед началом периода + приходы, проведённые в DashBar за период, − норма расхода. Сверьте полноту приходов, списания и перемещения по iiko.");
  return {cols,rows,note:notes.join(" "),issues:[...usage.skipped.values()],recipeSources:usage.sources};
}

"use strict";
function ctx(){
  const f=findings().map(x=>`- [${SEC[x.sec]?SEC[x.sec].title:x.sec}] ${x.title}: ${x.detail} Решение: ${x.solution||"нет"} (${fst(x.id).status?"закрыто":"открыто"})`).join("\n");
  const docs=Object.keys(S.sec).map(k=>Object.keys(S.sec[k].docs).filter(d=>S.sec[k].docs[d]&&S.sec[k].docs[d].res).map(d=>`- ${SEC[k].title}: ${S.sec[k].docs[d].res.doc_type}, ${S.sec[k].docs[d].res.summary}`).join("\n")).filter(Boolean).join("\n");
  const data=isDemo()?"":"Цены в матрице: "+Object.keys(S.data.prices).length+". Остатков: "+Object.keys(S.data.stock).length+". Инвентаризаций: "+S.data.counts.length+". Накладных: "+S.data.invoices.length+". Продаж: "+S.data.sales.length+".";
  return `Заведение: ${venueName()}${isDemo()?" (вымышленный пример)":""}. Город: ${S.venue.city||"не указан"}. Только бар.
Анкета: проблема: ${S.ans.problem||"—"}; система: ${S.ans.system||"—"}; доступ: ${S.ans.access||"—"}; документы: ${S.ans.flow.join(", ")||"—"}.
${data}
Загруженные документы:\n${docs||"нет"}
Находки:\n${f||"нет"}`;
}
const BAR_GLOSSARY=[
  [/^(пересорт|пересортиц)/,"Пересорт — возможный перенос остатка между похожими позициями. Сверьте недостачу и излишек по каждой позиции перед корректировкой."],
  [/^(инвент|ревизи)/,"Инвент — инвентаризация: пересчёт факта и сравнение с учётными остатками на ту же дату."],
  [/^(ттк|ttk|техкарт)/,"ТТК — технико-технологическая карта. Для расчёта расхода нужны ингредиенты, дозировки и единицы."],
  [/^(пф|pf|полуфабрикат)/,"ПФ — полуфабрикат или заготовка. Для расчёта расхода по вложенной карте нужен выход партии."],
  [/^(бевкост|bev|beverage)/,"Бевкост (beverage cost) — доля себестоимости проданных напитков в выручке от напитков за тот же период."],
  [/^(осв|оборотк)/,"ОСВ — оборотно-сальдовая ведомость. Показывает остатки и движения за период. Проверьте, какие движения выгружены в количестве."],
  [/^(стоп)/,"Стоп-лист — позиции, временно недоступные к продаже. Недостаток складского остатка помогает определить, что проверить перед сменой."],
  [/^(шринк|shrink)/,"Шринк — потери запасов или расхождение с учётом. Сначала проверьте списания, перемещения и факт пересчёта."]
];
function assistantTopics(text){
  const normalized=normHeader(text).replace(/(?:^|\s)п\s+ф(?=\s|$)/g," пф").trim();
  const words=normalized.split(" ");
  const has=pattern=>words.some(word=>pattern.test(word));
  const topics={
    variance:/факт и норм|факт против норм|нормативн.*расход|норм.*расход/.test(normalized),
    inventory:has(/^(инв$|инвент|пересорт|пересчет|ревизи|недостач|излиш|шринк|shrink)/),
    price:has(/^(цен|накл|поставщик|дорог|подорож|удорож|матриц|закуп|прайс|приход)/),
    stock:has(/^(заказ|заканч|остат|хватит|стоп|дефицит|наличи|ноль$|нулев)/),
    recipes:has(/^(техкарт|рецептур|ттк$|ttk$|тк$|пф$|pf$|заготов|выход|дозиров|граммовк|калькуляц|дэш|деш)/),
    cost:has(/^(бевкост|себестоим|bev$|beverage$)/),
    movement:has(/^(списан|пролив|бой$|боя$|перемещен|перем$|утилизац)/),
    sales:has(/^(продаж|реализац|выруч|abc$|абс$)/),
    reports:has(/^(отчет|выгрузк|осв$|оборотк|бухгалтер)/)
  };
  if(has(/^(минус|недосдач)/)&&!topics.stock)topics.inventory=true;
  if(has(/^минус/)&&topics.stock)topics.negativeStock=true;
  if(has(/^расхожд/)&&!topics.price&&!topics.recipes&&!topics.variance)topics.inventory=true;
  const glossary=/что такое|что значит|расшифруй|как расшифровывается/.test(normalized)?
    BAR_GLOSSARY.filter(([pattern])=>has(pattern)).map(([,definition])=>definition):[];
  return {topics,glossary};
}

function localAnswer(text){
  const {topics:t,glossary}=assistantTopics(text), L=[];
  if(glossary.length)return glossary.join("\n\n");
  const f=findings().filter(open);
  if(t.inventory){
    const c=S.data.counts[0];
    if(c){
      L.push(`Последняя инвентаризация ${ruDate(c.date)}: ${inventoryTotals(c)}.`);
      const rows=c.rows.filter(r=>Number.isFinite(r.fact)&&Number.isFinite(r.book)&&r.fact!==r.book)
        .sort((a,b)=>Math.abs(num(b.sum))-Math.abs(num(a.sum))).slice(0,5);
      const [section,doc]=String(c.src||"").split(".");
      const source=S.sec[section]?.docs?.[doc]?.name;
      if(rows.length)L.push("Подтверждённые расхождения:\n"+rows.map(r=>{
        const diff=r.fact-r.book, unit=r.unit?" "+r.unit:"";
        const origin=source&&r.sourceLine?` · ${source}, строка ${r.sourceLine}`:"";
        return `• ${r.pos}: учёт ${fmt(r.book)}${unit}, факт ${fmt(r.fact)}${unit} (${diff>0?"+":"−"}${fmt(Math.abs(diff))}${unit})${origin}`;
      }).join("\n"));
      if(rows.length)L.push("Сверьте движения за период и проверьте единицы измерения до корректировки учёта.");
      if(possibleResort(c))L.push("Суммы почти равны. Возможна пересортица. Сверьте позиции по товарным группам.");
    } else L.push("Инвентаризаций пока нет. Загрузите сличительную ведомость в «Склад» — тогда покажу расхождения и пересортицу.");
  }
  if(t.price){
    const pc=isDemo()?[["Лимон","Фрукты и зелень","198 ₽","312,4 ₽","+58%"],["Тоник 0,2","—","74 ₽","86 ₽","+16%"]]:priceControl();
    if(pc.length)L.push("Цены выше или ниже матрицы:\n"+pc.slice(0,5).map(r=>`• ${r[0]}: матрица ${r[2]}, в накладной ${r[3]} (${r[4]})`).join("\n"));
    else L.push("Отклонений цен не видно: либо всё в пределах 5%, либо не хватает накладных или матрицы цен.");
    if(!isDemo()&&!Object.keys(S.data.prices).length)L.push("Матрица цен пуста — загрузите её в «Приёмке».");
  }
  if(t.stock){
    const stock=stockEntries(), usage=stockUsage(), low=[];
    for(const [pos,item] of stock){
      const qty=num(item.qty), use=dailyUse(pos,item.unit,usage);
      if(t.negativeStock?qty<0:qty<=0||use>0&&qty/use<=S.set.lowDays)low.push({pos,qty,days:qty<=0?0:qty/use});
    }
    low.sort((a,b)=>a.days-b.days);
    if(low.length)L.push((t.negativeStock?"Отрицательные остатки:":"Заканчивается:")+"\n"+low.slice(0,6).map(({pos,qty,days})=>
      `• ${pos}: остаток ${fmt(qty)}, ${qty<=0?"проверьте наличие":`хватит на ${fmt(days,1)} дн.`}`).join("\n"));
    if(!stock.length)L.push("Остатков пока нет. Загрузите отчёт об остатках в разделе «Склад».");
    else if(t.negativeStock&&!low.length)L.push("Отрицательных остатков в загруженных данных нет.");
    else if(!usage.duration)L.push(usage.note);
    else if(!low.length)L.push("Среди позиций с сопоставимыми продажами запас ниже порога не найден.");
  }
  if(t.recipes){
    const c=f.filter(x=>x.sec==="cards");
    if(c.length)L.push("По техкартам открыто:\n"+c.slice(0,4).map(x=>"• "+x.title).join("\n"));
    else if(S.data.ttk.length)L.push(`Загружено карт: ${S.data.ttk.length}. Выходы и дозировки заготовок проверяются в «Техкартах».`);
    else L.push("Загрузите рабочие ТТК и карты заготовок в «Техкартах».");

  }
  if(t.reports){
    const sys=S.ans.system||"ваша учётная система";
    L.push(`Для ${sys} нужны: продажи за месяц, остатки, инвентаризации и накладные. Точные названия отчётов указаны в подсказках «?» у каждого документа в разделах.`);
  }
  if(t.variance)L.push("Нормативный расход и факт за тот же период смотрите в «Отчёты → Факт и норма». Нужны продажи, рабочие ТТК и инвентаризации.");
  if(t.cost)L.push("Бевкост — доля себестоимости продаж напитков в выручке от напитков. Рабочий расчёт себестоимости пока в разработке.");
  if(t.movement){
    const report=computeReport("r_writeoff");
    if(report)L.push("Списания в загруженных актах:\n"+report.rows.slice(0,5).map(([reason,sum])=>`• ${reason}: ${sum}`).join("\n"));
    else L.push("Для боя, проливов и порчи загрузите акты в «Отчёты → Списания».");
    if(/перемещ|перем\.?$/i.test(text))L.push("Для сверки перемещений нужны документы с количеством по товару, датой и складом.");
  }
  if(t.sales){
    const report=computeReport("r_sales");
    L.push(report?"Продажи бара. "+report.note:"Загрузите продажи бара в «Отчётах».");
  }
  if(!L.length){
    if(f.length)L.push("Сейчас открыто:\n"+f.slice(0,5).map(x=>"• "+x.title).join("\n"));
    else L.push("Открытых находок нет.");
    if(!S.data.counts.length&&!isDemo())L.push("Начните с инвентаризации: «Склад» → загрузить ведомость или начать ввод.");
  }
  L.push("Это локальный ответ по вашим данным, без внешнего ИИ.");
  return L.join("\n\n");
}
function assistantAvailable(){
  return !isDemo()&&incoming.connected&&incoming.assistantAvailable;
}
function assistantContext(){
  return {
    invoices:S.data.invoices.length,
    price_items:Object.keys(S.data.prices).length,
    stock_items:stockEntries().length,
    counts:S.data.counts.length,
    sales_rows:S.data.sales.length
  };
}
async function sendChat(text, external=false){
  if(chatBusy)return;
  const state=S;
  const local=localAnswer(text);
  S.chat.push({role:"user",content:text});
  const last={role:"assistant",content:"…"};
  S.chat.push(last);chatBusy=true;render();
  try{
    if(external&&assistantAvailable()){
      const result=await incomingRequest("/assistant",{method:"POST",
        body:{question:text,context:assistantContext()}});
      if(typeof result?.answer!=="string"||!result.answer.trim())throw new Error();
      last.content="Ответ внешнего ИИ:\n"+result.answer+"\n\nПроверка по данным DashBar:\n"+local;
    }else{
      last.content=local;
    }
  }catch{
    last.content=local+"\n\nВнешний ИИ недоступен.";
  }finally{
    chatBusy=false;
    if(S===state||S.tab==="ai")render();
  }
}

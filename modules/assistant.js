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
function localAnswer(text){
  const t=text.toLowerCase(), L=[];
  const f=findings().filter(open);
  const priceOf=p=>S.data.prices[p]?num(S.data.prices[p].price):0;
  if(/инвентар|расхожд|пересорт|недостач|излиш/.test(t)){
    const c=S.data.counts[0];
    if(c){
      L.push(`Последняя инвентаризация ${ruDate(c.date)}: ${inventoryTotals(c)}.`);
      const rows=c.rows.filter(r=>r.fact!==r.book).sort((a,b)=>Math.abs((b.fact-b.book)*priceOf(b.pos))-Math.abs((a.fact-a.book)*priceOf(a.pos))).slice(0,5);
      if(rows.length)L.push("Сильнее всего расходится:\n"+rows.map(r=>`• ${r.pos}: учёт ${fmt(r.book)}, факт ${fmt(r.fact)} (${r.fact-r.book>0?"+":"−"}${fmt(Math.abs(r.fact-r.book))})`).join("\n"));
      if(possibleResort(c))L.push("Суммы почти равны. Возможна пересортица. Сверьте позиции по товарным группам.");
    } else L.push("Инвентаризаций пока нет. Загрузите сличительную ведомость в «Склад» — тогда покажу расхождения и пересортицу.");
  } else if(/цен|накладн|поставщик|дорог|матриц/.test(t)){
    const pc=isDemo()?[["Лимон","Фрукты и зелень","198 ₽","312,4 ₽","+58%"],["Тоник 0,2","—","74 ₽","86 ₽","+16%"]]:priceControl();
    if(pc.length)L.push("Цены выше или ниже матрицы:\n"+pc.slice(0,5).map(r=>`• ${r[0]}: матрица ${r[2]}, в накладной ${r[3]} (${r[4]})`).join("\n"));
    else L.push("Отклонений цен не видно: либо всё в пределах 5%, либо не хватает накладных или матрицы цен.");
    if(!isDemo()&&!Object.keys(S.data.prices).length)L.push("Матрица цен пуста — загрузите её в «Приёмке».");
  } else if(/заказ|заканч|остат|хватит/.test(t)){
    const stock=stockEntries(), low=[];
    for(const [pos,item] of stock){
      const qty=num(item.qty), use=dailyUse(pos);
      if(qty<=0||use>0&&qty/use<=S.set.lowDays)low.push({pos,qty,days:qty<=0?0:qty/use});
    }
    low.sort((a,b)=>a.days-b.days);
    if(low.length)L.push("Заканчивается:\n"+low.slice(0,6).map(({pos,qty,days})=>
      `• ${pos}: остаток ${fmt(qty)}, ${qty<=0?"проверьте наличие":`хватит на ${fmt(days,1)} дн.`}`).join("\n"));
    if(!stock.length)L.push("Остатков пока нет. Загрузите отчёт об остатках в разделе «Склад».");
    else if(!S.data.sales.length)L.push("Для расчёта запаса в днях загрузите продажи за месяц.");
    else if(!low.length)L.push("По позициям с известным расходом запас выше заданного порога.");
  } else if(/техкарт|ттк|себестоим|калькуляц/.test(t)){
    const c=f.filter(x=>x.sec==="cards");
    L.push(c.length?"По техкартам открыто:\n"+c.slice(0,4).map(x=>"• "+x.title).join("\n"):"По техкартам открытых находок нет. Загрузите рабочие ТТК в «Техкартах».");
  } else if(/отчёт|запрос|бухгалтер|выгрузк/.test(t)){
    const sys=S.ans.system||"ваша учётная система";
    L.push(`Для ${sys} нужны: продажи за месяц, остатки, инвентаризации и накладные. Точные названия отчётов указаны в подсказках «?» у каждого документа в разделах.`);
  } else {
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

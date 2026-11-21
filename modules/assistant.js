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
    const low=[];stockEntries().forEach(([p,item])=>{const u=dailyUse(p),q=num(item.qty);if(u>0&&q/u<=S.set.lowDays)low.push([p,q,Math.round(q/u)]);});
    if(low.length)L.push("Заканчивается:\n"+low.slice(0,6).map(x=>`• ${x[0]}: остаток ${fmt(x[1])}, хватит на ${x[2]} дн.`).join("\n"));
    else L.push("По остаткам и продажам критичных позиций нет.");
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
async function sendChat(text){
  S.chat.push({role:"user",content:text});
  const last={role:"assistant",content:"…"};
  S.chat.push(last);chatBusy=true;render();
  if(sampleFn){
    const hist=S.chat.slice(0,-1).slice(-12);
    const sys=`Ты ИИ-ассистент приложения BarManager AI: помощник барменеджера. Отвечай по-русски, коротко и по делу, профессиональными терминами HoReCa. Приложение не правит данные само. Не выдумывай цифры; если данных не хватает, скажи, какой отчёт загрузить. Без Markdown.
Данные приложения:\n${ctx()}\n\nВопрос: `;
    const input=hist.map((m,i)=>({role:m.role,content:i===0?sys+m.content:m.content}));
    if(input[0].role!=="user")input.unshift({role:"user",content:sys+"(продолжение)"});
    try{
      const out=await sampleFn(input,{cache:false,onText:({text:tx})=>{last.content=tx;const el=document.querySelector("#chat .msg:last-child");if(el){el.textContent=tx;const m=document.getElementById("main");m.scrollTop=m.scrollHeight;}}});
      last.content=out.text||last.content;
    }catch(e){
      last.content=localAnswer(text)+"\n\n(ИИ недоступен, ответ собран локально.)";
    }
  } else {
    await new Promise(r=>setTimeout(r,180));
    last.content=localAnswer(text);
  }
  chatBusy=false;render();
}

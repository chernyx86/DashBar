"use strict";
/* ================= Экраны ================= */
function surveyFields(){return `
   <div class="field"><div class="between"><span>Что отнимает больше всего времени или денег?</span>${q("partial")}</div>${pills("ans.problem",["Инвентаризация и расхождения","Накладные и цены","Техкарты и себестоимость","Заказы поставщикам"],S.ans.problem)}</div>
   <div class="field"><div class="between"><span>Учётная система</span>${q("receiving")}</div>${pills("ans.system",["iiko","R-Keeper и StoreHouse","Quick Resto","Другая","Нет"],S.ans.system)}</div>
   <div class="field"><div class="between"><span>Ваш доступ к ней</span>${q("receiving")}</div>${pills("ans.access",["Вхожу сам","Выгрузки через бухгалтера","Доступа нет"],S.ans.access)}</div>
   <div class="field"><div class="between"><span>Через что идут накладные и алкоголь</span>${q("receiving")}</div>${pills("ans.flow",["DocsInBox","Другой сервис ЭДО","Бумажные накладные","Не знаю"],S.ans.flow,true)}<span class="muted">Можно выбрать несколько.</span></div>
`; }
function onboarding(){
  const st=S.step, n={who:1,venue:2,three:3}[st];
  const top=n?`<div class="head"><div class="bar">${[1,2,3].map(i=>`<span class="${i<=n?"on":""}"></span>`).join("")}</div><div class="between"><span class="muted">Шаг ${n} из 3</span><button class="link" data-a="back">Назад</button></div></div>`:"";
  if(st==="start") return `<div class="main hero">
   <div class="between"><span class="row"><span class="seal" aria-hidden="true">D</span><span class="logo">DashBar</span></span><button class="icon-btn" data-a="theme">${effTheme()==="dark"?"Светлая":"Тёмная"}</button></div>
   <div class="rule"></div>
   <h1>Управление баром</h1>
   <p class="sub">Приложение следит за накладными, ценами, техкартами и инвентаризацией. Находит отклонение, объясняет причину и предлагает решение. Решаете вы.</p>
   <div class="list">
    <div class="li"><div><b>Накладные и цены</b><span class="muted">Сверка с приходом и матрицей цен</span></div></div>
    <div class="li"><div><b>Техкарты</b><span class="muted">Рабочие ТТК против учётной системы</span></div></div>
    <div class="li"><div><b>Инвентаризация</b><span class="muted">Пересортица отдельно от потерь</span></div></div>
   </div>
   <div class="hero-actions"><button class="btn p" data-a="own">${started()?"Продолжить со своим баром":"Начать со своим баром"}</button>${progress()<50?`<button class="btn" data-a="demo">Посмотреть на примере бара</button>`:""}</div>
   ${started()?`<p class="muted">${esc(S.venue.name||"Мой бар")}: данные внесены на ${progress()}%.</p>`:""}
   <p class="muted">Документы разбираются на устройстве. Фото и сканы читает ИИ, если он подключён.</p></div>`;
  if(st==="who") return top+`<div class="main"><div class="col"><h1>Знакомство</h1><p class="sub">Имя появится в профиле менеджера.</p></div>
   <label class="field">Как вас зовут<input class="in" id="f-name" data-b="user.name" value="${esc(S.user.name)}" autocomplete="given-name"></label>
   <label class="field">Телефон<input class="in" id="f-phone" data-b="user.phone" value="${esc(S.user.phone)}" inputmode="tel" placeholder="+7"></label>
   <p class="muted">Имя и телефон необязательны. Профиль хранится в этом браузере.</p></div>
   <div class="foot"><button class="btn p" data-a="next" data-s="venue">Дальше</button></div>`;
  if(st==="venue") return top+`<div class="main"><div class="col"><h1>Заведение</h1><p class="sub">Приложение ведёт только бар: кухня и кальян в учёт не входят.</p></div>
   <label class="field">Название точки<input class="in" id="f-vname" data-b="venue.name" value="${esc(S.venue.name)}"></label>
   <label class="field">Город<input class="in" id="f-city" data-b="venue.city" value="${esc(S.venue.city)}"></label>
   <label class="field">Название склада бара в учёте<input class="in" data-b="venue.stockName" value="${esc(S.venue.stockName)}" placeholder="Необязательно"></label>
   <div class="field">Формат${pills("venue.format",["Бар","Паб","Кальянная","Ресторан","Другое"],S.venue.format)}</div>
   <div class="field">Сколько точек ведёте${pills("venue.points",["1","2","3"],String(S.venue.points))}<span class="muted">Текущий профиль ведёт одну точку.</span></div></div>
   <div class="foot"><button class="btn p" data-a="next" data-s="three">Дальше</button></div>`;
  return top+`<div class="main"><div class="col"><h1>Как работает ваш бар</h1><p class="sub">Остальное спросим позже, когда откроете раздел.</p></div>
   ${surveyFields()}</div>
   <div class="foot"><button class="btn p" data-a="enter" ${S.ans.problem&&S.ans.system?"":"disabled"}>Открыть приложение</button>${S.ans.problem&&S.ans.system?"":'<span class="muted">Ответьте на первые два вопроса.</span>'}</div>`;
}

const ICON={today:'<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
 receiving:'<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 13l2.2 2.2L15 11"/>',
 stock:'<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
 cards:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
 reports:'<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
 ai:'<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'};
const ALL_TABS=[["today","Сегодня"],["receiving","Приёмка"],["stock","Склад"],["cards","Техкарты"],["reports","Отчёты"],["ai","ИИ"]];
const TITLE={today:"Сегодня",receiving:"Приёмка",stock:"Склад",cards:"Техкарты",reports:"Отчёты",ai:"ИИ-ассистент"};
function tabs(){return ALL_TABS;}

/* ---------- Сегодня ---------- */
const FOCUS={
  "Инвентаризация и расхождения":["stock","inv"],
  "Накладные и цены":["receiving","invoice"],
  "Техкарты и себестоимость":["cards","ttk"],
  "Заказы поставщикам":["stock","rest"]
};
function workflowStep(){
  const [tab,key]=FOCUS[S.ans.problem]||["stock","rest"];
  const access=S.ans.access==="Выгрузки через бухгалтера"?"Запросите выгрузку у бухгалтера. ":
    S.ans.access==="Доступа нет"?"Можно начать с собственной таблицы. ":"";
  const docs=S.sec[tab].docs, questions=S.sec[tab].q;
  if(tab==="receiving"){
    if(!S.data.invoices.length)return {tab,anchor:"doc-invoice",label:"Подключить источник накладных",note:access+
      (S.ans.flow.includes("Бумажные накладные")?"Подготовьте табличную копию бумажной накладной.":
      S.ans.flow.some(f=>f==="DocsInBox"||f==="Другой сервис ЭДО")?"Возьмите файл из ЭДО или добавьте источник в «Приёмке».":"Начните с одной барной накладной.")};
    if(!Object.keys(S.data.prices).length)return {tab,anchor:"doc-matrix",label:questions.matrix==="Нет, собрать"?"Добавить договорную цену":"Подключить матрицу цен",
      note:questions.matrix==="Нет, собрать"?"Запишите хотя бы одну согласованную цену поставщика.":"Загрузите подтверждённые цены с поставщиком и единицей."};
    return {tab,anchor:"receiving-checks",label:"Проверить закупочные цены",note:questions.who==="Бухгалтерия с задержкой"?
      "Передайте бухгалтеру список накладных с непроверенным проведением.":questions.who==="Нерегулярно"?
      "Сверьте состояние реестра с учётной системой перед закрытием периода.":"Сверьте сегодняшние строки с договорными ценами."};
  }
  if(tab==="cards"){
    const path={"Google Таблица":"Подготовьте экспорт рабочего листа в Excel или CSV.","Excel":"Выберите файл с рабочей картой.",
      "На бумаге":"Перенесите карту в таблицу с ингредиентами, единицами и выходом.","Только в учётной системе":"Выгрузите карту из вашей учётной системы."}[questions.where]||"Подготовьте рабочую карту с ингредиентами и выходом.";
    return {tab,anchor:"doc-ttk",label:docs.ttk?.res?"Проверить техкарты":"Загрузить техкарту",
      note:access+path+(questions.prep==="Да"?" Для заготовок укажите выход замеса.":"")};
  }
  if(!stockEntries().length)return {tab,anchor:"doc-rest",label:"Загрузить остатки бара",note:access+docsFor("stock").find(d=>d[0]==="rest")[3]};
  if(key==="rest")return {tab,anchor:"stock-order",label:"Проверить заказ",note:S.data.sales.length?
    "Сверьте предложенные количества с ближайшими поставками.":"Заполните заказ вручную или загрузите продажи для оценки расхода."};
  const last=S.data.counts[0]?.date;
  const interval={"Раз в неделю":[7,0],"Раз в две недели":[14,0],"Раз в месяц":[0,1]}[questions.freq];
  const next=last&&interval&&scheduleCount(last,interval);
  return {tab,anchor:"stock-count",label:S.draft?"Продолжить инвентаризацию":"Открыть инвентаризацию",
    note:[next?"Плановый ориентир по вашей периодичности — "+ruDate(next)+".":"",
      questions.where==="В таблицу бухгалтерии"?"Результат можно передать бухгалтеру из отчёта.":"",
      questions.where==="На бумагу"?"Перенесите фактические количества с бланка.":"",
      questions.where==="Сразу в учётную систему"?"После сверки внесите подтверждённые данные в учётную систему.":""].filter(Boolean).join(" ")||"Сверьте факт и остатки по одной дате."};
}
function scheduleCount(iso,[days,months]){
  const d=new Date(iso+"T12:00:00Z");
  if(!Number.isFinite(d.getTime()))return "";
  if(months){
    const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
    const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,end));
  }else d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
function workflowCard(){
  if(isDemo()||!S.ans.problem)return "";
  const step=workflowStep();
  return `<div class="sec focus-card"><h2>${esc(S.ans.problem)}</h2><p>${esc(step.note)}</p><div class="row">
    <button class="btn p" data-a="tab" data-t="${step.tab}" data-anchor="${step.anchor}">${esc(step.label)}</button>
    <button class="link" data-a="survey">Изменить ответы</button></div></div>`;
}
function vToday(){
  const fs=findings();
  const focusTab=FOCUS[S.ans.problem]?.[0];
  const tasks=isDemo()?fs.filter(f=>f.task&&open(f)):fs.filter(open)
    .sort((a,b)=>Number(b.sec===focusTab)-Number(a.sec===focusTab)).slice(0,4);
  const ds=days();
  const setupList=!isDemo()?(()=>{
    const first={"Инвентаризация и расхождения":"stock","Накладные и цены":"receiving","Техкарты и себестоимость":"cards","Заказы поставщикам":"stock"}[S.ans.problem]||"stock";
    const ord=[first,...["stock","receiving","cards","reports"].filter(k=>k!==first)];
    const off=ord.filter(k=>!secOn(k)&&tabs().some(([tab])=>tab===k));
    return off.length?`<div class="sec"><div class="between"><h2>${off.length===tabs().filter(([tab])=>SEC[tab]).length?"Что включить первым":"Осталось включить"}</h2>${q("partial")}</div>
     <div class="list">${off.map(k=>`<div class="li"><div><b style="font-weight:600;font-size:15px">${SEC[k].title}</b><span class="muted">${SEC[k].line}</span></div><button class="btn s" data-a="tab" data-t="${k}">Начать</button></div>`).join("")}</div></div>`:"";
  })():"";
  const stats=isDemo()?`<div class="grid2">${DEMO.stats.map(s=>`<div class="tile"><div class="between"><span class="l">${s[1]}</span>${q("stats")}</div><span class="n">${s[2]}</span><span class="f">${s[3]}</span></div>`).join("")}</div>`
   :(()=>{const st=liveStats();
     if(!st) return `<div class="card"><p class="muted">Цифры появятся после загрузки продаж за месяц и матрицы цен.</p><button class="btn s" data-a="tab" data-t="reports" style="align-self:flex-start">Загрузить продажи</button></div>`;
     return `<div class="grid2">${st.map(s=>`<div class="tile"><div class="between"><span class="l">${esc(s[1])}</span>${q("stats")}</div><span class="n">${esc(s[2])}</span><span class="f">${esc(s[3])}</span></div>`).join("")}</div>`;})();
  const dev=fs.filter(f=>f.value);
  const items=eventsOn(ds[S.day].iso);
  return `${workflowCard()}
  <div class="sec"><div class="between"><div class="row"><h2>Задачи</h2>${q("tasks")}</div><span class="muted">${tasks.length?tasks.length+" на сегодня":""}</span></div>
   ${tasks.length?tasks.map(f=>fcard(f)).join(""):`<div class="card"><p class="muted">${fs.length?"Открытых задач нет.":"Задачи появятся после первого разобранного документа."}</p></div>`}</div>
  <div class="sec"><div class="between"><div class="row"><h2>Статистика бара</h2>${q("stats")}</div><span class="muted">${isDemo()?DEMO.period:"30 дней"}</span></div>${stats}</div>
  <div class="sec"><div class="row"><h2>Отклонения</h2>${q("deviations")}</div>
   ${dev.length?`<div class="list">${dev.map(f=>`<div class="li" data-a="decide" data-id="${f.id}" role="button" tabindex="0" style="cursor:pointer"><div><b>${esc(f.title)}</b><span class="muted">${esc(f.detail)}</span></div><span class="val ${f.n?"n":fst(f.id).status?"ok":""}">${fst(f.id).status==="done"?"решено":esc(f.value)}</span></div>`).join("")}</div>`:`<div class="card"><p class="muted">Пока сравнивать не с чем.</p></div>`}</div>
  ${setupList}
  <div class="sec"><div class="row"><h2>Календарь задач</h2>${q("calendar")}<span style="flex:1"></span><button class="btn s" data-a="eventnew">Событие</button></div>
   <div class="days">${ds.map(d=>`<button class="day" data-a="day" data-i="${d.i}" aria-pressed="${S.day===d.i}">${d.wd}<b>${d.n}</b>${eventsOn(d.iso).length?"<i></i>":""}</button>`).join("")}</div>
   <div class="list">${items.length?items.map(x=>`<div class="li"><div><b>${esc(x.title)}</b></div><div class="row"><span class="muted">${esc(x.kind)}</span>${x.own?`<button class="q" data-a="eventdel" data-id="${x.id}" aria-label="Удалить">×</button>`:""}</div></div>`).join(""):`<div class="li"><div><span class="muted">На ${esc(ds[S.day].label)} ничего не назначено. День заказа и дату инвентаризации можно задать в настройках.</span></div></div>`}</div></div>`;
}
function liveStats(){
  const sales=S.data.sales, stock=S.data.stock, counts=S.data.counts;
  if(!sales.length&&!counts.length&&!S.data.invoices.length)return null;
  const rev=sales.reduce((a,b)=>a+num(b.sum),0);
  const cnt=sales.reduce((a,b)=>a+num(b.qty),0);
  const openInv=S.data.invoices.filter(i=>!i.receiptAt&&i.status!=="проведена").length;
  const res=[];
  res.push(["revenue","Выручка бара",rev?money(rev):"—",rev?"по загруженным продажам":"нет продаж"]);
  res.push(["cost","Beverage cost","—","себестоимость продаж ещё не рассчитана"]);
  res.push(["sold","Продано позиций",cnt?fmt(cnt,0):"—","по загруженным продажам"]);
  res.push(["compl","Ожидают прихода",String(openInv),"накладные в реестре"]);
  return res;
}

"use strict";
/* ================= Утилиты ================= */
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const num=v=>{if(typeof v==="number")return isFinite(v)?v:0;const s=String(v==null?"":v).replace(/\s|₽|руб\.?/gi,"").replace(",",".");const n=parseFloat(s);return isFinite(n)?n:0;};
const fmt=(n,d=2)=>{const x=num(n);return x.toLocaleString("ru-RU",{maximumFractionDigits:d});};
const money=n=>fmt(n,0)+" ₽";
const exactMoney=n=>fmt(n,2)+" ₽";
function readNumber(v){
  if(typeof v==="number")return Number.isFinite(v)?v:NaN;
  const s=String(v??"").trim().replace(/\s*(?:₽|руб\.?)$/i,"")
    .replace(/(\d)[ \u00a0\u202f](?=\d{3}(?:[ \u00a0\u202f.,]|$))/g,"$1").replace(",",".");
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)?Number(s):NaN;
}
const cents=n=>Math.round((n+Number.EPSILON)*100);
const receiveKey=s=>String(s??"").toLowerCase().replace(/ё/g,"е").trim().replace(/\s+/g," ");
const receiveUnit=s=>receiveKey(s).replace(/\.$/,"").replace(/^штук[аи]?$/,"шт");
const pct=n=>fmt(n,1)+"%";
const uid=()=>Math.random().toString(36).slice(2,9);
const pad=n=>String(n).padStart(2,"0");
const todayISO=()=>{const d=new Date();return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());};
const ruDate=iso=>{try{return new Date(iso+"T12:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"short"});}catch(e){return iso;}};
const WD=["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
const CDN={xlsx:"https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  pdf:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfw:"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"};
const LIM=16000;

/* ================= Пояснения ================= */
const HELP={
today:["Сегодня","Главный экран. Сверху — что сделать, ниже цифры бара, отклонения и календарь. Приложение ничего не правит само: показывает проблему и предлагает решение."],
tasks:["Задачи","Действия, собранные из отклонений и календаря. У каждой есть решение: принять, заменить своим или перенести."],
stats:["Статистика бара","Четыре цифры за 30 дней. Считаются только барные позиции. В своём баре цифры появляются после загрузки продаж и техкарт."],
deviations:["Отклонения","Всё, что разошлось с нормой: цена против матрицы, техкарта против системы, факт против остатка. Нажмите на строку, чтобы увидеть причину и решение."],
calendar:["Календарь задач","Перенесённые задачи и регулярные события: день заказа, инвентаризация. Точка под датой означает, что на этот день что-то назначено."],
receiving:["Приёмка","Загрузите барную накладную и проверьте закупочные цены по матрице. Статус проведения проверяйте в учётной системе."],
stock:["Склад","Инвентаризация, остатки и заказ. Раздел отделяет пересортицу от потерь и подсказывает, что заканчивается."],
cards:["Техкарты","Проверка рабочих ТТК: единицы, выход, сходимость состава. Затем сверка с учётной системой."],
reports:["Отчёты","Оперативный контроль каждый день и управленческие отчёты за месяц. Цифры собираются из ваших загруженных документов."],
ai:["ИИ-ассистент","Чат по данным вашего бара. Если ИИ недоступен, отвечает локальный помощник — по тем же данным, без внешних запросов."],
matrix:["Матрица цен","Договорные цены с поставщиками. Нужна, чтобы ловить подорожания и забытые скидки. Можно заполнить вручную или загрузить таблицей."],
unposted:["Непроведённые накладные","Получены, но не поставлены на приход. Пока они не проведены, остатки и себестоимость считаются неверно."],
order:["Заказ","Список того, что нужно заказать. Собирается из остатков и расхода, правится вручную, копируется или отправляется поставщику."],
inventory:["Инвентаризация","Ввод фактических остатков с телефона. Список собирается из остатков, прошлых инвентаризаций, продаж и матрицы цен."],
shortage:["Недостачи и излишки","Недостача: факт меньше учёта. Излишек: факт больше. Сравнение нескольких инвентаризаций показывает позиции, которые расходятся постоянно."],
resort:["Пересортица","Недостачи и излишки почти равны по сумме: товар не пропал, а списан не с той позиции. Лечится сверкой по группе."],
stockdays:["Запас в днях","Остаток, делённый на средний расход в день. Расход берётся из датированного отчёта о продажах по совпадающим позициям и единицам."],
local:["Разбор на устройстве","Файл читается прямо в браузере: Excel, CSV, текст и текстовый слой PDF. Ничего не отправляется наружу. Фото и сканы читает ИИ, если он подключён."],
backup:["Резервная копия","Скачайте JSON-файл со всеми данными прототипа. Его можно загрузить на другом устройстве или после сброса."],
partial:["Частично открытое приложение","Разделы включаются по мере загрузки документов. Откройте раздел, ответьте на 2–3 вопроса и загрузите первый документ."],
r_inv:["Итоги инвентаризации","Учётный остаток, факт, недостачи и излишки по позициям."],
r_rest:["Остатки и запас в днях","Текущий остаток и на сколько дней хватит."],
r_reg:["Реестр накладных","Все накладные со статусом и суммой."],
r_pricectl:["Контроль закупочных цен","Цена из накладных против матрицы цен, переплата в рублях."],
r_pricedyn:["Динамика цен","Как менялась закупочная цена по месяцам."],
r_writeoff:["Списания","Бой, порча, проливы и дегустации за период."],
r_sales:["Продажи бара","Выручка и количество по категориям."],
r_abc:["ABC-анализ","Позиции по вкладу в выручку: A, B, C."],
r_turn:["Оборачиваемость","Сколько дней товар лежит на складе до продажи."],
r_purch:["Закупки по поставщикам","Сумма закупок и доля каждого поставщика."],
r_move:["Движение товара","Приход, расход и остаток по позиции."],
r_staff:["Персонал и представительские","Что выдано без оплаты и на какую сумму."],
r_menueng:["Меню-инжиниринг","Популярность и маржа по позициям: звёзды, лошадки, загадки, аутсайдеры."],
r_bevcost:["Себестоимость продаж","Beverage cost по категориям: где выше цели и почему."],
r_variance:["Факт и норма","Сколько должно было уйти по техкартам и сколько ушло по факту."]
};

/* ================= Данные примера ================= */
const DEMO={
 venue:"Бар «Причал»",period:"13.10 – 12.11",
 stats:[["revenue","Выручка бара","2,84 млн ₽","41% выручки заведения"],["cost","Beverage cost","24,6%","цель 23%"],["sold","Продано позиций","3 912","платные гостевые"],["compl","Представительские","186","38 тыс. ₽ по себестоимости"]],
 findings:[
  {id:"f1",sec:"receiving",task:1,title:"Провести 7 накладных на 64 тыс. ₽",detail:"Самая старая от 05.11. Пока они не проведены, остатки и себестоимость считаются неверно.",solution:"Провести сегодня. Начать с трёх алкогольных: они влияют на остатки ЕГАИС.",value:"7 шт."},
  {id:"f2",sec:"receiving",task:1,title:"Лимон: цена выше матрицы",detail:"В накладных 312,40 ₽ за кг, в матрице цен 198,00 ₽. Возможно, не применена скидка заведения.",solution:"Запросить у поставщика пересчёт по договорной цене.",value:"+58%",req:"Добрый день! В накладных с 28.10 лимон идёт по 312,40 ₽ за кг. По нашей договорённости цена 198,00 ₽. Прошу проверить и сделать пересчёт за этот период. Спасибо."},
  {id:"f3",sec:"receiving",title:"Тоник 0,2: подорожание без уведомления",detail:"Было 74 ₽, с 01.11 стало 86 ₽ за бутылку.",solution:"Уточнить у поставщика и обновить матрицу цен либо найти замену.",value:"+16%"},
  {id:"f4",sec:"cards",task:1,title:"Негрони: разная норма джина",detail:"В рабочей карте 30 мл, учётная система списывает 40 мл. За 112 продаж разница 1,1 л.",solution:"Назвать рабочую цифру и выровнять вторую сторону.",value:"+33%"},
  {id:"f5",sec:"cards",title:"Настойка «Клюква»: нет выхода",detail:"В рабочей карте нет выхода замеса и порции, поэтому сверить с учётной системой нельзя.",solution:"Дописать выход замеса и порцию 40 мл.",value:"нет выхода",n:1},
  {id:"f6",sec:"stock",title:"Водка для коктейлей: недостача три инвентаризации подряд",detail:"Всего 2,1 л. Позиция стоит в 38 техкартах.",solution:"Проверить нормы в пяти картах с наибольшими продажами.",value:"−2,1 л"},
  {id:"f7",sec:"stock",title:"Инвентаризация 30.10: пересортица",detail:"Недостачи 16,2 тыс. ₽, излишки 14,9 тыс. ₽: суммы почти равны.",solution:"Сверять сиропы и пюре суммой по группе, а не по вкусам.",value:"пересортица",n:1},
  {id:"f8",sec:"stock",task:1,title:"Лайм: запас на 1 день",detail:"Остаток 1,4 кг при расходе 1,3 кг в день.",solution:"Добавить в заказ 6 кг.",value:"1 день"}
 ],
 invoices:[["11.11","Фрукты и зелень","8 420","не проведена","w"],["10.11","Алкоголь 1","21 300","не проведена","w"],["10.11","Бакалея","6 150","не проведена","w"],["08.11","Алкоголь 2","14 900","цена выше матрицы","w"],["07.11","Фрукты и зелень","7 760","проведена",""],["05.11","Пиво","13 230","не проведена","w"]],
 inv:[["02.09","17,4","15,1"],["01.10","21,0","18,2"],["30.10","16,2","14,9"]],
 low:[["Лайм, кг","1,4","1 день"],["Апероль, л","2,1","2 дня"],["Тоник 0,2, шт","46","3 дня"]],
 order:[["Лайм, кг",6],["Апероль, л",4],["Тоник 0,2, шт",96],["Лимон, кг",8]],
 count:["Водка для коктейлей, л","Джин, л","Апероль, л","Сироп сахарный, л","Лайм, кг"]
};

/* ================= Разделы ================= */
const SEC={
 stock:{title:"Склад",line:"3 вопроса, затем инвентаризации и остатки",qs:[
  ["freq","Как часто считаете бар?",["Раз в неделю","Раз в две недели","Раз в месяц","Реже"]],
  ["how","Как считаете открытые бутылки?",["На весах","На глаз, десятыми","По-разному"]],
  ["where","Куда вносите результат?",["Сразу в учётную систему","В таблицу бухгалтерии","На бумагу"]]]},
 receiving:{title:"Приёмка",line:"Загрузите накладную и проверьте цены",qs:[
  ["who","Кто и когда ставит накладные на приход?",["Я в день поставки","Бухгалтерия с задержкой","Нерегулярно"]],
  ["matrix","Есть матрица договорных цен?",["Есть","Частично","Нет, собрать"]]]},
 cards:{title:"Техкарты",line:"2 вопроса, затем рабочие ТТК и меню",qs:[
  ["where","Где лежат рабочие ТТК?",["Google Таблица","Excel","На бумаге","Только в учётной системе"]],
  ["prep","Есть собственные заготовки и настойки?",["Да","Нет"]]]},
 reports:{title:"Отчёты",line:"Собираются из загруженных документов",qs:[]}
};
function docsFor(sec){
  const k=S.ans.system==="R-Keeper и StoreHouse"?1:S.ans.system==="iiko"?0:2;
  const how=(a,b,c)=>[a,b,c][k];
  const d={
   stock:[
    ["inv","Инвентаризация и сличительная ведомость","Чтобы увидеть расхождения и пересортицу.",how("iikoOffice: документ инвентаризации и сличительная ведомость.","StoreHouse: «Сличительная ведомость».","Таблица: позиция, учёт, факт.")],
    ["rest","Остатки на складе бара","Чтобы посчитать запас в днях и собрать заказ.",how("iikoOffice: «Остатки на складах», склад бара.","StoreHouse: «Ведомость остатков».","Таблица: позиция, остаток, единица.")],
    ["egais","Остатки ЕГАИС из DocsInBox","Чтобы сравнить учёт, ЕГАИС и факт.","DocsInBox: выгрузка остатков ЕГАИС."]],
   receiving:[
    ["invoice","Накладные","Excel, CSV, TSV или PDF с табличным текстом. Загрузите одну барную накладную за раз.","Таблица с колонками «Позиция», «Количество», «Цена». Для сверки добавьте «Единица» и «Поставщик». Если есть, добавьте «Дата», «Номер накладной» и «Сумма»."],
    ["matrix","Матрица цен","Чтобы сверять цену в каждой накладной с договорённой.","Таблица: позиция, единица, цена, поставщик."]],
   cards:[
    ["ttk","Рабочие ТТК","Карты, по которым работают бармены.","Excel или CSV: блюдо, ингредиент, брутто, нетто, выход."],
    ["menu","Меню с ценами","Чтобы сверить состав и цены продажи.","Фото, PDF или таблица меню."]],
   reports:[
    ["sales","Продажи бара за месяц","Основа всех управленческих отчётов.",how("iikoOffice: OLAP-отчёт по продажам.","r_keeper: отчёт по продажам блюд.","Таблица: позиция, количество, единица, сумма. Над таблицей укажите период «с ДД.ММ.ГГГГ по ДД.ММ.ГГГГ».")],
    ["writeoff","Списания","Бой, порча, проливы, дегустации.","Акты списания или таблица: причина, сумма."]]
  }[sec]||[];
  return d;
}
const EXPECT={invoice:["invoice"],matrix:["matrix"],inv:["inventory"],rest:["stock"],egais:["stock"],sales:["sales"],writeoff:["writeoff"],ttk:["ttk"],menu:["ttk"]};

/* ================= Состояние ================= */
const KEY="barmanager-proto-v2", OLD="barmanager-proto-v1";
function blank(){return{
  v:2, mode:null, step:"start", tab:"today", theme:null, viewAs:"owner",
  user:{name:"",phone:"",tg:false},
  venue:{name:"",city:"",format:"",points:1,stockName:""},
  ans:{problem:"",system:"",access:"",flow:[]},
  sec:{stock:{q:{},asked:false,docs:{}},receiving:{q:{},asked:false,docs:{}},cards:{q:{},asked:false,docs:{}},reports:{q:{},asked:true,docs:{}}},
  findings:[], st:{}, cal:[], chat:[], order:[], team:[],
  set:{summary:"09:00",orderDay:"",invDate:"",lowDays:3},
  data:{prices:{},stock:{},counts:[],invoices:[],receipts:[],docsInboxRegistry:[],sales:[],ttk:[],writeoffs:[]},
  draft:null, day:0, seen:{}
};}
function merge(a,b){
  if(!b||typeof b!=="object") return a;
  const o=Array.isArray(a)?a.slice():Object.assign({},a);
  for(const k of Object.keys(b)){
    const av=Object.hasOwn(a,k)?a[k]:undefined, bv=b[k];
    if(bv===undefined)continue;
    const value=av&&bv&&typeof av==="object"&&typeof bv==="object"&&!Array.isArray(av)&&!Array.isArray(bv)?merge(av,bv):bv;
    Object.defineProperty(o,k,{value,enumerable:true,writable:true,configurable:true});
  }
  return o;
}
function migrate(v1){
  const o={};
  ["mode","step","tab","theme","user","venue","ans","sec","findings","st","team"].forEach(k=>{if(v1[k]!==undefined)o[k]=v1[k];});
  o.cal=(v1.cal||[]).map(c=>({id:c.id||uid(),iso:c.iso,title:c.title,rep:"none",m:c.m||v1.mode}));
  o.order=(v1.order||[]).map(r=>Array.isArray(r)?{pos:r[0],qty:r[1],unit:""}:r);
  o.team=(v1.team||[]).map(t=>typeof t==="string"?{name:t,role:"bar"}:t);
  o.set=v1.set||{};
  o.findings=(v1.findings||[]).map(f=>Object.assign({src:"manual"},f));
  return o;
}
let S=blank();
try{
  const raw=JSON.parse(localStorage.getItem(KEY)||"null");
  if(raw) S=merge(blank(),raw);
  else{const old=JSON.parse(localStorage.getItem(OLD)||"null"); if(old) S=merge(blank(),migrate(old));}
}catch(e){}
let ownState=null;
const save=()=>{
  if(ownState)return true;
  try{localStorage.setItem(KEY,JSON.stringify(S));return true;}catch(e){return false;}
};
function commitReceiving(change){
  const previous={prices:S.data.prices,invoices:S.data.invoices,receipts:S.data.receipts,docsInboxRegistry:S.data.docsInboxRegistry,findings:S.findings,docs:S.sec.receiving.docs,sheet};
  try{
    change();
    if(!save())throw new Error("Не удалось сохранить данные в браузере. Проверьте доступное место и настройки хранения.");
  }catch(e){
    S.data.prices=previous.prices;
    S.data.invoices=previous.invoices;
    S.data.receipts=previous.receipts;
    S.data.docsInboxRegistry=previous.docsInboxRegistry;
    S.findings=previous.findings;
    S.sec.receiving.docs=previous.docs;
    sheet=previous.sheet;
    throw e;
  }
}
function leaveDemo(){
  if(ownState){S=ownState;ownState=null;}
  else if(S.mode==="demo")S.order=[];
}

let sheet=null, busy={}, chatBusy=false, sampleFn=null, draft="";
const isDemo=()=>S.mode==="demo";
const findings=()=>isDemo()?DEMO.findings:S.findings;
const fst=id=>S.st[id]||{};
const open=f=>!fst(f.id).status;
const secOn=k=>isDemo()||Object.values(S.sec[k].docs).some(d=>d&&d.res);
const started=()=>!!(S.ans.problem&&S.ans.system);
const venueName=()=>isDemo()?DEMO.venue:(S.venue.name||"Мой бар");
const q=k=>`<button class="q" data-a="help" data-k="${k}" aria-label="Пояснение">?</button>`;
function progress(){
  let all=0,done=0;
  ["stock","receiving","cards","reports"].forEach(k=>docsFor(k).forEach(d=>{all++;if(S.sec[k].docs[d[0]]&&S.sec[k].docs[d[0]].res)done++;}));
  return all?Math.round(done/all*100):0;
}
function days(){
  const out=[],t=new Date();
  for(let i=0;i<7;i++){
    const d=new Date(t.getFullYear(),t.getMonth(),t.getDate()+i);
    out.push({i,wd:WD[d.getDay()],n:d.getDate(),iso:d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()),label:d.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})});
  }
  return out;
}
function todayLabel(){const s=new Date().toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"});return s[0].toUpperCase()+s.slice(1);}
function eventsOn(iso){
  const out=[];
  const date=new Date(iso+"T12:00:00Z");
  S.cal.filter(c=>{
    if(c.m!==S.mode||c.iso>iso)return false;
    if(c.iso===iso)return true;
    const first=new Date(c.iso+"T12:00:00Z");
    return c.rep==="week"?date.getUTCDay()===first.getUTCDay():c.rep==="month"&&date.getUTCDate()===first.getUTCDate();
  }).forEach(c=>out.push({title:c.title,kind:fst(c.id).status==="cal"?"перенесено":"событие",id:c.id,own:true}));
  if(S.set.orderDay){
    const d=new Date(iso+"T12:00:00");
    if(WD[d.getDay()]===S.set.orderDay) out.push({title:"Заказ поставщикам",kind:"день заказа"});
  }
  /* FIX: сравниваем полную дату */
  if(S.set.invDate){
    const d=new Date(iso+"T12:00:00"), s=new Date(S.set.invDate+"T12:00:00");
    if(!isNaN(s)&&d.getDate()===s.getDate()&&d.getMonth()===s.getMonth()&&d.getFullYear()===s.getFullYear())
      out.push({title:"Инвентаризация бара",kind:"по плану"});
  }
  if(isDemo()){
    if(iso===todayISO()) out.push({title:"Провести накладные",kind:"сегодня"});
  }
  return out;
}
function effTheme(){if(S.theme)return S.theme;const a=document.documentElement.getAttribute("data-theme");if(a==="dark"||a==="light")return a;return window.matchMedia&&matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light";}
function applyTheme(){const c=document.documentElement.classList;c.remove("t-dark","t-light");if(S.theme)c.add("t-"+S.theme);}

/* ================= Общие блоки ================= */
function pills(name,opts,cur,multi){
  return `<div class="pills">${opts.map(o=>`<button class="pill" data-a="pick" data-n="${name}" data-v="${esc(o)}" ${multi?'data-m="1"':""} aria-pressed="${multi?(cur||[]).includes(o):cur===o}">${esc(o)}</button>`).join("")}</div>`;
}
function table(cols,rows){
  if(!rows||!rows.length) return `<div class="empty">Строк нет</div>`;
  return `<div class="tw"><table><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join("")}</tr>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
}
function fcard(f,full){
  const s=fst(f.id);
  const state=s.status==="done"?`<span class="tag">Решено${s.choice?": "+esc(s.choice):""}</span>`:s.status==="cal"?`<span class="tag">В календаре: ${esc(s.label)}</span>`:"";
  return `<div class="card"><div class="between" style="align-items:flex-start"><h3>${esc(f.title)}</h3>${f.value?`<span class="val ${f.n?"n":""}">${esc(f.value)}</span>`:""}</div>
   <p class="muted">${esc(f.detail)}</p>${full&&f.solution?`<p class="muted"><b style="color:var(--text2)">Решение:</b> ${esc(f.solution)}</p>`:""}
   ${state||`<div class="btns"><button class="btn p s" data-a="decide" data-id="${f.id}">Решение</button><button class="btn s" data-a="tocal" data-id="${f.id}">В календарь</button></div>`}</div>`;
}
function secFindings(k){
  const l=findings().filter(f=>f.sec===k);
  return l.length?`<div class="sec"><div class="between"><h2>Находки</h2><span class="muted">${l.filter(open).length} открыто</span></div>${l.map(f=>fcard(f,true)).join("")}</div>`:"";
}
function resBlock(r,receiving=false){
  const x=r.res;
  return `<div class="res"><div class="between"><b>${esc(x.doc_type||"Документ")}</b><span class="badge ${x.fits===false?"w":""}">${x.fits===false?"Не тот документ":(r.local?"Разобрано на устройстве":"Разобрано ИИ")}</span></div>
   ${x.period?`<span class="muted">Период: ${esc(x.period)}</span>`:""}<span>${esc(x.summary||"")}</span>
   ${x.fits_comment?`<span class="muted">${esc(x.fits_comment)}</span>`:""}
   ${!receiving&&(x.missing||[]).length?`<span class="muted"><b>Чего не хватает:</b> ${esc(x.missing.join("; "))}</span>`:""}
   <span class="muted">Файл: ${esc(r.name)}${r.part?" · прочитана часть файла":""}${receiving?"":" · находок: "+(x.findings||[]).length}</span></div>`;
}

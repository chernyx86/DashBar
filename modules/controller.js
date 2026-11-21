"use strict";
const VIEW={today:vToday,receiving:vReceiving,stock:vStock,cards:vCards,reports:vReports,ai:vAI};
function shell(){
  const tb=tabs(), t=S.tab, ini=(S.user.name.trim()[0]||"Б").toUpperCase();
  return `${isDemo()?`<div class="banner">Пример · вымышленный бар · цифры условные <button class="link" data-a="home" style="padding:0 0 0 8px;font-size:12px;text-decoration:underline">Выйти</button></div>`:""}
  <div class="head"><div class="head-row"><div class="row brand-row"><span class="seal" aria-hidden="true">D</span><span class="eyebrow">${esc(venueName())}</span></div><div class="row"><button class="icon-btn" data-a="theme" aria-label="Переключить тему">${effTheme()==="dark"?"Светлая":"Тёмная"}</button><button class="avatar" data-a="settings" aria-label="Профиль и настройки">${esc(ini)}</button></div></div>
   <div class="row"><h1>${TITLE[t]}</h1>${q(t==="today"||t==="ai"||t==="reports"?"stats":t)}</div>${t==="today"?`<span class="sub">${todayLabel()}</span>`:!isDemo()&&SEC[t]&&!secOn(t)?`<span class="sub">Раздел ещё не включён</span>`:""}</div>
  <div class="main" id="main">${VIEW[t]()}</div>
  ${t==="ai"?`<form class="composer${assistantAvailable()?" composer-external":""}" data-f="chat"><input class="in" id="chat-in" maxlength="700" placeholder="Спросите про бар" autocomplete="off" aria-label="Сообщение" value="${esc(draft)}"><button class="btn p" ${chatBusy?"disabled":""}>${chatBusy?"…":"Спросить"}</button>${assistantAvailable()?`<button class="btn" name="external" ${chatBusy?"disabled":""}>Спросить ИИ</button>`:""}</form>`:""}
  <nav class="nav" style="grid-template-columns:repeat(${tb.length},1fr)" aria-label="Разделы">${tb.map(x=>`<button data-a="tab" data-t="${x[0]}" ${t===x[0]?'aria-current="page"':""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[x[0]]}</svg>${x[1]}${!isDemo()&&SEC[x[0]]&&!secOn(x[0])?'<span class="lock" title="Не включён"></span>':""}</button>`).join("")}</nav>`;
}
/* ================= Нижние листы ================= */
function sheetHtml(){
  if(!sheet) return "";
  const s=sheet, close=`<button class="btn" data-a="close">Закрыть</button>`; let b="";
  if(s.t==="survey")b=`<h2>Как работает ваш бар</h2>${surveyFields()}${close}`;
  if(s.t==="docsinboxPreview")b=renderDocsInboxPreflight(s)+close;
  if(s.t==="docsinboxRegistry")b=renderDocsInboxRegistry(s)+close;
  if(s.t==="workbook")b=previewUpload(s)+close;
  if(s.t==="ocr")b=renderOcr(s)+'<button class="btn" data-a="ocrback">К очереди</button>';
  if(s.t==="receivingsources")b=receivingSources()+close;
  if(s.t==="help"){const h=HELP[s.k]||["Пояснение","Описание появится позже."]; b=`<h2>${h[0]}</h2><p>${h[1]}</p>${close}`;}
  if(s.t==="report"){
    const def=findReport(s.k), h=HELP[s.k]||["Отчёт","Описание появится позже."];
    let body="";
    if(isDemo()) body=table(def[3],def[4])+`<p class="muted">Цифры условные. Свои появятся, когда загрузите документы.</p>`;
    else{
      const c=computeReport(s.k);
      body=c?table(c.cols,c.rows)+(c.note?`<p class="muted">${esc(c.note)}</p>`:""):`<div class="res">Пока нет данных. ${esc(NEED[s.k]||"Загрузите документы.")}</div><button class="btn s" data-a="tab" data-t="${secForReport(s.k)}" style="align-self:flex-start">Перейти к загрузке</button>`;
    }
    b=`<div class="between"><h2>${def[1]}</h2><span class="badge">${isDemo()?"Пример":"по вашим данным"}</span></div><p>${h[1]}</p>${body}${close}`;
  }
  if(s.t==="decide"){
    const f=findings().find(x=>x.id===s.id);
    if(!f)return "";
    const st=fst(f.id);
    b=`<div class="between" style="align-items:flex-start"><h2>${esc(f.title)}</h2>${f.value?`<span class="val ${f.n?"n":""}">${esc(f.value)}</span>`:""}</div><p>${esc(f.detail)}</p>
     <div class="res"><b>Предложенное решение</b><span>${esc(f.solution||"Решение не предложено.")}</span></div>
     ${f.req?`<div class="res"><b>Текст запроса поставщику</b><span>${esc(f.req)}</span><button class="btn s" data-a="copy" data-v="${esc(f.req)}" style="align-self:flex-start">Скопировать</button></div>`:""}
     ${st.status?`<span class="tag" style="align-self:flex-start">${st.status==="done"?"Решено: "+esc(st.choice||"принято"):"В календаре: "+esc(st.label)}</span><button class="btn" data-a="reopen" data-id="${f.id}">Вернуть в работу</button>`
      :`<label class="field">Своё решение<input class="in" id="own-choice" placeholder="Необязательно"></label>
       <div class="btns"><button class="btn p" data-a="accept" data-id="${f.id}">Принять</button><button class="btn" data-a="tocal" data-id="${f.id}">В календарь</button></div>`}
     <p class="muted">Приложение ничего не меняет в учётной системе: исправление вносите вы.</p>${close}`;
  }
  if(s.t==="cal"){
    const f=findings().find(x=>x.id===s.id);
    if(!f)return "";
    b=`<h2>На какой день перенести</h2><p>${esc(f.title)}</p><div class="days">${days().map(d=>`<button class="day" data-a="calpick" data-id="${f.id}" data-i="${d.i}">${d.wd}<b>${d.n}</b></button>`).join("")}</div>${close}`;
  }
  if(s.t==="event"){
    b=`<h2>Новое событие</h2>
      <label class="field">Название<input class="in" id="ev-title" value="${esc(s.title||"")}" placeholder="Например: заказ у поставщика"></label>
      <label class="field">Дата<input class="in" id="ev-date" type="date" value="${esc(s.date||todayISO())}"></label>
      <div class="field">Повтор<div class="seg" id="ev-rep">${[["none","Один раз"],["week","Каждую неделю"],["month","Каждый месяц"]].map(x=>`<button type="button" data-a="evrep" data-v="${x[0]}" aria-pressed="${(s.rep||"none")===x[0]}">${x[1]}</button>`).join("")}</div></div>
      <div class="btns"><button class="btn p" data-a="evsave">Добавить</button>${close}</div>`;
  }
  if(s.t==="ask"){
    const c=SEC[s.k], st=S.sec[s.k];
    b=`<h2>${c.title}: вопросы</h2>${c.qs.map(x=>`<div class="field">${esc(x[1])}${pills("sec."+s.k+".q."+x[0],x[2],st.q[x[0]]||"")}</div>`).join("")}
     <div class="btns"><button class="btn p" data-a="askdone" data-k="${s.k}">Готово</button><button class="btn" data-a="close">Отложить</button></div>`;
  }
  if(s.t==="inv"){
    const d=S.draft||(S.draft={date:todayISO(),q:"",rows:{}});
    const all=invList(), qq=(d.q||"").toLowerCase();
    const list=all.filter(p=>p.toLowerCase().includes(qq)).slice(0,80);
    const filled=Object.values(d.rows).filter(v=>String(v).trim()!=="").length;
    b=`<div class="between"><h2>Инвентаризация</h2><span class="badge" id="inv-count">${filled} из ${all.length}</span></div>
      <label class="field">Дата<input class="in" id="inv-date" type="date" value="${esc(d.date)}" data-invd="1" ${d.reference?"disabled":""}></label>
      <input class="in search" id="inv-q" data-invq="1" placeholder="Поиск позиции" value="${esc(d.q||"")}" aria-label="Поиск">
      <div class="list" style="max-height:44vh;overflow-y:auto">${list.length?list.map(p=>`<div class="invrow"><div class="nm">${esc(p)}<small>учёт ${fmt(bookOf(p))}</small></div><input data-inv="${esc(p)}" inputmode="decimal" value="${esc(d.rows[p]??"")}" placeholder="факт" aria-label="${esc(p)}"></div>`).join(""):`<div class="empty">Позиций нет. Загрузите остатки или матрицу цен.</div>`}</div>
      <div class="btns">${d.reference?"":'<button class="btn" data-a="invfill">Заполнить учётом</button>'}<button class="btn p" data-a="invsave">Сохранить</button></div>
      ${S.sec.stock.q.how?`<p class="muted">${esc({"На весах":"Снимите массу тары и переведите результат в единицу учёта.","На глаз, десятыми":"Введите оценку в единицах учёта, например 0,4 л.","По-разному":"Сверьте единицу учёта каждой открытой бутылки перед вводом."}[S.sec.stock.q.how]||"")}</p>`:""}
      <p class="muted">Ввод идёт в черновик: можно закрыть и вернуться. Учёт берётся из загруженных остатков.</p>${close}`;
  }
  if(s.t==="settings"){
    const th=S.theme||"auto";
    b=`<h2>Профиль и настройки</h2><button class="btn s" data-a="survey">Ответы о баре</button>
     <label class="field">Название склада бара в учёте<input class="in" data-b="venue.stockName" value="${esc(S.venue.stockName)}" placeholder="Необязательно"></label>
     <div class="field">Тема<div class="pills">${[["auto","Как в системе"],["light","Светлая «Хвоя и медь»"],["dark","Тёмная «Чернила и латунь»"]].map(x=>`<button class="pill" data-a="settheme" data-v="${x[0]}" aria-pressed="${th===x[0]}">${x[1]}</button>`).join("")}</div></div>
     <label class="field">Время утренней сводки<input class="in" id="s-sum" type="time" data-b="set.summary" value="${esc(S.set.summary)}"></label>
     <div class="field">День заказа${pills("set.orderDay",["Пн","Вт","Ср","Чт","Пт","Сб","Вс"],S.set.orderDay)}</div>
     <label class="field">Дата инвентаризации<input class="in" id="s-inv" type="date" data-b="set.invDate" value="${esc(S.set.invDate)}"></label>
     <label class="field">Порог «заканчивается», дней<input class="in" type="number" min="1" max="30" data-b="set.lowDays" value="${esc(S.set.lowDays)}"></label>
     <div class="field"><div class="between"><span>Данные</span>${q("backup")}</div>
      <div class="btns"><button class="btn s" data-a="export">Скачать копию</button><label class="btn s file">Загрузить копию<input type="file" accept="application/json,.json" data-import="1"></label></div>
      <span class="muted">Резервная копия — JSON со всеми данными прототипа.</span></div>
     <div class="field">Точки<span class="muted">Заявлено: ${isDemo()?1:S.venue.points}. Подключена одна.</span></div>
     <div class="btns"><button class="btn" data-a="home">На экран выбора бара</button><button class="btn" data-a="reset">Сбросить прототип</button></div>${close}`;
  }
  if(s.t==="note") b=`<h2>${esc(s.h)}</h2><p>${esc(s.p)}</p>${close}`;
  return `<div class="shade" data-a="shade"><div class="sheet" role="dialog" aria-modal="true">${b}</div></div>`;
}
/* ================= Отрисовка ================= */
const app=document.getElementById("app");
function render(keep, persist=true){
  const m=document.getElementById("main"), y=keep&&m?m.scrollTop:0;
  const sh=app.querySelector(".sheet"), sy=keep&&sh?sh.scrollTop:0;
  applyTheme();
  if(S.step==="app"&&!tabs().some(([tab])=>tab===S.tab))S.tab="today";
  app.classList.toggle?.("mode-app",S.step==="app");
  app.innerHTML=(S.step==="app"?shell():onboarding())+sheetHtml();
  const m2=document.getElementById("main");
  if(m2) m2.scrollTop=S.tab==="ai"&&S.step==="app"?m2.scrollHeight:y;
  const sh2=app.querySelector(".sheet"); if(sh2) sh2.scrollTop=sy;
  if(persist)save();
}
function setPath(p,v){const a=p.split(".");let o=S;for(let i=0;i<a.length-1;i++)o=o[a[i]];o[a[a.length-1]]=v;}
function getPath(p){return p.split(".").reduce((o,k)=>(o==null?o:o[k]),S);}
function toast(msg){
  const el=document.createElement("div");el.className="toast";el.textContent=msg;document.body.appendChild(el);
  setTimeout(()=>el.remove(),2600);
}
function copyText(t,el){
  const done=ok=>{if(el){const o=el.textContent;el.textContent=ok?"Скопировано":"Не удалось";setTimeout(()=>{el.textContent=o;},1500);}toast(ok?"Скопировано":"Не удалось скопировать");};
  try{navigator.clipboard.writeText(t).then(()=>done(true),()=>done(false));}catch(e){done(false);}
}
function download(name,text,type){
  const b=new Blob([text],{type:type||"text/plain;charset=utf-8"}), u=URL.createObjectURL(b);
  const a=document.createElement("a");a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}
/* ================= Действия ================= */
const A={
 help:d=>{sheet={t:"help",k:d.k};render(true);},
 report:d=>{sheet={t:"report",k:d.k};render(true);},
 close:()=>{sheet=null;render(true);},
 theme:()=>{S.theme=effTheme()==="dark"?"light":"dark";render(true);},
 settheme:d=>{S.theme=d.v==="auto"?null:d.v;render(true);},
 settings:()=>{sheet={t:"settings"};render(true);},
 survey:()=>{sheet={t:"survey"};render(true);},
 /* FIX: очищаем демо-заказ при переходе */
 own:()=>{sheet=null;leaveDemo();S.mode="own";S.tab="today";S.step=started()?"app":"who";render();},
 demo:()=>{sheet=null;ownState=S;S=blank();S.theme=ownState.theme;S.mode="demo";S.step="app";S.order=DEMO.order.map(r=>({pos:r[0],qty:r[1],unit:""}));render();},
 home:()=>{sheet=null;leaveDemo();S.step="start";render();},
 back:()=>{S.step={who:"start",venue:"who",three:"venue"}[S.step]||"start";render();},
 next:d=>{S.step=d.s;render();},
 tg:()=>{S.user.tg=!S.user.tg;render(true);},
 enter:()=>{S.step="app";S.tab="today";render();},
 pick:d=>{
   if(d.m){const a=getPath(d.n),i=a.indexOf(d.v);i<0?a.push(d.v):a.splice(i,1);}
   else{
     let v=d.v;
     if(d.n==="venue.points")v=Number(v);
     if(d.n==="set.orderDay"&&getPath(d.n)===v)v="";
     setPath(d.n,v);
   }
   render(true);
 },
 tab:d=>{
   S.tab=d.t;sheet=null;
   try{history.replaceState(null,"","#"+d.t);}catch(e){}
   render();
   if(d.anchor)document.getElementById(d.anchor)?.scrollIntoView?.({block:"start"});
   if(!d.anchor&&!isDemo()&&d.t!=="receiving"&&SEC[d.t]&&SEC[d.t].qs.length&&!S.sec[d.t].asked&&!S.seen[d.t]){S.seen[d.t]=true;sheet={t:"ask",k:d.t};render();}
 },
 ask:d=>{sheet={t:"ask",k:d.k};render(true);},
 askdone:d=>{S.sec[d.k].asked=true;sheet=null;render(true);},
 day:d=>{S.day=Number(d.i);render(true);},
 decide:d=>{sheet={t:"decide",id:d.id};render(true);},
 accept:d=>{const el=document.getElementById("own-choice");S.st[d.id]={status:"done",choice:el&&el.value.trim()?el.value.trim():""};sheet=null;render(true);},
 tocal:d=>{sheet={t:"cal",id:d.id};render(true);},
 calpick:d=>{const day=days()[Number(d.i)],f=findings().find(x=>x.id===d.id);S.st[d.id]={status:"cal",label:day.label};S.cal=S.cal.filter(c=>c.id!==d.id);S.cal.push({id:d.id,iso:day.iso,title:f.title,m:S.mode});sheet=null;render(true);},
 reopen:d=>{delete S.st[d.id];S.cal=S.cal.filter(c=>c.id!==d.id);render(true);},
 copy:d=>{copyText(d.v);},
 docsinboxregistry:()=>{sheet={t:"docsinboxRegistry",limit:25,query:""};render(true);},
 docsinboxmore:()=>{sheet.limit+=25;paintDocsInboxRows();},
 savedocsinbox:()=>saveDocsInboxRegistry(),
 postreceipt:d=>postReceipt(d.id),
 ocrback:()=>{sheet={t:"receivingsources"};render(true);},
 ocradd:()=>{if(sheet?.t==="ocr"&&sheet.rows.length<100){sheet.rows.push(blankOcrRow());render(true);}},
 ocrdel:d=>{if(sheet?.t==="ocr"&&sheet.rows.length>1){sheet.rows.splice(Number(d.i),1);render(true);}},
 invoicemore:()=>{invoiceSearch.limit+=25;paintInvoiceResults();},
 queuemore:()=>runIncoming(async()=>{
   if(incoming.nextCursor)await refreshIncoming(true);
   return "Очередь обновлена.";
 }),
 importpreview:()=>commitWorkbookPreview(),
 receivingsources:()=>{sheet={t:"receivingsources"};render(true);},
 refreshintake:()=>runIncoming(async()=>{await refreshIncoming();return "Очередь обновлена.";}),
 syncintake:()=>runIncoming(async()=>{
   const result=await incomingRequest("/sync",{method:"POST"});
   await refreshIncoming();
   return Object.entries(result).map(([source,status])=>(incomingLabels[source]||source)+": "+status).join(" · ")||"Сохраните источник перед синхронизацией.";
 }),
 sourcefile:d=>runIncoming(async()=>{
   const item=incoming.queue.find(row=>String(row.id)===d.id);
   if(!item)throw new Error("Обновите очередь.");
   const file=await incomingRequest("/documents/"+item.id,{blob:true});
   download(item.name,file,"application/octet-stream");
   return "Оригинал отправлен на скачивание.";
 }),
 skipqueue:d=>runIncoming(async()=>{
   const item=incoming.queue.find(row=>String(row.id)===d.id);
   if(!item)throw new Error("Этот документ уже снят с очереди.");
   await incomingRequest("/documents/"+item.id+"/reviewed",{method:"POST"});
   incoming.queue=incoming.queue.filter(row=>row.id!==item.id);
   return "Документ снят с очереди.";
 }),
 mxadd:()=>{
   const pos=document.getElementById("mx-pos").value.trim();
   const price=readNumber(document.getElementById("mx-price").value);
   const supplier=document.getElementById("mx-supplier").value.trim();
   const unit=document.getElementById("mx-unit").value.trim();
   if(!pos||!Number.isFinite(price)||price<=0||!supplier||!unit)return toast("Укажите позицию, цену больше нуля, поставщика и единицу");
   try{commitReceiving(()=>storeMatrix([{pos,price,supplier,unit,taxBasis:document.getElementById("mx-tax-gross")?.checked?"gross":""}],todayISO()));render(true);toast("Цена сохранена");}
   catch(e){toast(e.message);}
 },
 ordadd:()=>{const el=document.getElementById("ord-new");const v=el.value.trim();if(v){S.order.push({pos:v,qty:1,unit:""});render(true);}},
 orddel:d=>{S.order.splice(Number(d.i),1);render(true);},
 ordsuggest:()=>{
   const s=suggestOrder();
   if(!s.length)return toast(S.data.sales.length?"Нет позиций с рассчитанным расходом ниже порога":"Для расчёта заказа загрузите продажи или добавьте позиции вручную");
   let add=0;
   s.forEach(x=>{if(!S.order.some(o=>o.pos===x.pos)){S.order.push(x);add++;}});
   render(true);toast(add?"Добавлено позиций: "+add:"Всё уже в заказе");
 },
 ordcopy:()=>{const text=orderText();if(text)copyText(text);},
 ordshare:async()=>{
   const t=orderText();
   if(!t)return;
   if(navigator.share){try{await navigator.share({title:"Заказ",text:t});return;}catch(e){}}
   copyText(t);
 },
 orddown:()=>{const text=orderText();if(text)download("order-"+todayISO()+".txt",text);},
 count:()=>{if(!S.draft)S.draft={date:todayISO(),q:"",rows:{}};sheet={t:"inv"};render(true);},
 invfill:()=>{
   const all=invList();
   all.forEach(p=>{S.draft.rows[p]=String(fmt(bookOf(p),3)).replace(/\s/g,"");});
   sheet={t:"inv"};render(true);toast("Подставлен учёт");
 },
 invsave:()=>{
   const d=S.draft||{rows:{},date:todayISO()};
   const entries=Object.keys(d.rows).filter(p=>String(d.rows[p]).trim()!=="");
   if(!entries.length)return toast("Введите хотя бы один факт");
   const date=parseDate(d.date);
   if(!date)return toast("Укажите дату инвентаризации");
   const invalid=entries.find(p=>!Number.isFinite(readNumber(d.rows[p]))||readNumber(d.rows[p])<0);
   if(invalid)return toast(`«${invalid}»: введите количество от нуля`);
   const src="count."+date+"."+uid();
   const rows=[], find=[], prices=matrixByPosition();
   let short=0, over=0, unpriced=0;
   entries.forEach(p=>{
     const book=bookOf(p), fact=readNumber(d.rows[p]), diff=fact-book;
     const row={pos:p,book,fact,unit:d.reference?.[p]?.unit||S.data.stock[p]?.unit||S.data.prices[p]?.unit||""};
     const price=inventoryPrice(row,prices);
     row.diff=diff;
     row.sum=diff*price;
     rows.push(row);
     if(diff!==0){
       const money_=Math.abs(diff)*price;
       if(!price)unpriced++;
       if(diff<0)short+=money_; else over+=money_;
       find.push({pos:p,diff,fact,book,unit:row.unit,sum:money_,price});
     }
   });
   find.sort((a,b)=>b.sum-a.sum);
   const totals={short,over,unpriced};
   const res={doc_type:"Сличительная ведомость",period:date,fits:true,summary:`Инвентаризация от ${ruDate(date)}: ${rows.length} позиций · ${inventoryTotals(totals)}.`,findings:[],missing:[],local:true};
   find.slice(0,6).forEach(f=>{
     const val=(f.diff<0?"−":"+")+fmt(Math.abs(f.diff))+(f.unit?" "+f.unit:"");
     res.findings.push({title:`${f.pos}: ${f.diff<0?"недостача":"излишек"} ${fmt(Math.abs(f.diff))}${f.unit?" "+f.unit:""}`,detail:`По учёту ${fmt(f.book)}, по факту ${fmt(f.fact)}.${f.price?` В деньгах ${money(f.sum)}.`:""}`,solution:f.diff<0?"Проверить техкарты и последнюю приёмку по этой позиции.":"Проверить, не списан ли товар не с той позиции.",value:val});
   });
   if(possibleResort(totals)){
     res.findings.unshift({title:"Возможная пересортица",detail:`Недостачи ${money(short)}, излишки ${money(over)}: суммы почти равны. Сверьте недостачи и излишки по группам.`,solution:"Сверять группы (сиропы, пюре, крепкий алкоголь) суммой, а не по вкусам.",value:"пересортица",n:1});
   }
   try{commitOperationalData("stock",()=>{
     S.data.counts=[{id:uid(),src,date,rows,...totals},...S.data.counts].sort((a,b)=>b.date.localeCompare(a.date));
     if(!d.reference&&!(S.sec.stock.docs.rest?.res?.snapshot?.date>date)&&!S.data.counts.some(c=>c.date>date)){
       S.data.stock={...S.data.stock};
       rows.forEach(r=>{Object.defineProperty(S.data.stock,r.pos,{enumerable:true,configurable:true,writable:true,
         value:{qty:r.fact,unit:r.unit||S.data.stock[r.pos]?.unit||"",countDate:date}});});
     }
     S.findings=S.findings.filter(f=>f.src!==src);
     res.findings.forEach((f,i)=>S.findings.push({id:src+"."+i,src,sec:"stock",title:f.title,detail:f.detail,solution:f.solution,value:f.value||"",n:f.n}));
     S.sec.stock.docs.inv={name:"Инвентаризация "+date,res,local:true};
     S.draft=null;
   });}catch(error){return toast(error.message);}
   sheet=null;render(false,false);toast("Инвентаризация сохранена");
 },
 export:()=>{if(isDemo())return toast("Откройте свой бар, чтобы сохранить копию.");download("dashbar-"+todayISO()+".json",JSON.stringify(S,null,2),"application/json");toast("Копия скачана");},
 eventnew:()=>{sheet={t:"event",rep:"none",date:days()[S.day].iso};render(true);},
 evrep:d=>{sheet.title=document.getElementById("ev-title").value;sheet.date=document.getElementById("ev-date").value;sheet.rep=d.v;render(true);},
 evsave:()=>{
   const t=document.getElementById("ev-title").value.trim(), dt=document.getElementById("ev-date").value;
   if(!t||!dt)return toast("Нужны название и дата");
   S.cal.push({id:uid(),iso:dt,title:t,rep:sheet.rep||"none",m:S.mode});
   sheet=null;render();toast("Событие добавлено");
 },
 eventdel:d=>{S.cal=S.cal.filter(c=>c.id!==d.id);if(fst(d.id).status==="cal")delete S.st[d.id];render(true);},
 reset:()=>{if(!confirm("Сбросить все данные прототипа?"))return;if(ownState){A.home();return;}S=blank();sheet=null;try{localStorage.removeItem(KEY);localStorage.removeItem(OLD);}catch(e){}render();},
 sugg:d=>{sendChat(d.v);},
 chatclear:()=>{S.chat=[];render();},
 shade:(d,el,ev)=>{if(ev.target===el){sheet=null;render(true);}}
};
function bookOf(p){
  if(S.draft?.reference?.[p])return num(S.draft.reference[p].qty);
  const stock=effectiveStock();
  if(Object.hasOwn(stock,p))return num(stock[p].qty);
  const c=S.data.counts[0]; if(c){const r=c.rows.find(x=>x.pos===p); if(r) return r.fact;}
  return 0;
}
function invList(){
  if(S.draft?.reference)return Object.keys(S.draft.reference).sort((a,b)=>a.localeCompare(b,"ru"));
  const set=new Set();
  for(const [p] of stockEntries())set.add(p);
  (S.data.counts[0]?S.data.counts[0].rows:[]).forEach(r=>set.add(r.pos));
  S.data.sales.forEach(r=>set.add(r.pos));
  Object.keys(S.data.prices).forEach(p=>set.add(p));
  return [...set].filter(Boolean).sort((a,b)=>a.localeCompare(b,"ru"));
}
app.addEventListener("click",ev=>{
  const el=ev.target.closest("[data-a]");
  if(!el||el.disabled)return;
  const f=A[el.dataset.a];
  if(f){if(el.dataset.a!=="shade")ev.stopPropagation();f(el.dataset,el,ev);}
});
app.addEventListener("keydown",ev=>{
  if(ev.key==="Enter"&&ev.target.getAttribute("role")==="button")ev.target.click();
  if(ev.key==="Escape"&&sheet){sheet=null;render(true);}
});
app.addEventListener("input",ev=>{
  const t=ev.target;
  if(t.dataset.b){setPath(t.dataset.b,t.type==="number"?num(t.value):t.value);save();}
  if(t.dataset.ord!==undefined){S.order[Number(t.dataset.ord)].qty=t.value;save();}
  if(t.dataset.inv!==undefined){S.draft.rows[t.dataset.inv]=t.value;save();updInvCount();}
  if(t.dataset.invd!==undefined){S.draft.date=t.value;save();}
  if(t.dataset.invq!==undefined){S.draft.q=t.value;save();render(true);const el=document.getElementById("inv-q");if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}}
  if(sheet?.t==="ocr"&&t.dataset.ocrKey){
    const target=t.dataset.ocrIndex===undefined?sheet:sheet.rows[Number(t.dataset.ocrIndex)];
    if(target)target[t.dataset.ocrKey]=t.value;
  }
  if(t.dataset.docsinboxQuery!==undefined&&sheet?.t==="docsinboxRegistry"){sheet.query=t.value;sheet.limit=25;paintDocsInboxRows();}
  if(t.id==="invoice-search"){
    invoiceSearch.query=t.value;
    invoiceSearch.limit=25;
    paintInvoiceResults();
  }
  if(t.id==="chat-in")draft=t.value;
});
function updInvCount(){
  const el=document.getElementById("inv-count");
  if(!el||!S.draft)return;
  const filled=Object.values(S.draft.rows).filter(v=>String(v).trim()!=="").length;
  el.textContent=filled+" из "+invList().length;
}
app.addEventListener("toggle",ev=>{
  const detail=ev.target;
  if(!detail.open||!detail.dataset?.invoiceId)return;
  const invoice=S.data.invoices.find(item=>String(item.id)===detail.dataset.invoiceId);
  const holder=detail.querySelector("[data-invoice-rows]");
  if(invoice&&holder&&!holder.firstChild)holder.innerHTML=invoiceRows(invoice);
},true);
app.addEventListener("change",ev=>{
  const t=ev.target;
  if(t.dataset.docsinboxConflicts!==undefined&&sheet?.t==="docsinboxRegistry"){sheet.conflicts=t.checked;sheet.limit=25;paintDocsInboxRows();return;}
  if(t.dataset.uploadSelect!==undefined&&sheet?.t==="workbook"){sheet.selected=Number(t.value);render(true);return;}
  if(t.type==="file"&&t.files&&t.files[0]){
    if(t.dataset.import){importBackup(t.files[0]);return;}
    handleFile(t.dataset.sec,t.dataset.doc,t.files[0]);
  }
});
app.addEventListener("submit",ev=>{
  ev.preventDefault();
  if(ev.target.dataset.f==="confirmocr")return confirmOcr();
  if(["directintake","connectintake","configureintake","importqueue","queuedexports"].includes(ev.target.dataset.f))return submitIncoming(ev.target);
  if(ev.target.dataset.f==="chat"){const el=document.getElementById("chat-in");const v=el.value.trim();if(v&&!chatBusy){draft="";sendChat(v,ev.submitter?.name==="external");}}
});
function importBackup(file){
  if(isDemo())return toast("Откройте свой бар, чтобы восстановить копию.");
  const profile=S;
  const r=new FileReader();
  r.onerror=()=>toast("Не удалось открыть файл копии.");
  r.onload=()=>{
    if(S!==profile||isDemo())return toast("Профиль изменился. Откройте копию ещё раз.");
    try{
      const v=JSON.parse(r.result);
      if(!v||typeof v!=="object"||!v.data||(v.v!=null&&v.v!==1&&v.v!==2))throw new Error("Это не резервная копия DashBar");
      const candidate=merge(blank(),v.v===1?migrate(v):v);
      if(candidate.mode==="demo")throw new Error("Для восстановления нужна копия своего бара.");
      const defaults=blank();
      const validShape=(value,example)=>Array.isArray(example)?Array.isArray(value):
        example&&typeof example==="object"?value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(example).every(k=>validShape(value[k],example[k])):
        example===null||typeof value===typeof example;
      if(!validShape(candidate,defaults)||candidate.day<0||candidate.day>=7||!Number.isInteger(candidate.day)||
         !["start","who","venue","three","app"].includes(candidate.step)||
         candidate.data.invoices.some(i=>!i||typeof i.date!=="string"||!Array.isArray(i.rows)||i.rows.some(row=>!row||typeof row.pos!=="string"))||
         candidate.data.counts.some(c=>!c||typeof c.date!=="string"||!Array.isArray(c.rows)||c.rows.some(r=>!r||typeof r.pos!=="string"))||
         candidate.data.receipts.some(r=>!r||typeof r.date!=="string"||typeof r.warehouse!=="string"||
           !Array.isArray(r.rows)||r.rows.some(row=>!row||typeof row.pos!=="string"||!Number.isFinite(row.qty))))throw new Error("Повреждена структура резервной копии");
      const previousSheet=sheet;
      try{
        S=candidate;sheet=null;render(false,false);
        if(!save()){
          S=profile;sheet=previousSheet;render(false,false);
          return toast("Копию не удалось сохранить в браузере. Прежние данные сохранены.");
        }
      }catch(error){S=profile;sheet=previousSheet;render(false,false);throw error;}
      toast("Копия загружена");
    }catch(e){toast("Не удалось прочитать копию");}
  };
  r.readAsText(file);
}
/* ================= Чтение файлов ================= */

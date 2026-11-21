"use strict";
const SUGG=["Почему расходится инвентаризация?","Какие цены выше матрицы?","Что заканчивается?","С чего начать сегодня?"];
function vAI(){
  const mode=sampleFn?"ИИ":"локальный помощник";
  return `<div class="chat" id="chat">${S.chat.length?S.chat.map(m=>`<div class="msg ${m.role==="user"?"u":"a"}">${esc(m.content)}</div>`).join(""):`<div class="card"><p class="muted">Ассистент видит ответы анкеты, загруженные документы и находки. ${sampleFn?"Отвечает ИИ.":"ИИ сейчас не подключён, поэтому отвечает локальный помощник — по тем же данным, без внешних запросов."}</p><div class="pills">${SUGG.map(s=>`<button class="pill" data-a="sugg" data-v="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`}</div>
   <div class="between"><span class="muted">Режим: ${mode}</span>${S.chat.length?`<button class="link" data-a="chatclear" style="padding:0">Очистить чат</button>`:""}</div>`;
}

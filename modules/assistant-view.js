"use strict";
const SUGG=["Почему расходится инвентаризация?","Какие цены выше матрицы?","Что заканчивается?","С чего начать сегодня?"];
function vAI(){
  const mode=assistantAvailable()?"Локальный помощник · внешний ИИ доступен":"Локальный помощник";
  return `<div class="chat" id="chat">${S.chat.length?S.chat.map(m=>`<div class="msg ${m.role==="user"?"u":"a"}">${esc(m.content)}</div>`).join(""):`<div class="card"><p class="muted">Локальный помощник отвечает по данным бара.</p><div class="pills">${SUGG.map(s=>`<button class="pill" data-a="sugg" data-v="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`}</div>
   <div class="between"><span class="muted">Режим: ${mode}</span>${S.chat.length?`<button class="link" data-a="chatclear" style="padding:0">Очистить чат</button>`:""}</div>${assistantAvailable()?'<p class="muted">«Спросить ИИ» отправит в OpenAI текст вопроса и количество записей. Не вводите конфиденциальные сведения.</p>':""}`;
}

"use strict";
/* ---------- Техкарты ---------- */
function vCards(){
  if(isDemo()) return `<div class="sec"><div class="grid2"><div class="tile"><span class="l">Карт проверено</span><span class="n">64</span><span class="f">рабочие ТТК</span></div><div class="tile"><span class="l">Сходятся с системой</span><span class="n">51</span><span class="f">13 с расхождениями</span></div></div>
   ${table(["Карта","В рабочей","В системе"],[["Негрони","джин 30","джин 40"],["Маргарита","ликёр 15","ликёр 20"],["Настойка «Клюква»","выхода нет","порция 40"]])}</div>${secFindings("cards")}`;
  const ttk=S.data.ttk;
  return `${setup("cards")}
  <div class="sec"><div class="row"><h2>Загруженные карты</h2>${q("cards")}</div>
   ${ttk.length?`<div class="list">${ttk.map(t=>`<div class="li"><div><b>${esc(t.name)}</b><span class="muted">${t.rows.length} строк</span></div></div>`).join("")}</div>`:`<div class="card"><p class="muted">Карт пока нет. Загрузите рабочие ТТК в Excel или CSV.</p></div>`}</div>
  ${secFindings("cards")}`;
}

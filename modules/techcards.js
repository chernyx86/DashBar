"use strict";
/* ---------- Техкарты ---------- */
const RECIPE_UNITS={
  "мл":"мл","л":"л","г":"г","гр":"г","грамм":"г","грамма":"г","граммов":"г",
  "кг":"кг","шт":"шт","штука":"шт","штук":"шт","дэш":"дэш","деш":"дэш"
};
const RECIPE_UNIT_OPTIONS=["мл","л","г","кг","шт","дэш"];
function recipeLayout(name){
  return {"классика":"classic","осень 26":"season","тк пф":"prep"}[normHeader(name)];
}
function recipeAmount(raw){
  const amount=/^(\d+(?:[.,]\d+)?)\s*([а-яё]+)?\.?$/i;
  const direct=raw.match(amount);
  // Some cards explicitly give both dashes and their equivalent in ml.
  const equivalent=raw.match(/^\d+(?:[.,]\d+)?\s*д[еэ]ш\s*\(([^)]+)\)$/i)?.[1].match(amount);
  const match=direct||equivalent;
  const qty=match?readNumber(match[1]):null;
  return {qty:Number.isFinite(qty)?qty:null,unit:RECIPE_UNITS[match?.[2]?.toLowerCase()]||""};
}
function parseRecipeSheet({name,sourceRows}){
  const layout=recipeLayout(name);
  if(!layout||!sourceRows)return null;
  const cards=[];
  let card=null;
  sourceRows.forEach((cells,index)=>{
    if(layout==="prep"&&index===0&&normHeader(cells[1])==="ингредиенты")return;
    const title=cellText(cells[0]);
    if(/^(метод|бокал|гарниш)(?:\s|[-–—:]|$)/i.test(title))return;
    if(title){
      card={name:title,sheet:name,sourceLine:index+1,rows:[],outputs:[]};
      cards.push(card);
    }
    const pos=cellText(cells[1]);
    if(!card||!pos||/^(гарниш|бокал|метод)(?:\s|[-–—:]|$)/i.test(pos))return;
    const raw=cellText(cells[layout==="classic"?3:2]);
    const line={pos,raw,sourceLine:index+1,...recipeAmount(raw)};
    if(/^выход(?:\s|$)/i.test(pos))card.outputs.push(line);
    else card.rows.push(line);
  });
  return {label:name,cards:cards.filter(entry=>entry.rows.length)};
}
function previewRecipeImport(s,option){
  const total=option.cards.flatMap(card=>card.rows.concat(card.outputs));
  return `<h2>Импорт техкарт</h2><p class="muted">${esc(s.file)}</p>
    <label class="field">Лист книги<select class="in" data-upload-select>
    ${s.items.map((item,i)=>`<option value="${i}" ${i===s.selected?"selected":""}>${esc(item.label)}</option>`).join("")}
    </select></label>
    <p>Карт: ${option.cards.length}. Строк к проверке: ${total.filter(r=>!r.unit||r.qty===null).length}.</p>
    <p>Повторный импорт файла заменит карты с выбранного листа.</p>
    <button class="btn p" data-a="importpreview">Сохранить карты</button>`;
}
function storeRecipeSheet(file,option){
  commitOperationalData("cards",()=>{
    const src=JSON.stringify([file,option.label]);
    const cardKey=card=>JSON.stringify([card.name,card.sourceLine]);
    const existing=new Map(S.data.ttk.filter(t=>t.src===src).map(t=>[cardKey(t),t]));
    const cards=option.cards.map(card=>{
      const prior=existing.get(cardKey(card));
      const confirmations=new Map((prior?.rows||[]).concat(prior?.outputs||[])
        .filter(row=>row.confirmedUnit).map(row=>[row.sourceLine,row]));
      const restore=row=>{
        const old=confirmations.get(row.sourceLine);
        return !row.unit&&old?.raw===row.raw&&old.pos===row.pos?{...row,confirmedUnit:old.confirmedUnit}:row;
      };
      return {...card,src,file,rows:card.rows.map(restore),outputs:card.outputs.map(restore)};
    });
    S.data.ttk=S.data.ttk.filter(t=>t.src!==src).concat(cards);
    S.sec.cards.docs.ttk={name:file,local:true,res:{doc_type:"Техкарты",summary:`Лист «${option.label}»: ${cards.length} карт.`}};
  });
}
function confirmRecipeUnit(indexValue,lineValue){
  const index=Number(indexValue), sourceLine=Number(lineValue), card=S.data.ttk[index];
  const row=card?.sheet&&card.rows.concat(card.outputs).find(row=>row.sourceLine===sourceLine);
  const unit=document.getElementById(`recipe-unit-${index}-${sourceLine}`)?.value;
  if(isDemo()||!row||row.unit||row.qty===null||!RECIPE_UNIT_OPTIONS.includes(unit))return;
  try{
    commitOperationalData("cards",()=>{
      const update=entry=>entry===row?{...entry,confirmedUnit:unit}:entry;
      S.data.ttk=S.data.ttk.map((entry,i)=>i===index?{...entry,rows:card.rows.map(update),outputs:card.outputs.map(update)}:entry);
    });
    render(true);
    const detail=document.getElementById(`recipe-${index}`);
    if(detail)detail.open=true;
    toast("Единица подтверждена");
  }catch(error){toast(error.message);}
}
function recipeCard(card,index){
  if(!card.sheet)return `<div class="li"><div><b>${esc(card.name)}</b><span class="muted">${card.rows.length} строк</span></div></div>`;
  const rows=card.rows.concat(card.outputs);
  const unresolved=rows.filter(r=>!(r.unit||r.confirmedUnit)||r.qty===null).length;
  return `<details class="card" id="recipe-${index}">
    <summary><b>${esc(card.name)}</b> · ${card.rows.length} ингр.${unresolved?` · уточнить: ${unresolved}`:""}</summary>
    <p class="muted">${esc(card.file)} · лист «${esc(card.sheet)}» · строка ${card.sourceLine}</p>
    ${rows.map(r=>{
      const id=`recipe-unit-${index}-${r.sourceLine}`;
      return `<div class="li"><div><b>${esc(r.pos)}</b><p class="muted">Строка ${r.sourceLine} · ${esc(r.raw||"количество не указано")}${r.confirmedUnit?` · подтверждено: ${esc(r.confirmedUnit)}`:""}</p>
        ${r.qty===null?`<p>Проверьте количество в исходной карте.</p>`:r.unit?"":`<div class="row"><label class="field" for="${id}">Единица<select class="in" id="${id}">
        <option value="">Выберите единицу</option>${RECIPE_UNIT_OPTIONS.map(unit=>`<option ${unit===r.confirmedUnit?"selected":""}>${unit}</option>`).join("")}
        </select></label><button class="btn" data-a="recipeunit" data-index="${index}" data-line="${r.sourceLine}">Подтвердить</button></div>`}</div></div>`;
    }).join("")}
    </details>`;
}
function vCards(){
  if(isDemo()) return `<div class="sec"><div class="grid2"><div class="tile"><span class="l">Карт проверено</span><span class="n">64</span><span class="f">рабочие ТТК</span></div><div class="tile"><span class="l">Сходятся с системой</span><span class="n">51</span><span class="f">13 с расхождениями</span></div></div>
   ${table(["Карта","В рабочей","В системе"],[["Негрони","джин 30","джин 40"],["Маргарита","ликёр 15","ликёр 20"],["Настойка «Клюква»","выхода нет","порция 40"]])}</div>${secFindings("cards")}`;
  const ttk=S.data.ttk;
  const documents=setup("cards");
  return `${ttk.length?"":documents}
  <div class="sec"><div class="row"><h2>Загруженные карты</h2>${q("cards")}</div>
   ${ttk.length?`<div class="list">${ttk.map(recipeCard).join("")}</div>`:`<div class="card"><p class="muted">Карт пока нет. Загрузите рабочие ТТК в Excel или CSV.</p></div>`}</div>
  ${secFindings("cards")}
  ${ttk.length?documents:""}`;
}

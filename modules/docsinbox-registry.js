"use strict";

const docsInboxFields={
  supplierNumber:"номер накладной поставщика", date:"дата", internalNumber:"внутренний номер",
  supplier:"поставщик", buyer:"покупатель", amount:"сумма", egais:"ид документа в егаис"
};
function parseDocsInboxRegistry(book){
  const sheets=book.sheets.length?book.sheets:[{rows:book.rows}];
  const hits=[];
  for(const {rows} of sheets){
    for(let i=0;i<Math.min(rows.length,30);i++){
      const headers=rows[i].map(normHeader);
      const cols=Object.fromEntries(Object.entries(docsInboxFields).map(([key,label])=>[key,headers.indexOf(label)]));
      if(Object.entries(cols).every(([key,index])=>key==="egais"||index>=0)){
        hits.push({rows:rows.slice(i+1),cols,header:i});
        break;
      }
    }
  }
  if(!hits.length)return null;
  if(hits.length>1)throw new Error("В файле несколько реестров DocsInBox. Сохраните каждый реестр отдельным файлом.");
  const {rows,cols,header}=hits[0];
  if(!rows.length||rows.length>10000)throw new Error("Реестр должен содержать от 1 до 10 000 строк.");
  return rows.map((row,index)=>{
    const item=Object.fromEntries(Object.entries(cols).map(([key,col])=>[key,cellText(row[col])]));
    const date=parseDate(item.date), amount=cents(readNumber(item.amount));
    if(!date||!item.supplierNumber||!item.internalNumber||!item.supplier||!item.buyer||
      !Number.isSafeInteger(amount)||amount<0)throw new Error(`Строка ${header+index+2}: проверьте номер, дату, поставщика, покупателя и сумму.`);
    return {...item,date,amount};
  });
}
function docsInboxIdentity(row){
  const inn=row.supplier.match(/\((\d{12}|\d{10})(?=\s|\/|\))/)?.[1];
  return JSON.stringify([receiveKey(row.supplierNumber),row.date,inn||receiveKey(row.supplier),receiveKey(row.buyer)]);
}
function docsInboxGroups(rows){
  const groups=new Map();
  for(const row of rows){
    const key=docsInboxIdentity(row);
    if(!groups.has(key))groups.set(key,{...row,amounts:new Map()});
    const amounts=groups.get(key).amounts;
    if(!amounts.has(row.amount))amounts.set(row.amount,new Set());
    amounts.get(row.amount).add(row.internalNumber);
  }
  return [...groups.values()].sort((a,b)=>b.date.localeCompare(a.date));
}
function mergeDocsInboxRows(current,added){
  const keys=new Set();
  return current.concat(added).filter(row=>{
    const key=JSON.stringify([docsInboxIdentity(row),receiveKey(row.internalNumber),row.amount,receiveKey(row.egais)]);
    if(keys.has(key))return false;
    keys.add(key);
    return true;
  });
}
function renderDocsInboxPreflight(s){
  const groups=docsInboxGroups(s.rows);
  const conflicts=groups.filter(g=>g.amounts.size>1).length;
  const repetitions=s.rows.length-groups.reduce((n,g)=>n+g.amounts.size,0);
  return `<h2>Реестр накладных DocsInBox</h2>
    <p>${s.rows.length} строк, ${groups.length} групп накладных. Совпадений по сумме внутри групп: ${repetitions}. Групп с разными суммами: ${conflicts}.</p>
    <p>Реестр содержит сведения о документах. Для прихода нужны оригиналы с товарными строками и количеством.</p>
    ${docsInboxTable(groups.slice(0,8))}
    <button class="btn p" data-a="savedocsinbox">Сохранить реестр</button>`;
}
function docsInboxTable(groups){
  return table(["Дата","Поставщик","Номер","Суммы","Номера DocsInBox"],groups.map(group=>[
    ruDate(group.date),group.supplier,group.supplierNumber,
    [...group.amounts.keys()].map(amount=>exactMoney(amount/100)).join(" / ")+(group.amounts.size>1?" · сверить":""),
    [...group.amounts.values()].map(ids=>[...ids].join(", ")).join(" / ")
  ]));
}
function renderDocsInboxRows(s){
  const query=receiveKey(s.query||"");
  const groups=docsInboxGroups(S.data.docsInboxRegistry);
  const filtered=groups.filter(g=>{
    if(s.conflicts&&g.amounts.size<2)return false;
    const keys=[g.supplier,g.supplierNumber,g.buyer,...[...g.amounts.values()].flatMap(ids=>[...ids])];
    return !query||keys.some(value=>receiveKey(value).includes(query));
  });
  const shown=filtered.slice(0,s.limit||25);
  return `<p class="muted" role="status">Найдено: ${filtered.length} из ${groups.length}</p>
    ${shown.length?docsInboxTable(shown):"<p>Совпадений нет.</p>"}
    ${shown.length<filtered.length?'<button class="btn s" data-a="docsinboxmore">Показать ещё</button>':""}`;
}
function paintDocsInboxRows(){
  const target=document.getElementById("docsinbox-rows");
  if(target&&sheet?.t==="docsinboxRegistry")target.innerHTML=renderDocsInboxRows(sheet);
}
function renderDocsInboxRegistry(s){
  return `<h2>Реестр DocsInBox</h2><p>Сведения из выгрузки. В спорных строках суммы и внутренние номера указаны в одинаковом порядке.</p>
    <label class="field">Номер или поставщик<input class="in" type="search" data-docsinbox-query value="${esc(s.query||"")}"></label>
    <label class="row"><input type="checkbox" data-docsinbox-conflicts ${s.conflicts?"checked":""}>Только группы с разными суммами</label>
    <div id="docsinbox-rows">${renderDocsInboxRows(s)}</div>`;
}
async function saveDocsInboxRegistry(){
  if(sheet?.t!=="docsinboxPreview"||incoming.busy)return;
  const draft=sheet;
  const merged=mergeDocsInboxRows(S.data.docsInboxRegistry,draft.rows);
  const added=merged.length-S.data.docsInboxRegistry.length;
  if(merged.length>20000)return toast("В профиле уже слишком много строк реестра. Сделайте резервную копию.");
  try {
    commitReceiving(()=>{S.data.docsInboxRegistry=merged;});
  } catch(error) {
    return toast(error.message);
  }
  sheet={t:"docsinboxRegistry",limit:25,query:""};
  render(true);
  toast(added?`Сохранено записей: ${added}.`:"Эти записи уже сохранены.");
  if(draft.queueId)return runIncoming(async()=>{
    try{
      await incomingRequest("/documents/"+draft.queueId+"/reviewed",{method:"POST"});
      incoming.queue=incoming.queue.filter(item=>item.id!==draft.queueId);
      return "Реестр сохранён.";
    }catch(e){return "Реестр сохранён. Документ пока остаётся в очереди.";}
  });
}

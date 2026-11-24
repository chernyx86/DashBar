"use strict";
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=()=>rej(new Error("Не удалось загрузить модуль чтения"));document.head.appendChild(s);});}
function shrink(blob){return new Promise((res,rej)=>{const img=new Image(),u=URL.createObjectURL(blob);
  img.onload=()=>{const k=Math.min(1,1800/Math.max(img.width,img.height)),c=document.createElement("canvas");
    c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    URL.revokeObjectURL(u);c.toBlob(b=>b?res(b):rej(new Error("Не удалось обработать изображение")),"image/jpeg",.85);};
  img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("Не удалось открыть изображение"));};
  img.src=u;});}
/* FIX: разделитель по нескольким строкам */
function parseCSV(text){
  const sample=text.slice(0,8000).split(/\r?\n/).filter(l=>l.trim()).slice(0,12);
  const delimiters=[";","\t","|",","];
  const score=d=>sample.reduce((n,line)=>{
    const parts=line.replace(/"((?:[^"]|"")*)"/g,(_,cell)=>cell.replaceAll(d," ")).split(d);
    return n+parts.filter(x=>Object.values(H).some(keys=>col([x],keys)===0)).length;
  },0);
  const delimiter=delimiters.reduce((a,b)=>score(b)>score(a)?b:a);
  const rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=false;
      else cell+=c;
    }else if(c==='"'&&!cell.trim())quoted=true;
    else if(c===delimiter){row.push(cell);cell="";}
    else if(c==="\n"||c==="\r"){
      if(c==="\r"&&text[i+1]==="\n")i++;
      row.push(cell);rows.push(row);row=[];cell="";
    }else cell+=c;
  }
  if(quoted)throw new Error("В таблице осталась незакрытая кавычка. Проверьте экспорт файла.");
  if(cell!==""||row.length){row.push(cell);rows.push(row);}
  return rows.map(r=>r.map(x=>x.trim())).filter(r=>r.some(Boolean));
}
function parseLoose(text){
  const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return [];
  let sep=null;
  for(const cand of ["\t",";","|"]){
    if(lines.filter(l=>l.split(cand).length>=2).length>=Math.max(2,lines.length*0.5)){sep=cand;break;}
  }
  if(!sep&&lines.filter(l=>/\s{2,}/.test(l)).length>=lines.length*0.5)sep=/\s{2,}/;
  if(!sep)sep=",";
  return lines.map(l=>String(l).split(sep).map(x=>x.trim())).filter(r=>r.length>1);
}
async function readFile(file, receiving, doc){
  const n=(file.name||"").toLowerCase(); let text="",rows=[],images=[],part=false,sheets=[];
  if((file.type||"").startsWith("image/")){
    if(receiving)throw new Error("Загрузите Excel, CSV, TSV или PDF с табличным текстом.");
    images=[await shrink(file)];
  }
  else if(/\.(xlsx|xls)$/.test(n)){
    if(!window.XLSX){
      try{await loadScript("./assets/xlsx.full.min.js");}
      catch(e){await loadScript(CDN.xlsx);}
    }
    const wb=XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true});
    sheets=wb.SheetNames.map(name=>{
      const ws=wb.Sheets[name];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,blankrows:false,raw:true,defval:""});
      if(!ws["!ref"]||!(doc==="ttk"&&recipeLayout(name)||doc==="inv"||doc==="rest"))return {name,rows};
      const range=XLSX.utils.decode_range(ws["!ref"]);
      range.s={r:0,c:0};
      return {name,rows,sourceRows:XLSX.utils.sheet_to_json(ws,{header:1,range,blankrows:true,raw:true,defval:""})};
    }).filter(entry=>entry.rows.length>1);
    rows=sheets[0]?.rows||[];
    text=rows.map(r=>r.join("\t")).join("\n");
  }
  else if(/\.(csv|tsv)$/.test(n)||file.type==="text/csv"){
    const bytes=await file.arrayBuffer();
    text=new TextDecoder().decode(bytes);
    if(text.includes("�"))text=new TextDecoder("windows-1251").decode(bytes);
    rows=parseCSV(text);
  }
  else if(/\.pdf$/.test(n)){
    if(!window.pdfjsLib){
      try{await loadScript(CDN.pdf);}
      catch(e){if(receiving)return {text,rows,images,part,sheets};throw e;}
    }
    /* FIX: явный workerSrc */
    if(window.pdfjsLib&&!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc=CDN.pdfw;
    try{
      const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
      for(let i=1;i<=Math.min(pdf.numPages,6);i++){
        const p=await pdf.getPage(i),tc=await p.getTextContent();
        text+=tc.items.map((x,index)=>{
          const next=tc.items[index+1];
          return x.str+(x.hasEOL||!next||Math.abs(next.transform[5]-x.transform[5])>2?"\n":"  ");
        }).join("");
        text+="\n";
        if(!receiving&&sampleFn&&i<=2){const vp=p.getViewport({scale:1.5}),c=document.createElement("canvas");c.width=vp.width;c.height=vp.height;
          await p.render({canvasContext:c.getContext("2d"),viewport:vp}).promise;
          images.push(await new Promise(r=>c.toBlob(r,"image/jpeg",.82)));}
      }
      if(pdf.numPages>6)part=true;
      rows=parseLoose(text);
    }catch(e){}
  }
  else{text=await file.text();rows=parseLoose(text);}
  if(text.length>LIM)text=text.slice(0,LIM);
  return {text,rows,images,part,sheets};
}
/* ---------- Локальный разбор ---------- */
const H={
 pos:["позиция","наименование","товар","номенклатура","название","продукт","ингредиент","блюдо","карта"],
 book:["учет","по учету","учетный остаток","книжн","систем","остаток по"],
 fact:["факт","по факту","фактический остаток","остаток фактический"],
 qty:["количество","кол во","колво","qty","остаток","приход","расход"],
 price:["цена","price","стоимость за"],
 sum:["сумма","итого","total","стоимость","выручка"],
 unit:["ед изм","единица","единица измерения","единицы","ед"],
 supplier:["поставщик","продавец","контрагент","vendor"],
 buyer:["покупатель"],
 deliveryAddress:["адрес поставки","адрес доставки","адрес грузополучателя","грузополучатель и его адрес"],
 reason:["причина","основание"],
 category:["категория","группа","раздел"],
 out:["выход","нетто","output"],
 gross:["брутто"],
 date:["дата","date"],
 number:["номер накладной","номер документа","накладная n","invoice number"]
};
function normHeader(s){return String(s==null?"":s).toLowerCase().replace(/ё/g,"е").replace(/[^a-zа-я0-9]+/g," ").trim();}
function col(head,keys){
  const headers=head.map(normHeader), aliases=keys.map(normHeader);
  const exact=headers.findIndex(h=>aliases.includes(h));
  if(exact>=0)return exact;
  return headers.findIndex(h=>aliases.some(k=>k.length>=3&&h.startsWith(k+" ")));
}
function cellText(value){
  if(value instanceof Date&&Number.isFinite(value.getTime()))return value.toISOString().slice(0,10);
  return String(value??"").trim();
}
const DOC_TITLE={inventory:"Сличительная ведомость",stock:"Остатки",invoice:"Накладная",matrix:"Матрица цен",sales:"Продажи",writeoff:"Списания",ttk:"Техкарта",unknown:"Документ"};
function parseDoc(rows,hint){
  if(!rows||rows.length<2)return null;
  let hi=-1,head=[];
  for(let i=0;i<Math.min(rows.length,30);i++){
    const h=rows[i]||[];
    const identifiable=col(h,H.pos)>=0||(hint==="writeoff"&&col(h,H.reason)>=0);
    const sc=Object.values(H).filter(keys=>col(h,keys)>=0).length;
    if(identifiable&&sc>=2){hi=i;head=h;break;}
  }
  if(hi<0)return null;
  const C={};Object.keys(H).forEach(k=>C[k]=col(head,H[k]));
  let taxBasis="";
  if(hint==="invoice"){
    const labels=head.map(normHeader);
    const isTotal=h=>/^(?:сумма|стоимость|итого|всего)(?: |$)/.test(h)&&!/(?:^| )за (?:единицу|ед)(?: |$)/.test(h)&&!/^сумма (?:ндс|налога)(?: |$)/.test(h);
    const isGross=h=>/(?:^| )(?:с (?:ндс|налогом|учетом (?:ндс|налога))|включая ндс)(?: |$)/.test(h);
    const isNet=h=>/(?:^| )без (?:ндс|налога|учета (?:ндс|налога))(?: |$)/.test(h);
    const gross=labels.findIndex(h=>isTotal(h)&&isGross(h));
    if(gross>=0){C.sum=gross;taxBasis="gross";if(C.price>=0&&!isGross(labels[C.price]))C.price=-1;}
    else{
      if(C.sum>=0&&/^сумма (?:ндс|налога)(?: |$)/.test(labels[C.sum]))C.sum=labels.findIndex(isTotal);
      if(C.sum>=0&&isNet(labels[C.sum]))taxBasis="net";
    }
    if(C.sum===C.price)C.sum=-1;
    if(C.sum<0&&C.price>=0&&isNet(labels[C.price]))taxBasis="net";
  }
  const body=rows.slice(hi+1);
  const get=(r,k)=>{const i=C[k];return i>=0?cellText(r?.[i]):"";};
  const out=body.map((r=[],index)=>({
    sourceLine:hi+2+index,
    pos:get(r,"pos"),book:get(r,"book"),fact:get(r,"fact"),qty:get(r,"qty"),price:get(r,"price"),
    sum:get(r,"sum"),unit:get(r,"unit"),supplier:get(r,"supplier"),buyer:get(r,"buyer"),deliveryAddress:get(r,"deliveryAddress"),reason:get(r,"reason"),
    category:get(r,"category"),out:get(r,"out"),gross:get(r,"gross"),date:get(r,"date"),number:get(r,"number")
  })).filter(r=>r.pos||r.reason||((hint==="invoice"||hint==="matrix")&&[r.qty,r.price,r.sum].some(Boolean)));
  const hAll=head.map(normHeader).join(" ");
  let type="unknown";
  if(C.fact>=0&&C.book>=0)type="inventory";
  else if(C.gross>=0||/брутто|нетто|выход/.test(hAll))type="ttk";
  else if(/списан|бой|порч|акт о/.test(hAll))type="writeoff";
  else if(/продаж|выручк|реализац/.test(hAll)&&C.qty>=0)type="sales";
  else if((C.price>=0||(hint==="invoice"&&C.sum>=0))&&C.qty>=0)type="invoice";
  else if(C.price>=0&&C.pos>=0&&hint==="matrix")type="matrix";
  else if(C.qty>=0)type="stock";
  else if(C.reason>=0&&C.sum>=0)type="writeoff";
  if(hint==="sales"&&type==="stock"&&C.sum>=0)type="sales";
  if(hint==="menu"&&type==="unknown"&&C.price>=0)type="ttk";
  if(!out.length)return null;
  return {type,rows:out,head,metadata:rows.slice(0,hi),date:findDate(rows),title:DOC_TITLE[type],...(taxBasis?{taxBasis}:{})};
}
function parseDate(value){
  const s=cellText(value);
  let m=s.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if(!m){
    const local=s.match(/(?:^|\D)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})(?!\d)/);
    if(!local)return "";
    m=["",local[3].length===2?"20"+local[3]:local[3],pad(local[2]),pad(local[1])];
  }
  const iso=m.slice(1).join("-");
  const d=new Date(iso+"T12:00:00Z");
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso?iso:"";
}
function salesPeriod(metadata){
  const text=metadata.flat().map(cellText).join(" ");
  const date=String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})`;
  const match=text.match(new RegExp(`(?:^|\\s)с\\s+(${date})\\s+по\\s+(${date})(?=\\s|$|[.,;])`,"i"));
  if(!match)return null;
  const start=parseDate(match[1]), end=parseDate(match[2]);
  return start&&end&&end>=start?{start,end}:null;
}
function findDate(rows){
  for(const row of rows.slice(0,10)){
    for(const cell of row||[]){
      const date=parseDate(cell);
      if(date)return date;
    }
  }
  return "";
}
function workbookTable(rows,test){
  return rows.slice(0,40).findIndex(test);
}
function inColumn(row,keys){
  return row.findIndex(value=>keys.includes(normHeader(value)));
}
function warehouseLabel(rows){
  const row=rows.slice(0,20).find(r=>/^склад(?:\s|:|$)/i.test(cellText(r[0])));
  if(!row)return "";
  return cellText(row[0]).split(":").slice(1).join(":").trim()||row.slice(1).map(cellText).find(Boolean)||"";
}
function barWarehouse(name){
  if(!name||/(кухн|кальян|хука)/i.test(name))return false;
  return S.venue.stockName.trim()?receiveKey(name)===receiveKey(S.venue.stockName):/^бар(?:[\s(–-]|$)/i.test(name);
}
const itemTotal=name=>/^(?:итого|всего)(?:$| по )/.test(receiveKey(name));
function stockWorkbook(rows,sheetName){
  const opening=rows.slice(0,5).flat().map(normHeader);
  const osv=opening.includes("расширенная оборотно сальдовая ведомость");
  if(!osv&&!opening.includes("остатки на складах"))return [];
  const header=workbookTable(rows,h=>osv?
    inColumn(h,["остатки на конец","остаток на конец"])>=0:
    inColumn(h,["название товара","наименование","наименование товара","номенклатура"])>=0);
  if(header<0)throw new Error("В отчёте не найден заголовок остатков.");
  const columns=rows[header];
  const names=["название товара","наименование","наименование товара","номенклатура","товар"];
  const units=["ед измерения","ед изм","единица измерения","единица"];
  const pos=inColumn(osv?rows[header+1]:columns,names);
  const unit=inColumn(columns,units);
  const code=inColumn(osv?rows[header+1]:columns,["артикул","код","код товара"]);
  const date=osv?rows.slice(0,6).flat().map(cellText).join(" ").match(/(?:^|\s)по\s+(\d{2}\.\d{2}\.\d{4})/i)?.[1]:findDate(rows.slice(0,header));
  const balance=inColumn(columns,["остатки на конец","остаток на конец"]);
  const options=osv?[{warehouse:warehouseLabel(rows),index:balance}]:columns.map((cell,index)=>({warehouse:cellText(cell),index}))
    .filter(entry=>entry.index>unit&&barWarehouse(entry.warehouse));
  if(!options.length||pos<0||options.some(entry=>!barWarehouse(entry.warehouse)))throw new Error("Выберите выгрузку с отдельным складом бара. Если в учёте он называется иначе, укажите точное название в настройках.");
  if(osv&&inColumn([rows[header+1][balance]],["кол во","количество"])!==0)throw new Error("В ведомости не найдена колонка количества на конец периода.");
  return options.map(({warehouse,index})=>{
    const start=header+(osv?2:1);
    const body=rows.slice(start).flatMap((r,rowOffset)=>{
      const name=cellText(r[pos]), raw=r[index], qty=readNumber(raw);
      if(!name||itemTotal(name)||!Number.isFinite(qty))return [];
      return [{pos:name,qty,unit:cellText(r[unit])||name.match(/,\s*(шт|кг|л|г|мл|уп\.?|бут\.?)$/i)?.[1]||"",
        code:cellText(r[code]),sheet:sheetName,sourceLine:start+rowOffset+1}];
    });
    const duplicates=new Set();
    const keys=new Set();
    for(const row of body){
      const key=receiveKey(row.pos);
      if(keys.has(key))duplicates.add(key);
      keys.add(key);
    }
    return {label:warehouse,warehouse,date:date?parseDate(date):"",type:osv?"Оборотно-сальдовая ведомость":"Остатки на складах",
      rows:body.filter(r=>!duplicates.has(receiveKey(r.pos))),excluded:body.filter(r=>duplicates.has(receiveKey(r.pos))).length};
  });
}
function splitBarFact(sheets){
  return sheets.flatMap(({name,sourceRows:rows})=>{
    if(!rows||normHeader(name)!=="товары")return [];
    const header=workbookTable(rows,(row,index)=>inColumn(row,["бар"])>=0&&inColumn(row,["всего"])>=0&&
      inColumn(rows[index+1]||[],["наименование"])>=0);
    if(header<0)return [];
    const columns=rows[header], names=rows[header+1];
    const pos=inColumn(names,["наименование"]), unit=inColumn(columns,["ед изм","ед измерения"]);
    const fact=inColumn(columns,["бар"]), code=inColumn(names,["код","артикул"]);
    if(unit<0)return [];
    const rowsOut=rows.slice(header+2).flatMap((row,index)=>{
      const name=cellText(row[pos]), qty=readNumber(row[fact]);
      return !name||itemTotal(name)?[]:[{pos:name,code:cellText(row[code]),unit:cellText(row[unit]),
        fact:Number.isFinite(qty)&&qty>=0?qty:null,sheet:name,sourceLine:header+index+3}];
    });
    const form=sheets.find(item=>normHeader(item.name)==="блюда заготовки");
    return [{label:name,formDate:findDate(form?.rows.slice(0,8)||[]),rows:rowsOut}];
  });
}
function factWorkbook(sheets){
  const parts=sheets.flatMap(({name,rows})=>{
    if(!rows.slice(0,5).flat().some(v=>normHeader(v)==="бланк инвентаризации"))return [];
    const header=workbookTable(rows,(h,index)=>inColumn(h,["наименование","название товара"])>=0&&
      inColumn(rows[index-1]||[],["остаток фактический","фактический остаток"])>=0);
    if(header<0)return [];
    const item=inColumn(rows[header],["наименование","название товара"]);
    const unit=inColumn(rows[header-1],["ед изм","ед измерения","единица"]);
    const fact=inColumn(rows[header-1],["остаток фактический","фактический остаток"]);
    const rowsOut=rows.slice(header+1).flatMap(r=>{
      const pos=cellText(r[item]), value=readNumber(r[fact]);
      return !pos||itemTotal(pos)?[]:[{pos,unit:cellText(r[unit]),fact:Number.isFinite(value)&&value>=0?value:null}];
    });
    return [{label:name,warehouse:warehouseLabel(rows),date:findDate(rows.slice(0,header)),rows:rowsOut}];
  });
  return parts;
}
function priceWorkbook(sheets){
  const options=[];
  for(const {name,rows} of sheets){
    const header=workbookTable(rows,h=>col(h,H.pos)>=0&&h.some(value=>/^(закупочная цена|цена за ед)(?: |$)/.test(normHeader(value))));
    if(header<0)continue;
    const h=rows[header], pos=col(h,H.pos), supplier=col(h,H.supplier);
    const unit=inColumn(h,["ед закупки","единица закупки","фасовка","единица","ед изм","ед измерения"]);
    const price=h.findIndex(value=>/^(закупочная цена|цена за ед)(?: |$)/.test(normHeader(value)));
    if(supplier<0||unit<0)continue;
    const candidates=rows.slice(header+1).flatMap(r=>{
      const position=cellText(r[pos]), vendor=cellText(r[supplier]), measure=cellText(r[unit]), value=readNumber(r[price]);
      if(!position||itemTotal(position))return [];
      return [{pos:position,supplier:vendor,unit:measure,price:value}];
    });
    if(candidates.length)options.push({label:name,column:cellText(h[price]),candidates});
  }
  return options;
}
function workbookPreview(doc,book){
  if(!book.sheets.length)return null;
  if(doc==="ttk"){
    const items=book.sheets.map(parseRecipeSheet).filter(item=>item?.cards.length);
    if(items.length)return {kind:"recipes",items};
  }
  if(doc==="inv"){
    const split=splitBarFact(book.sheets);
    if(split.length)return {kind:"splitFacts",items:split,date:"",warehouseConfirmed:false};
    const items=factWorkbook(book.sheets);
    if(items.length)return {kind:"facts",items};
  }
  if(doc==="rest"){
    const items=book.sheets.flatMap(({name,rows,sourceRows})=>stockWorkbook(sourceRows||rows,name));
    if(items.length)return {kind:"balances",items};
  }
  if(doc==="matrix"){
    const items=priceWorkbook(book.sheets);
    if(items.length)return {kind:"contract",items,excludedSheets:book.sheets.map(s=>s.name).filter(name=>!items.some(i=>i.label===name))};
  }
  if(book.sheets.length>1)throw new Error("В книге несколько заполненных листов. Для этого типа документа загрузите один лист за раз.");
  return null;
}
function priceCandidates(option){
  const established=matrixByPosition();
  const accepted=new Map(), rejected=new Set();
  let unresolved=0, duplicates=0;
  for(const row of option.candidates){
    const key=receiveKey(row.pos), current=established.get(key), previous=accepted.get(key);
    if(!row.supplier||!row.unit||!Number.isFinite(row.price)||row.price<=0||/^(уточняется|не указан)$/i.test(row.supplier)){unresolved++;continue;}
    if((established.has(key)&&!current)||
       (current?.supplier&&receiveKey(current.supplier)!==receiveKey(row.supplier))||
       (current?.unit&&receiveUnit(current.unit)!==receiveUnit(row.unit))||
       (previous&&(previous.price!==row.price||receiveKey(previous.supplier)!==receiveKey(row.supplier)||receiveUnit(previous.unit)!==receiveUnit(row.unit)))){
      rejected.add(key);
    }
    if(previous)duplicates++;
    else accepted.set(key,row);
  }
  return {rows:[...accepted].filter(([key])=>!rejected.has(key)).map(([,row])=>row),unresolved,duplicates,conflicts:rejected.size};
}
function previewUpload(s){
  const option=s.items[s.selected||0];
  if(s.kind==="recipes")return previewRecipeImport(s,option);
  if(s.kind==="splitFacts"){
    const stock=S.data.stockReference?.snapshot;
    const ready=stock&&s.date===stock.date&&s.date<=todayISO()&&s.warehouseConfirmed&&barWarehouse(stock.warehouse);
    const matched=ready?Object.keys(prepareFactDraft(s.items)).length:0;
    const filled=option.rows.filter(row=>row.fact!==null).length;
    return `<h2>Факт по колонке «Бар»</h2><p class="muted">${esc(s.file)} · лист «Товары»</p>
      <p>Строк с фактом: ${filled}. Колонки «Склад» и «Всего» исключены.</p>
      ${option.formDate?`<p>Дата бланка: ${ruDate(option.formDate)}.</p>`:""}
      <label class="field">Дата пересчёта<input class="in" type="date" max="${todayISO()}" value="${esc(s.date)}" data-count-date></label>
      ${stock?`<p>Учётные остатки: ${ruDate(stock.date)} · ${esc(stock.warehouse)}</p>
        <label><input type="checkbox" data-count-warehouse ${s.warehouseConfirmed?"checked":""}> Колонка «Бар» относится к складу «${esc(stock.warehouse)}»</label>`:"<p>Загрузите учётные остатки бара на дату пересчёта.</p>"}
      <p>${ready?`Совпало: ${matched}. Без сопоставления: ${filled-matched}.`:"Для сверки укажите дату пересчёта и подтвердите склад учётной выгрузки."}</p>
      <button class="btn p" data-a="importpreview" ${matched?"":"disabled"}>Перенести совпадения в черновик</button>`;
  }
  const label=s.kind==="facts"?"Фактические остатки":s.kind==="balances"?"Учётные остатки":"Закупочные цены";
  const select=s.kind==="facts"||s.items.length===1?"":`<label class="field">${s.kind==="contract"?"Лист книги":"Склад бара"}
    <select class="in" data-upload-select>${s.items.map((item,i)=>`<option value="${i}" ${i===(s.selected||0)?"selected":""}>${esc(item.label)}</option>`).join("")}</select></label>`;
  if(s.kind==="facts"){
    const count=s.items.reduce((n,item)=>n+item.rows.filter(r=>r.fact!==null).length,0);
    const stock=S.data.stockReference?.snapshot;
    const comparable=s.items.every(item=>stock&&item.date&&stock.date===item.date&&item.date<=todayISO()&&
      barWarehouse(item.warehouse)&&receiveKey(stock.warehouse)===receiveKey(item.warehouse));
    const why=!s.items.every(i=>barWarehouse(i.warehouse))?"Склад в бланке не распознан как отдельный бар. Загрузите отдельную выгрузку или проверьте название склада в настройках.":
      !stock?"Загрузите учётные остатки бара на дату инвентаризации.":"Проверьте, совпадают ли дата и склад с учётными остатками.";
    const mergeable=comparable?prepareFactDraft(s.items):{};
    return `<h2>${label}</h2><p class="muted">${esc(s.file)}</p>${table(["Лист","Дата","Склад","С фактом","Без факта"],s.items.map(item=>[
      item.label,item.date?ruDate(item.date):"—",item.warehouse||"—",
      String(item.rows.filter(r=>r.fact!==null).length),String(item.rows.filter(r=>r.fact===null).length)]))}
      <p>${count} заполненных строк.${comparable?` Совпали с учётом по названию и единице: ${Object.keys(mergeable).length}.`:" "+esc(why)}</p>
      ${Object.keys(mergeable).length?`<button class="btn p" data-a="importpreview">Перенести совпадения в черновик</button>`:""}`;
  }
  if(s.kind==="balances"){
    const previous=S.sec.stock.docs.rest?.res?.snapshot;
    const older=previous?.date&&option.date&&previous.date>option.date;
    const future=option.date>todayISO();
    const other=previous?.warehouse&&receiveKey(previous.warehouse)!==receiveKey(option.warehouse);
    return `<h2>${label}</h2><p class="muted">${esc(s.file)}</p>${select}
      <p>${esc(option.type)} · ${esc(option.warehouse)} · ${option.date?ruDate(option.date):"дата отсутствует"}</p>
      <p>Готово к загрузке: ${option.rows.length} строк.${option.excluded?" Исключено из-за повторов названия: "+option.excluded+".":""}</p>
      ${table(["Позиция","Остаток"],option.rows.slice(0,5).map(r=>[r.pos,fmt(r.qty,4)+" "+r.unit]))}
      ${future?'<p>Дата остатков не может быть в будущем.</p>':older?'<p>В приложении уже есть остатки на более позднюю дату.</p>':other?'<p>Загруженный склад отличается от текущего.</p>':''}
      <button class="btn p" data-a="importpreview" ${older||future||other||!option.rows.length||!option.date?"disabled":""}>Сохранить остатки бара</button>`;
  }
  const candidates=priceCandidates(option);
  return `<h2>${label}</h2><p class="muted">${esc(s.file)}</p>${select}
    <p>Колонка «${esc(option.column)}». Сверьте эти цены с договорённостями перед сохранением.</p>
    <p>Готово: ${candidates.rows.length} · без полной цены: ${candidates.unresolved} · повторы: ${candidates.duplicates} · конфликты: ${candidates.conflicts}.</p>
    ${s.excludedSheets.length?`<p class="muted">Листы без однозначной закупочной колонки: ${esc(s.excludedSheets.join(", "))}.</p>`:""}
    ${table(["Позиция","Поставщик","Единица","Цена"],candidates.rows.slice(0,5).map(r=>[r.pos,r.supplier,r.unit,exactMoney(r.price)]))}
    <button class="btn p" data-a="importpreview" ${candidates.rows.length?"":"disabled"}>Подтвердить закупочные цены</button>`;
}
function prepareFactDraft(items,sources){
  const quantities=new Map(), stock=new Map(), byCode=new Map();
  for(const [name,r] of Object.entries(S.data.stockReference?.stock||{})){
    const entry={name,...r};
    const key=receiveKey(name);
    stock.set(key,stock.has(key)?null:entry);
    if(r.code)byCode.set(r.code,byCode.has(r.code)?null:entry);
  }
  for(const {rows} of items){
    for(const r of rows){
      if(r.fact===null)continue;
      const named=stock.get(receiveKey(r.pos));
      const entry=r.code&&byCode.has(r.code)?byCode.get(r.code):named;
      if(!entry||(r.code&&entry.code&&r.code!==entry.code))continue;
      quantities.set(entry.name,quantities.has(entry.name)?null:{entry,r});
    }
  }
  return Object.fromEntries([...quantities].flatMap(([name,match])=>{
    if(!match||!receiveUnit(match.r.unit)||receiveUnit(match.r.unit)!==receiveUnit(match.entry.unit))return [];
    const {entry,r}=match;
    if(sources)sources[name]={fact:{file:items[0].file,sheet:r.sheet,line:r.sourceLine,qty:r.fact},
      book:{file:entry.file,sheet:entry.sheet,line:entry.sourceLine}};
    return [[name,String(r.fact)]];
  }));
}
async function commitWorkbookPreview(){
  if(sheet?.t!=="workbook")return;
  const s=sheet, option=s.items[s.selected||0];
  try{
    if(s.kind==="recipes"){
      storeRecipeSheet(s.file,option);
      sheet=null;
    }else if(s.kind==="facts"||s.kind==="splitFacts"){
      const snapshot=S.data.stockReference?.snapshot;
      const split=s.kind==="splitFacts";
      const compatible=snapshot&&snapshot.date<=todayISO()&&(split?s.warehouseConfirmed&&s.date===snapshot.date&&barWarehouse(snapshot.warehouse):
        s.items.every(i=>i.date===snapshot.date&&barWarehouse(i.warehouse)&&receiveKey(i.warehouse)===receiveKey(snapshot.warehouse)));
      if(!compatible)
        throw new Error("Для сверки нужны остатки того же склада и даты.");
      const sources=split?Object.create(null):null;
      const rows=prepareFactDraft(s.items.map(item=>({...item,file:s.file})),sources);
      if(S.draft&&Object.keys(S.draft.rows).length&&!confirm("Заменить текущий черновик?"))return;
      if(!Object.keys(rows).length)throw new Error("Нет строк с совпадающими названием и единицей.");
      const reference=Object.fromEntries(Object.keys(rows).map(p=>[p,S.data.stockReference.stock[p]]));
      const previous=S.draft;
      S.draft={date:snapshot.date,q:"",rows,reference,warehouse:snapshot.warehouse,
        ...(split?{formDate:option.formDate,sources}:{})};
      if(!save()){S.draft=previous;throw new Error("Не удалось сохранить черновик.");}
      sheet={t:"inv"};
    }else if(s.kind==="balances"){
      const previous=S.sec.stock.docs.rest?.res?.snapshot;
      if(option.date>todayISO())throw new Error("Дата остатков не может быть в будущем.");
      if(!option.rows.length||!option.date||!barWarehouse(option.warehouse)||previous?.date>option.date||
          (previous?.warehouse&&receiveKey(previous.warehouse)!==receiveKey(option.warehouse)))throw new Error("Проверьте дату и склад.");
      const stock=Object.fromEntries(option.rows.map(r=>[r.pos,{qty:r.qty,unit:r.unit}]));
      const referenceStock=Object.fromEntries(option.rows.map(r=>[r.pos,{...stock[r.pos],
        code:r.code,file:s.file,sheet:r.sheet,sourceLine:r.sourceLine}]));
      const rest=S.sec.stock.docs.rest, old=S.data.stock, reference=S.data.stockReference;
      S.data.stock=stock;
      S.data.stockReference={snapshot:{date:option.date,warehouse:option.warehouse},stock:referenceStock};
      S.sec.stock.docs.rest={name:s.file,local:true,res:{doc_type:option.type,summary:`Остатки: ${option.rows.length} позиций.`,
        period:ruDate(option.date),snapshot:{date:option.date,warehouse:option.warehouse}}};
      if(!save()){S.data.stock=old;S.data.stockReference=reference;S.sec.stock.docs.rest=rest;throw new Error("Не удалось сохранить остатки в браузере.");}
      sheet=null;
    }else{
      const candidates=priceCandidates(option);
      if(!candidates.rows.length)throw new Error("В выбранном листе нет готовых цен.");
      commitReceiving(()=>{
        const count=storeMatrix(candidates.rows,todayISO());
        S.sec.receiving.docs={...S.sec.receiving.docs,matrix:{name:s.file,local:true,res:{doc_type:"Матрица цен",
          summary:`Лист «${option.label}»: подтверждено ${count} закупочных цен.`}}};
      });
      sheet=null;
      if(s.queueId){
        try{await incomingRequest("/documents/"+s.queueId+"/reviewed",{method:"POST"});incoming.queue=incoming.queue.filter(row=>row.id!==s.queueId);}
        catch(e){incoming.notice="Цены сохранены. Снимите файл с очереди после проверки.";}
      }
    }
    render(true);toast("Данные сохранены");
  }catch(e){toast(e.message);}
}
function receiveMetadata(parsed,key){
  const values=parsed.rows.map(r=>r[key]).filter(Boolean);
  for(const row of parsed.metadata||[]){
    const first=cellText(row[0]);
    const split=first.indexOf(":");
    const label=split>=0?first.slice(0,split):first;
    if(col([label],H[key])===0){
      const value=(split>=0?first.slice(split+1).trim():"")||cellText(row[1]);
      if(value)values.push(value);
    }
  }
  const normalized=key==="date"?values.map(value=>{
    const date=parseDate(value);
    if(!date)throw new Error(`Некорректная дата «${value}». Укажите полную дату, например 20.11.2026.`);
    return date;
  }):values;
  if(new Set(normalized.map(receiveKey)).size>1)throw new Error("Загрузите одну накладную за раз: в файле разные даты, номера или поставщики.");
  return normalized[0]||"";
}
function applyReceiving(doc,parsed,file){
  const res={doc_type:parsed.title,period:"",fits:true,summary:"",findings:[],missing:[]};
  const rows=[];
  const totals=[];
  if(doc==="invoice"&&parsed.taxBasis==="net")throw new Error("В таблице есть только стоимость без НДС. Для закупочной цены загрузите полную стоимость позиции с НДС или оригинал УПД.");
  for(const r of parsed.rows){
    if(/^(?:итого|всего)(?: к оплате| по документу)?$/.test(receiveKey(r.pos))){
      if(doc==="invoice"&&r.sum)totals.push(readNumber(r.sum));
      continue;
    }
    const price=readNumber(r.price);
    const label=r.pos?`«${r.pos}»`:`строка ${r.sourceLine}`;
    const hasPrice=String(r.price??"").trim()!=="";
    if(!r.pos||(doc==="matrix"&&(!Number.isFinite(price)||price<=0))||(hasPrice&&(!Number.isFinite(price)||price<0))){
      throw new Error(`${label}: проверьте позицию и цену.`);
    }
    if(doc==="matrix"){rows.push({pos:r.pos,unit:r.unit,supplier:r.supplier,price});continue;}
    const qty=readNumber(r.qty);
    const expected=hasPrice?cents(qty*price):null;
    const hasSum=String(r.sum??"").trim()!=="";
    const sum=hasSum?cents(readNumber(r.sum)):expected;
    if(!Number.isFinite(qty)||qty<=0||!Number.isSafeInteger(sum)||sum<0||(hasPrice&&(!Number.isSafeInteger(expected)||Math.abs(sum-expected)>Math.max(1,Math.ceil(qty*.5))))){
      throw new Error(`${label}: проверьте количество и сумму. Сумма должна равняться количеству × цене.`);
    }
    const line={pos:r.pos,unit:r.unit,qty,price:(sum/100)/qty,sum:sum/100,...(!hasSum?{calculatedSum:true}:{}),
      ...(parsed.taxBasis?{vat:r.vat,netPrice:r.netPrice,netSum:r.netSum}:{})};
    if(r.stockMatch){
      const match=invoiceCatalog().find(item=>item.name===r.stockMatch.name&&item.unit===r.stockMatch.unit);
      if(!match||invoiceQuantityIn(line,match.unit)===null)throw new Error(`${label}: проверьте сопоставление и фасовку.`);
      line.stockMatch={name:match.name,unit:match.unit};
    }
    const pack=invoicePack(line);
    rows.push(pack?{...line,pack}:line);
  }
  if(!rows.length)throw new Error("В файле нет строк с товарами.");
  if(doc==="matrix"){
    const count=storeMatrix(rows,parsed.date||todayISO());
    res.summary=`В матрице сохранено ${count} позиций. Накладные пересверены.`;
    return res;
  }
  const date=receiveMetadata(parsed,"date");
  const supplier=receiveMetadata(parsed,"supplier");
  const number=receiveMetadata(parsed,"number");
  const buyer=parsed.buyer||receiveMetadata(parsed,"buyer");
  const deliveryAddress=parsed.deliveryAddress||receiveMetadata(parsed,"deliveryAddress");
  const total=rows.reduce((sum,row)=>sum+cents(row.sum),0);
  if(!Number.isSafeInteger(total))throw new Error("Сумма накладной слишком велика для точного расчёта.");
  const declared=totals.at(-1);
  if(totals.length&&(!Number.isFinite(declared)||Math.abs(total-cents(declared))>1)){
    throw new Error(`Итог файла не сходится с суммой строк (${exactMoney(total/100)}). Проверьте скидки, НДС и полноту выгрузки.`);
  }
  const rowSignature=items=>JSON.stringify(items.map(row=>JSON.stringify([receiveKey(row.pos),receiveUnit(row.unit),num(row.qty),num(row.price),cents(num(row.sum))])).sort());
  const signature=number?"":rowSignature(rows);
  const supplierKey=value=>receiveKey(value).replace(/^(?:ооо|ип|ао)\s+/,"").replace(/[«»“”„"]/g,"").trim();
  const duplicate=S.data.invoices.some(inv=>(parsed.supplierInn&&inv.supplierInn?parsed.supplierInn===inv.supplierInn:supplierKey(inv.supplier)===supplierKey(supplier))&&inv.date===date
    &&(number||inv.number?receiveKey(number)===receiveKey(inv.number):signature===rowSignature(inv.rows)));
  if(duplicate)throw new Error("Такая накладная уже есть в реестре. Проверьте дату, номер и поставщика.");
  const invoice={id:uid(),supplierInn:parsed.supplierInn||"",src:"receiving.invoice",date,supplier,sum:total/100,rows,status:"получена",number,filename:file.name,
    ...(buyer?{buyer}:{}),
    ...(deliveryAddress?{deliveryAddress}:{}),
    ...(parsed.taxBasis?{taxBasis:parsed.taxBasis}:{}),...(parsed.sourceDocumentId?{sourceDocumentId:parsed.sourceDocumentId}:{}),
    ...(parsed.taxBasis==="gross"&&Number.isFinite(declared)&&cents(declared)===total&&!rows.some(r=>r.calculatedSum)?{totalVerified:true}:{})};
  S.data.invoices=S.data.invoices.concat(invoice);
  let automaticReceipt=false;
  if(S.venue.autoReceipt!==false&&!isDemo()){
    try{
      if(!invoice.totalVerified)
        throw new Error("Для автоматического прихода требуется сверенный итог и суммы строк с НДС.");
      const prepared=prepareReceipt(invoice,true);
      recordReceipt(invoice,prepared,true);automaticReceipt=true;
    }catch(error){
      if(parsed.automaticOnly)throw error;
      invoice.autoReceiptIssue=error.message;
    }
  }else if(parsed.automaticOnly)throw new Error("Автоматический приход отключён.");
  const checks=invoiceChecks();
  refreshReceivingFindings(checks);
  res.period=date?ruDate(date):"";
  res.summary=`В реестре сохранено ${rows.length} строк на ${exactMoney(invoice.sum)}.${automaticReceipt?" Приход автоматически отражён на складе DashBar.":""}`;
  res.automaticReceipt=automaticReceipt;

  return res;
}
/* ---------- Применение документа ---------- */
function applyDoc(sec,docKey,parsed){
  const src=sec+"."+docKey;
  const res={doc_type:parsed.title,period:parsed.date?ruDate(parsed.date):"",fits:true,fits_comment:"",summary:"",findings:[],missing:[]};
  const F=[];
  if(parsed.type==="inventory"){
    const date=parsed.date||todayISO();
    if(date>todayISO())throw new Error("Дата инвентаризации не может быть в будущем.");
    const rows=parsed.rows.filter(r=>r.fact!==""&&!itemTotal(r.pos))
      .map(r=>({pos:r.pos,unit:r.unit||S.data.stock[r.pos]?.unit||"",book:readNumber(r.book),fact:readNumber(r.fact),sourceLine:r.sourceLine}));
    const invalid=rows.find(r=>!r.pos||!Number.isFinite(r.book)||!Number.isFinite(r.fact)||r.fact<0);
    if(invalid)throw new Error(`Проверьте учёт и факт в строке «${invalid.pos||"без названия"}».`);
    if(!rows.length)throw new Error("В ведомости нет строк с учётным и фактическим остатком.");
    let short=0,over=0,unpriced=0;
    const prices=matrixByPosition();
    rows.forEach(r=>{
      r.diff=r.fact-r.book;
      const p=inventoryPrice(r,prices);
      r.sum=r.diff*p;
      if(r.diff&&!p)unpriced++;
      if(r.diff<0)short+=Math.abs(r.sum); else over+=r.sum;
    });
    rows.sort((a,b)=>Math.abs(b.sum)-Math.abs(a.sum));
    rows.filter(r=>r.diff!==0).slice(0,6).forEach(r=>{
      const val=(r.diff<0?"−":"+")+fmt(Math.abs(r.diff))+(r.unit?" "+r.unit:"");
      F.push({title:`${r.pos}: ${r.diff<0?"недостача":"излишек"} ${fmt(Math.abs(r.diff))}${r.unit?" "+r.unit:""}`,
        detail:`По учёту ${fmt(r.book)}, по факту ${fmt(r.fact)}.${r.sum?` В деньгах ${money(Math.abs(r.sum))}.`:""}`,
        solution:r.diff<0?"Проверить техкарты и последнюю приёмку по этой позиции.":"Проверить, не списан ли товар не с той позиции.",
        value:val});
    });
    const totals={short,over,unpriced};
    if(possibleResort(totals)){
      F.unshift({title:"Возможная пересортица",detail:`Недостачи ${money(short)}, излишки ${money(over)}: суммы почти равны. Возможная причина — списание с другой позиции. Проверьте по документам.`,solution:"Сверять группы суммой, а не по вкусам.",value:"пересортица",n:1});
    }
    S.data.counts=S.data.counts.filter(c=>c.src!==src);
    S.data.counts.unshift({id:uid(),src,date,rows,...totals});
    S.data.counts.sort((a,b)=>b.date.localeCompare(a.date));
    res.summary=`Инвентаризация от ${ruDate(date)}: ${rows.length} позиций · ${inventoryTotals(totals)}.`;
  }

  else if(parsed.type==="stock"){
    const rows=parsed.rows.filter(r=>r.pos&&!itemTotal(r.pos));
    if(!rows.length||rows.some(r=>!Number.isFinite(readNumber(r.qty))))throw new Error("Проверьте значения в колонке остатка.");
    if(docKey==="egais"){
      S.data.egais=Object.fromEntries(rows.map(r=>[r.pos,{qty:readNumber(r.qty),unit:r.unit}]));
      res.summary=`Остатки ЕГАИС: ${rows.length} позиций. Складские остатки хранятся отдельно.`;
      return res;
    }
    if(parsed.date>todayISO())throw new Error("Дата остатков не может быть в будущем.");
    const previous=S.sec.stock.docs.rest?.res?.snapshot?.date;
    if(previous&&(!parsed.date||parsed.date<previous))
      throw new Error("Укажите дату, равную или более позднюю, чем сохранённый остаток.");
    if(!parsed.date&&S.data.receipts.length)
      throw new Error("Для обновления склада с приходами файл должен содержать дату снимка.");
    const stock=parsed.date?{}:{...S.data.stock};
    for(const r of rows)Object.defineProperty(stock,r.pos,{enumerable:true,configurable:true,writable:true,
      value:{qty:readNumber(r.qty),unit:r.unit||S.data.stock[r.pos]?.unit||""}});
    S.data.stock=stock;
    if(parsed.date){
      res.snapshot={date:parsed.date,warehouse:S.venue.stockName.trim()||"Бар"};
      S.data.stockReference={snapshot:res.snapshot,stock:{...stock}};
    }
    res.summary=`Остатки: ${rows.length} позиций.`;
    const low=rows.filter(r=>num(r.qty)<=0);
    if(low.length)F.push({title:`Нулевой остаток: ${low.length} позиций`,detail:low.slice(0,5).map(r=>r.pos).join(", "),solution:"Проверить и добавить в заказ.",value:String(low.length)});
  }
  else if(parsed.type==="sales"){
    const rows=parsed.rows.filter(r=>r.pos&&!itemTotal(r.pos)).map(r=>{
      const qty=readNumber(r.qty), sum=readNumber(r.sum);
      return {pos:r.pos,qty:num(qty),sum:Number.isFinite(sum)?sum:num(qty)*num(r.price),
        category:r.category||"",unit:r.unit||"",qtyKnown:Number.isFinite(qty),src};
    });
    if(!rows.length)throw new Error("В файле нет строк продаж.");
    S.data.sales=S.data.sales.filter(r=>r.src!==src).concat(rows);
    const total=rows.reduce((a,r)=>a+(r.sum||0),0);
    res.usagePeriod=salesPeriod(parsed.metadata);
    res.summary=`Продажи: ${rows.length} позиций на ${money(total)}.`;
  }
  else if(parsed.type==="writeoff"){
    const rows=parsed.rows.map(r=>({reason:r.reason||r.pos||"списание",sum:num(r.sum),src})).filter(r=>r.reason);
    S.data.writeoffs=S.data.writeoffs.filter(r=>r.src!==src).concat(rows);
    res.summary=`Списания: ${rows.length} строк на ${money(rows.reduce((a,r)=>a+(r.sum||0),0))}.`;
  }
  else if(parsed.type==="ttk"){
    const rows=parsed.rows;
    S.data.ttk=S.data.ttk.filter(x=>x.src!==src).concat([{src,name:parsed.rows[0]?.pos||"Техкарта",rows}]);
    const noOut=rows.filter(r=>!num(r.out)).length;
    res.summary=`Техкарта: ${rows.length} строк.`;
    if(noOut)F.push({title:"В карте нет выхода",detail:`Строк без выхода: ${noOut}. Сверить с учётной системой нельзя.`,solution:"Дописать выход замеса и порцию.",value:"нет выхода",n:1});
  }
  else {
    res.fits=false;
    res.missing.push("Не удалось определить тип. Нужны колонки: позиция, количество, цена или учёт/факт.");
    res.summary="Файл прочитан, но структура не распознана.";
  }
  res.findings=F.slice(0,8);
  S.findings=S.findings.filter(f=>f.src!==src);
  res.findings.forEach((f,i)=>S.findings.push({id:src+"."+i,src,sec,title:f.title,detail:f.detail,solution:f.solution,value:f.value||"",req:f.req,n:f.n}));
  return res;
}
/* ---------- Обработка файла ---------- */
async function handleFile(sec,doc,file){
  if(!EXPECT[doc]||!S.sec[sec]||isDemo())return;
  const key=sec+"."+doc;
  if(busy[key])return;
  const state=S, mode=S.mode;
  busy[key]=file.name;render(true);
  try{
    const receiving=sec==="receiving";
    const r=await readFile(file,receiving,doc);
    if(S!==state||S.mode!==mode)return;
    const registry=receiving&&doc==="invoice"?parseDocsInboxRegistry(r):null;
    if(registry){sheet={t:"docsinboxPreview",rows:registry};return "docsinboxRegistry";}
    const preview=workbookPreview(doc,r);
    if(preview){sheet={t:"workbook",...preview,file:file.name,selected:0};return "preview";}
    const parsed=r.rows.length?parseDoc(r.rows,doc):null;
    if(parsed&&parsed.type!=="unknown"){
      if(!EXPECT[doc].includes(parsed.type)){
        throw new Error(`Распознан другой тип документа: «${parsed.title}». Выберите подходящую загрузку.`);
      }
      if(r.part)throw new Error("Прочитана только часть PDF. Загрузите полную таблицу в Excel или CSV.");
      if(receiving)commitReceiving(()=>{
        const res=applyReceiving(doc,parsed,file);
        S.sec.receiving.docs={...S.sec.receiving.docs,[doc]:{name:file.name,res,local:true}};
      });
      else commitOperationalData(sec,()=>{
        const res=applyDoc(sec,doc,parsed);
        S.sec[sec].docs[doc]={name:file.name,res,local:true};
      });
      toast("Разобрано на устройстве");
      return true;
    }
    if(!receiving&&sampleFn&&(r.text||r.images.length)&&!/\.(csv|tsv|xlsx|xls)$/i.test(file.name)){
      const res=await aiParse(sec,doc,file,r,state);
      if(S===state)S.sec[sec].docs[doc]={name:file.name,res,local:false,part:r.part};
      return;
    }
    if(receiving&&doc==="invoice"&&/\.pdf$/i.test(file.name)&&!r.text.trim())return "scan";
    if(r.images.length&&!r.text.trim())throw new Error("Для фото и сканов нужен подключённый ИИ. Загрузите таблицу или PDF с текстом.");
    throw new Error(receiving
      ?(doc==="invoice"?"Нужна таблица с колонками «Позиция», «Количество», «Цена».":"Нужна таблица с колонками «Позиция», «Цена», «Единица», «Поставщик».")
      :"Проверьте заголовки колонок по подсказке к документу.");
  }catch(e){
    if(S===state)S.sec[sec].docs[doc]={...S.sec[sec].docs[doc],errName:file.name,err:e?.message||"Не удалось прочитать файл."};
  }finally{
    delete busy[key];render(true);
  }
}
async function aiParse(sec,doc,file,r,state){
  const d=docsFor(sec).find(x=>x[0]===doc)||["","Документ","",""];
  const prompt=`Ты модуль разбора документов приложения DashBar для барменеджера. Учитывается только бар.
Раздел: ${SEC[sec]?SEC[sec].title:sec}. Ожидаемый документ: «${d[1]}» (${d[2]}).
Контекст:\n${ctx()}
Определи тип документа, подходит ли он, найди ошибки и отклонения, к каждой предложи решение. Не выдумывай цифры.
Ответь строго одним JSON:
{"doc_type":"тип","period":"период или дата","fits":true,"fits_comment":"если не подходит","summary":"1-2 предложения","findings":[{"title":"до 60 знаков","detail":"что не так, с цифрами","solution":"что сделать","value":"короткая цифра"}],"missing":["чего не хватает"]}
Не больше 8 находок.
${r.text?"Содержимое файла «"+file.name+"»:\n"+r.text:"Файл «"+file.name+"» приложен изображением."}`;
  const out=await sampleFn(prompt,r.images.length?{images:r.images,cache:false}:{cache:false});
  const t=out.text||"",a=t.indexOf("{"),b=t.lastIndexOf("}");let res;
  try{res=JSON.parse(t.slice(a,b+1));}catch(e){res={doc_type:"Документ",summary:t.slice(0,600),findings:[],missing:[]};}
  if(S!==state||res.fits===false)return res;
  S.findings=S.findings.filter(f=>f.src!==sec+"."+doc);
  (res.findings||[]).forEach((f,i)=>S.findings.push({id:sec+"."+doc+"."+i,src:sec+"."+doc,sec,title:String(f.title||"Находка"),detail:String(f.detail||""),solution:String(f.solution||""),value:f.value?String(f.value):""}));
  return res;
}
/* ================= Чат ================= */

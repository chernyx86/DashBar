"use strict";
/* ================= Запуск ================= */
(function(){
  const h=(location.hash||"").slice(1);
  if(S.step==="app"&&Object.hasOwn(VIEW,h))S.tab=h;
})();
window.addEventListener("hashchange",()=>{
  const h=location.hash.slice(1);
  if(S.step==="app"&&Object.hasOwn(VIEW,h)&&h!==S.tab){
    S.tab=h;render();
  }
});
render();
if(window.claude&&window.claude.use){
  window.claude.use("sample").then(s=>{sampleFn=s||false;if(S.tab==="ai"&&S.step==="app")render(true);},()=>{sampleFn=false;});
} else sampleFn=false;

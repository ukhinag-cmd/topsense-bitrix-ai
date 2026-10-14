"use strict";
// TOP-SENSE: read-only change monitor. No writes to Bitrix24 or paid AI.
// Baseline is the timestamp of the last completed archival CRM snapshot.
// Created-since-baseline records are identifiable after any Render restart.
const BASELINE="2026-10-09T01:37:18+03:00";
const MAX_ROWS=10000;
const state={status:"not_started",updatedAt:null,startedAt:null,error:null,loading:false,
 companies:new Map(),contacts:new Map(),updatedCompanies:new Map(),updatedContacts:new Map(),
 scannedCompanies:0,scannedContacts:0,firstSeenAt:null};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ms=v=>{const n=Date.parse(String(v||""));return Number.isFinite(n)?n:0};
const safe=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const clean=v=>String(v??"").trim().slice(0,220);
async function bitrixList(method,filter,select){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("CRM read-only endpoint not configured");
 const url=new URL(method+".json",base.endsWith("/")?base:base+"/");
 async function page(start){
  for(let a=0;a<2;a++){
   try{
    const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
     body:JSON.stringify({order:{ID:"ASC"},filter,select,start}),
     signal:AbortSignal.timeout(22000)});
    const json=await res.json();
    if(!res.ok||json.error||!Array.isArray(json.result))
     throw Error("Bitrix read failure: "+String(json.error||res.status));
    return json;
   }catch(e){if(a)throw e;await sleep(750)}
  }
 }
 const first=await page(0),rows=[...first.result],size=Math.max(1,first.result.length),
  total=Number(first.total??first.result.length);
 if(total>MAX_ROWS)throw Error("Change monitor safety bound exceeded");
 if(total>size){
  for(let from=size;from<total;from+=size*3){
   const starts=[from,from+size,from+size*2].filter(x=>x<total);
   const pages=await Promise.all(starts.map(page));
   for(const p of pages)rows.push(...p.result);
  }
 }else if(first.next!=null){
  let cursor=first.next,n=0;
  while(cursor!=null&&n++<MAX_ROWS/size+3){
   const p=await page(cursor);rows.push(...p.result);cursor=p.next;
  }
  if(cursor!=null)throw Error("Incomplete Bitrix pagination");
 }
 const found=new Map(rows.filter(x=>x&&x.ID).map(x=>[String(x.ID),x]));
 if(found.size<total)throw Error("Incomplete Bitrix change snapshot "+found.size+"/"+total);
 return [...found.values()];
}
function companyRecord(c){
 const id=String(c.ID||"");
 return {id,name:clean(c.TITLE),createdAt:clean(c.DATE_CREATE),modifiedAt:clean(c.DATE_MODIFY),
  assignedById:clean(c.ASSIGNED_BY_ID),website:clean((Array.isArray(c.WEB)?c.WEB[0]?.VALUE:c.WEB)||""),
  url:"https://topsense.bitrix24.ru/crm/company/details/"+encodeURIComponent(id)+"/"};
}
function contactRecord(c){
 const id=String(c.ID||""),companyId=String(c.COMPANY_ID||"");
 return {id,name:clean([c.NAME,c.SECOND_NAME,c.LAST_NAME].filter(Boolean).join(" ")),
  createdAt:clean(c.DATE_CREATE),modifiedAt:clean(c.DATE_MODIFY),
  companyId:companyId!=="0"?companyId:"",assignedById:clean(c.ASSIGNED_BY_ID),
  title:clean(c.POST),url:"https://topsense.bitrix24.ru/crm/contact/details/"+encodeURIComponent(id)+"/"};
}
async function refresh(){
 if(state.loading||!process.env.BITRIX_WEBHOOK_BASE)return;
 state.loading=true;state.startedAt=new Date().toISOString();state.status=state.updatedAt?"refreshing":"starting";
 try{
  const entitySpecs=[
   ["crm.company.list",["ID","TITLE","DATE_CREATE","DATE_MODIFY","ASSIGNED_BY_ID","WEB"],companyRecord],
   ["crm.contact.list",["ID","NAME","SECOND_NAME","LAST_NAME","POST","COMPANY_ID","DATE_CREATE","DATE_MODIFY","ASSIGNED_BY_ID"],contactRecord]
  ];
  // Separate calls protect the previous complete snapshot if either source fails.
  const [companies,contacts]=await Promise.all(entitySpecs.map(async ([method,fields,transform])=>{
   const rows=await bitrixList(method,{">=DATE_CREATE":BASELINE},fields);
   return rows.map(transform).filter(x=>ms(x.createdAt)>=ms(BASELINE));
  }));
  const since=state.updatedAt?new Date(Math.max(ms(BASELINE),ms(state.updatedAt)-20*60*1000)).toISOString():BASELINE;
  // Modifications of pre-existing companies and contacts are also tracked.
  // On first startup, scan modifications only from the baseline. Future
  // passes use a bounded overlap; the old analytics record is not re-searched.
  const [modCompanies,modContacts]=await Promise.all(entitySpecs.map(async ([method,fields,transform])=>{
   const rows=await bitrixList(method,{">=DATE_MODIFY":since},fields);
   return rows.map(transform).filter(x=>ms(x.modifiedAt)>=ms(since)&&ms(x.createdAt)<ms(BASELINE));
  }));
  state.companies=new Map(companies.map(x=>[x.id,x]));
  state.contacts=new Map(contacts.map(x=>[x.id,x]));
  for(const c of modCompanies)state.updatedCompanies.set(c.id,c);
  for(const c of modContacts)state.updatedContacts.set(c.id,c);
  state.scannedCompanies=companies.length;state.scannedContacts=contacts.length;
  state.updatedAt=new Date().toISOString();
  if(!state.firstSeenAt)state.firstSeenAt=state.updatedAt;
  state.status="ready";state.error=null;
  console.log(JSON.stringify({component:"topsense-crm-changes",event:"sync-ok",createdCompanies:companies.length,
   createdContacts:contacts.length,modifiedCompanies:modCompanies.length,modifiedContacts:modContacts.length,
   unlinkedNewContacts:contacts.filter(c=>!c.companyId).length}));
 }catch(e){
  state.status=state.updatedAt?"stale":"error";
  state.error=String(e.message||e).slice(0,150);
  console.warn(JSON.stringify({component:"topsense-crm-changes",event:"sync-error",reason:state.error}));
 }finally{state.loading=false}
}
function snapshot(){
 const companies=[...state.companies.values()].sort((a,b)=>ms(b.createdAt)-ms(a.createdAt));
 const contacts=[...state.contacts.values()].sort((a,b)=>ms(b.createdAt)-ms(a.createdAt));
 return {status:state.status,baseline:BASELINE,updatedAt:state.updatedAt,error:state.error,
  newCompanies:companies.length,newContacts:contacts.length,
  newContactsWithoutCompany:contacts.filter(c=>!c.companyId).length,
  changedOlderCompanies:state.updatedCompanies.size,changedOlderContacts:state.updatedContacts.size,
  companies,contacts};
}
function html(){
 const s=snapshot();const n=v=>Number(v||0).toLocaleString("ru-RU");
 const cards=(rows,kind)=>rows.slice(0,100).map(x=>
  '<article class="entry"><div class="top"><b>'+safe(x.name||"Без названия")+'</b><span>CRM '+safe(x.id)+'</span></div>'+
  '<div class="meta">'+safe(x.createdAt)+' · Ответственный #'+safe(x.assignedById||"—")+'</div>'+
  (kind==="contact"?'<div class="meta">'+(x.companyId?"CRM-компания #"+safe(x.companyId):"Без привязки к CRM-компании")+'</div>':
  (x.website?'<div class="meta">Сайт указан в CRM</div>':""))+
  '<a href="'+safe(x.url)+'" target="_blank" rel="noopener noreferrer">Открыть в Битрикс24 ↗</a></article>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180"><title>ТОП-СЕНС — новые компании и контакты</title><style>'+
 'body{margin:0;font:14px system-ui;background:#f0f5f8;color:#193d4c}*{box-sizing:border-box}header{padding:25px max(20px,calc((100% - 1200px)/2));background:#123b51;color:white}h1{margin:0;font-size:25px}header p{color:#c2d8e4}main{max-width:1200px;margin:auto;padding:20px}.nav{display:flex;gap:18px;margin-bottom:15px}.nav a{color:#166a7b}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.metric,.panel,.entry{background:white;border:1px solid #dfeaf0;border-radius:13px;padding:17px}.metric strong{font-size:31px;display:block;color:#177589}.metric span{color:#637f8e;font-size:12px}.panel{margin-top:15px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:9px}.entry{padding:13px}.top{display:flex;justify-content:space-between;gap:10px}.top span{white-space:nowrap;font-size:11px;color:#78919c}.meta{font-size:12px;color:#68818e;margin-top:8px}.entry a{display:block;color:#11758c;margin-top:10px}.note{font-size:12px;line-height:1.6;color:#657e8d}.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:800px){.panels{grid-template-columns:1fr}}</style></head><body>'+
 '<header><h1>Новые компании и контакты</h1><p>ТОП-СЕНС · прямое чтение Bitrix24, без повторного интернет-поиска по старой базе</p></header>'+
 '<main><nav class="nav"><a href="/contractors">Главный дашборд</a><a href="/contractors/quality">Качество данных</a></nav>'+
 '<div class="note">После контрольного снимка '+safe(s.baseline)+' · проверено '+safe(s.updatedAt||"не завершено")+' · '+safe(s.status)+(s.error?" · "+safe(s.error):"")+'</div>'+
 '<div class="metrics">'+[
 ["Новых компаний",s.newCompanies],["Новых контактов",s.newContacts],
 ["Контактов без компании",s.newContactsWithoutCompany],
 ["Изменённых старых компаний",s.changedOlderCompanies],
 ["Изменённых старых контактов",s.changedOlderContacts]
 ].map(([label,value])=>'<div class="metric"><strong>'+n(value)+'</strong><span>'+safe(label)+'</span></div>').join("")+'</div>'+
 '<div class="panels"><section class="panel"><h2>Новые компании</h2><div class="cards">'+(cards(s.companies,"company")||"Пока нет данных")+'</div></section>'+
 '<section class="panel"><h2>Новые контакты</h2><div class="cards">'+(cards(s.contacts,"contact")||"Пока нет данных")+'</div></section></div>'+
 '<p class="note">Только доказанные CRM-связи. Новый контакт без COMPANY_ID не прикрепляется к компании по домену или совпадению имени. Появление новой сделки не меняет уже установленную сферу деятельности компании.</p></main></body></html>';
}
module.exports={refresh,snapshot,html,bitrixList};

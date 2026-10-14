"use strict";
// Read-only Bitrix intake. No CRM writes and no external AI/web requests.
const FROM="2026-09-06T00:00:00+03:00",OCT=Date.parse("2026-10-01T00:00:00+03:00");
const state={status:"not_started",updatedAt:null,leadStatus:"not_started",dealStatus:"not_started",contactStatus:"not_started",errors:[],items:[],stats:{}};
let busy=false;
const sleep=n=>new Promise(r=>setTimeout(r,n));
const esc=x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const clean=x=>String(x??"").replace(/<[^>]*>|\[\/?p\]/gi," ").replace(/\s+/g," ").trim().slice(0,300);
function api(method){const base=String(process.env.BITRIX_WEBHOOK_BASE||"");if(!base)throw Error("CRM read key missing");return new URL(method+".json",base.endsWith("/")?base:base+"/");}
async function list(method,params){
 const endpoint=api(method);
 async function page(start){
  for(let attempt=0;attempt<2;attempt++){
   try{
    const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
     body:JSON.stringify({...params,start}),signal:AbortSignal.timeout(22000)});
    const j=await r.json();
    if(!r.ok||j.error||!Array.isArray(j.result))throw Error("CRM list unavailable");
    return j;
   }catch(e){if(attempt)throw e;await sleep(950)}
  }
 }
 const first=await page(0),all=[...first.result],size=Math.max(1,first.result.length),total=Number(first.total??all.length);
 if(total>30000)throw Error("CRM list size limit");
 if(total>size){
  for(let i=size;i<total;i+=2*size){
   const group=await Promise.all([i,i+size].filter(n=>n<total).map(page));
   group.forEach(x=>all.push(...x.result));
   if(i%(size*20)===0)await sleep(130);
  }
 }else if(first.next!=null){
  let n=0,next=first.next;
  while(next!=null&&n++<800){const x=await page(next);all.push(...x.result);next=x.next}
  if(next!=null)throw Error("CRM pagination incomplete");
 }
 const uniq=new Map(all.filter(x=>x&&x.ID).map(x=>[String(x.ID),x]));
 if(uniq.size<total)throw Error("Incomplete CRM intake scan");
 return [...uniq.values()];
}
async function contactIndex(items){
 const ids=[...new Set(items.filter(x=>!x.COMPANY_ID||String(x.COMPANY_ID)==="0").map(x=>String(x.CONTACT_ID||"")).filter(x=>/^[1-9]\d*$/.test(x)))];
 const found=new Map();
 for(let i=0;i<ids.length;i+=40){
  const rows=await list("crm.contact.list",{order:{ID:"ASC"},filter:{"@ID":ids.slice(i,i+40)},select:["ID","COMPANY_ID"]});
  for(const x of rows)found.set(String(x.ID),String(x.COMPANY_ID||""));
  if(i%400===0)await sleep(150);
 }
 return found;
}
function technical(x){return /undeliverable|delivery status notification|mail delivery failed|ошибка доставки|сбой доставки|рассылка|подписка|спам|отчёт о доставке|security alert|password reset/i.test(String(x||""));}
function record(x,kind,known,contactMap){
 const cid=String(x.COMPANY_ID||""),pid=String(x.CONTACT_ID||"");
 const direct=known.has(cid),indirect=!direct&&known.has(contactMap.get(pid));
 return {id:String(x.ID),kind,title:clean(x.TITLE),created:String(x.DATE_CREATE||""),modified:String(x.DATE_MODIFY||""),
  companyId:direct?cid:indirect?contactMap.get(pid):"",link:direct?"CRM company":indirect?"CRM contact":"unlinked",
  companyCandidate:kind==="lead"?clean(x.COMPANY_TITLE):"",owner:String(x.ASSIGNED_BY_ID||""),
  stage:String((kind==="lead"?x.STATUS_ID:x.STAGE_ID)||""),source:String(x.SOURCE_ID||""),
  technical:technical(x.TITLE),url:"https://topsense.bitrix24.ru/crm/"+kind+"/details/"+encodeURIComponent(String(x.ID))+"/"};
}
function summarize(items){
 const n={total:items.length,leads:0,deals:0,october:0,unlinked:0,viaContact:0,direct:0,technical:0,byDay:{},byStage:{},byOwner:{}};
 for(const x of items){
  n[x.kind==="lead"?"leads":"deals"]++;
  if(Date.parse(x.created)>=OCT)n.october++;
  if(x.link==="unlinked")n.unlinked++;else if(x.link==="CRM contact")n.viaContact++;else n.direct++;
  if(x.technical)n.technical++;
  const day=x.created.slice(0,10);n.byDay[day]=(n.byDay[day]||0)+1;
  const k=x.kind+":"+x.stage;n.byStage[k]=(n.byStage[k]||0)+1;
  n.byOwner[x.owner]=(n.byOwner[x.owner]||0)+1;
 }
 return n;
}
async function refresh(companySource){
 if(busy||!process.env.BITRIX_WEBHOOK_BASE)return;
 busy=true;
 try{
  const known=new Set((typeof companySource==="function"?companySource():companySource||[]).map(x=>String(typeof x==="object"?x.id:x)));
  const filter={">=DATE_CREATE":FROM};
  const results=await Promise.allSettled([
   list("crm.lead.list",{order:{ID:"ASC"},filter,select:["ID","TITLE","DATE_CREATE","DATE_MODIFY","COMPANY_TITLE","COMPANY_ID","CONTACT_ID","STATUS_ID","SOURCE_ID","ASSIGNED_BY_ID"]}),
   list("crm.deal.list",{order:{ID:"ASC"},filter,select:["ID","TITLE","DATE_CREATE","DATE_MODIFY","COMPANY_ID","CONTACT_ID","STAGE_ID","SOURCE_ID","ASSIGNED_BY_ID"]})
  ]);
  const leads=results[0].status==="fulfilled"?results[0].value:null;
  const deals=results[1].status==="fulfilled"?results[1].value:null;
  state.leadStatus=leads?"complete":"unavailable";state.dealStatus=deals?"complete":"unavailable";
  if(!leads&&!deals)throw Error("Both CRM intake streams failed");
  const errors=[];
  if(!leads)errors.push("leads_unavailable");
  if(!deals)errors.push("deals_unavailable");
  let contacts=new Map();
  try{contacts=await contactIndex([...(leads||[]),...(deals||[])]);state.contactStatus="complete"}
  catch{errors.push("contact_links_unavailable");state.contactStatus="unavailable"}
  const items=[...(leads||[]).map(x=>record(x,"lead",known,contacts)),...(deals||[]).map(x=>record(x,"deal",known,contacts))]
   .filter(x=>Date.parse(x.created)>=Date.parse(FROM))
   .sort((a,b)=>Date.parse(b.created)-Date.parse(a.created));
  if(state.status==="ready"&&(!leads||!deals)&&items.length<state.items.length){
   state.status="stale";errors.push("previous_snapshot_retained");
  }else{state.items=items;state.stats=summarize(items);state.status=leads&&deals?"ready":"partial"}
  state.errors=errors;state.updatedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"topsense-intake",event:"audit-finished",status:state.status,from:FROM,
   leads:state.stats.leads,deals:state.stats.deals,unlinked:state.stats.unlinked,contactLinked:state.stats.viaContact,errors}));
 }catch(e){
  state.status=state.items.length?"stale":"error";state.errors=["intake_read_error"];
  console.warn(JSON.stringify({component:"topsense-intake",event:"audit-failed",status:state.status}));
 }finally{busy=false}
}
function snapshot(){return {status:state.status,updatedAt:state.updatedAt,leadStatus:state.leadStatus,
 dealStatus:state.dealStatus,contactStatus:state.contactStatus,errors:state.errors,stats:state.stats,items:state.items};}
const num=x=>Number(x||0).toLocaleString("ru-RU");
function html(){
 const state=snapshot(),d=state.stats||{},days=Object.entries(d.byDay||{}).sort((a,b)=>a[0].localeCompare(b[0])),peak=Math.max(1,...days.map(x=>x[1]));
 const stats=[["Лиды",d.leads],["Сделки",d.deals],["Всего с 6 сентября",d.total],["С 1 октября",d.october],
  ["Без установленной компании",d.unlinked],["Связь через контакт",d.viaContact],["Возможные служебные",d.technical]]
  .map(([label,n])=>'<div class="tile"><b>'+num(n)+'</b><span>'+esc(label)+'</span></div>').join("");
 const chart=days.map(([day,n])=>'<div class="bar" title="'+esc(day)+': '+num(n)+'"><div style="height:'+Math.max(3,140*n/peak)+'px"></div><small>'+esc(day.slice(5))+'</small></div>').join("");
 const cards=state.items.slice(0,250).map(x=>'<div class="entry"><b>'+esc(x.title||"Без темы")+'</b><p>'+esc(x.kind==="lead"?"Лид":"Сделка")+' №'+esc(x.id)+' · '+esc(x.created)+'</p>'+
  '<p>Ответственный CRM #'+esc(x.owner||"—")+' · стадия '+esc(x.stage||"—")+'</p>'+
  '<p>Компания: '+esc(x.companyId?"CRM #"+x.companyId:x.companyCandidate||"не установлена")+
  ' · '+esc(x.link)+(x.technical?' · Возможно служебное письмо':"")+'</p>'+
  '<a href="'+esc(x.url)+'" target="_blank" rel="noopener noreferrer">Открыть в Bitrix24 ↗</a></div>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta http-equiv="refresh" content="180"><title>ТОП-СЕНС · Входящие заявки</title><style>'+
 'body{font:14px system-ui;color:#183847;background:#f1f5f8;margin:0}header{background:#103c55;color:white;padding:25px}header h1{margin:0}header p{color:#bfd9e4}main{max-width:1250px;margin:auto;padding:20px}a{color:#11718a}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}.tile,section,.entry{background:white;border:1px solid #d8e5ec;border-radius:12px;padding:15px}.tile b{display:block;font-size:27px;color:#146b85}.tile span,.entry p,.note{font-size:12px;color:#69818b}section{margin-top:15px}.timeline{display:flex;align-items:flex-end;gap:6px;overflow:auto;height:175px}.bar{min-width:22px;text-align:center;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;font-size:9px;color:#778b96}.bar div{background:#2b93ab;border-radius:5px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}.entry b{font-size:13px}h2{font-size:19px}</style></head><body><header><h1>Входящие лиды и заявки</h1><p>Историческая проверка с 6 сентября 2026 года · Только чтение Bitrix24</p></header><main>'+
 '<p><a href="/contractors">← База клиентов</a> · <a href="/contractors/quality">Качество</a></p>'+
 '<p class="note">Проверено: '+esc(state.updatedAt||"ожидаем")+' · статус: '+esc(state.status)+
 ' · лиды: '+esc(state.leadStatus)+' · сделки: '+esc(state.dealStatus)+' · '+esc(state.errors.join(", "))+'</p>'+
 '<div class="stats">'+stats+'</div><section><h2>Поступления по дням</h2><div class="timeline">'+chart+'</div></section>'+
 '<section><h2>Последние обращения</h2><p class="note">Показаны последние 250. Заявки без доказанной связи с компанией не объединяются по совпадению названий.</p>'+
 '<div class="cards">'+(cards||"<p>Загрузка данных CRM</p>")+'</div></section></main></body></html>';
}
module.exports={refresh,snapshot,html,summarize,record,technical};

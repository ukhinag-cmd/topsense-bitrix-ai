"use strict";
// Source-of-truth intake for recent Bitrix deals and the inbound email
// activities attached to them. Read-only, no paid model calls, no CRM writes.
// Never infer a legal identity or a verified website from a sender alone.
const mail=require("./company-email-domains");
const state={status:"not_started",attempted:0,inspected:0,errors:0,withEmail:0,
 withAttachments:0,withNeeds:0,updatedAt:null,lastError:"",queued:0};
const queue=[],pending=new Set(),visited=new Set(),profiles=new Map();
let working=false,nextBatchTimer=null;
function scheduleNextBatch(){
 if(nextBatchTimer||working||!queue.length)return;
 nextBatchTimer=setTimeout(()=>{
  nextBatchTimer=null;
  if(queue.length&&!working)void pump();
 },250);
 if(typeof nextBatchTimer?.unref==="function")nextBatchTimer.unref();
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const text=v=>String(v??"").trim();
const value=v=>Array.isArray(v)?v.map(value).filter(Boolean).join("; "):v&&typeof v==="object"?text(v.VALUE||v.value||""):text(v);
const gases=[
 ["H2S",/\bH2S\b|\bH₂S\b|сероводород/iu],
 ["CH4",/\bCH4\b|\bCH₄\b|метан/iu],
 ["CO2",/\bCO2\b|\bCO₂\b|углекисл(?:ый|ого) газ/iu],
 ["O2",/\bO2\b|\bO₂\b|кислород/iu],
 ["CO",/\bCO\b|угарн(?:ый|ого) газ/iu],
 ["NH3",/\bNH3\b|\bNH₃\b|аммиак/iu],
 ["NO2",/\bNO2\b|\bNO₂\b|диоксид азота/iu],
 ["SO2",/\bSO2\b|\bSO₂\b|диоксид серы/iu],
 ["H2",/\bH2\b|\bH₂\b|водород/iu]
];
function signals(raw){
 const s=text(raw).slice(0,18000);
 return {gases:gases.filter(([,p])=>p.test(s)).map(([k])=>k),
  portable:/переносн|портатив|личн(?:ый|ого) газоанализатор/iu.test(s),
  fixed:/стационар|фиксированн|газосигнализац|систем[аы] газов[оы]/iu.test(s),
  service:/поверк|ремонт|калибровк|настройк|обслуживан|техобслуживан/iu.test(s),
  tender:/тендер|закупк|конкурс|запрос цен|коммерческ(?:ое|ого) предложен/iu.test(s)};
}
async function call(method,params){
 const root=text(process.env.BITRIX_WEBHOOK_BASE);
 if(!root)throw Error("CRM read-only connection not configured");
 const u=new URL(method+".json",root.endsWith("/")?root:root+"/");
 const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
  body:JSON.stringify(params),signal:AbortSignal.timeout(18000)});
 const data=await r.json();
 if(!r.ok||data.error)throw Error("CRM "+method+" read failed");
 return data.result;
}
async function activities(id){
 const filter={BINDINGS:[{OWNER_TYPE_ID:2,OWNER_ID:Number(id)}]};
 const params={order:{ID:"DESC"},filter,
  select:["ID","TYPE_ID","DIRECTION","PROVIDER_ID","DESCRIPTION",
   "SUBJECT","COMMUNICATIONS","FILES","STORAGE_ELEMENT_IDS"],start:0};
 let data;
 try{data=await call("crm.activity.list",params)}
 catch{
  params.filter={OWNER_TYPE_ID:2,OWNER_ID:Number(id)};
  data=await call("crm.activity.list",params);
 }
 return (Array.isArray(data)?data:[]).slice(0,35);
}
function attachmentCount(a){
 const raw=[a?.FILES,a?.STORAGE_ELEMENT_IDS];
 return raw.reduce((n,x)=>n+(Array.isArray(x)?x.length:typeof x==="string"&&x.trim()?1:0),0);
}
async function inspect(deal){
 const id=text(deal.ID),base={id,companyId:text(deal.COMPANY_ID),
  contactId:text(deal.CONTACT_ID),ownerId:text(deal.ASSIGNED_BY_ID),
  createdAt:text(deal.DATE_CREATE),stageId:text(deal.STAGE_ID),
  categoryId:text(deal.CATEGORY_ID),title:text(deal.TITLE).slice(0,300),
  crmUrl:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(id)+"/"};
 const out={...base,status:"read_partial",activityCount:0,incomingEmails:0,
  attachmentCount:0,corporateDomains:[],evidenceSources:["deal_title"],
  signals:signals(base.title),needsHumanReview:true,
  checkedAt:new Date().toISOString()};
 try{
  const full=await call("crm.deal.get",{id:Number(id)});
  if(full&&typeof full==="object"){
   out.companyId=text(full.COMPANY_ID||base.companyId);
   out.contactId=text(full.CONTACT_ID||base.contactId);
   out.ownerId=text(full.ASSIGNED_BY_ID||base.ownerId);
   out.stageId=text(full.STAGE_ID||base.stageId);
   // The deal itself is primary. Salespeople may not have created or filled
   // the CRM company/contact at all.
   const description=[full.TITLE,full.COMMENTS,full.ADDITIONAL_INFO,
    ...Object.entries(full).filter(([k,v])=>/^UF_CRM_/i.test(k)&&
     typeof v==="string"&&v.length<2500).map(([,v])=>v)]
    .map(value).join(" ").slice(0,18000);
   out.signals=signals(description);
   out.corporateDomains=mail.extract(description);
   out.evidenceSources.push("deal_fields");
   out.status="deal_read";
  }
 }catch{out.evidenceSources.push("deal_fields_unavailable")}
 try{
  const rows=await activities(id);
  out.activityCount=rows.length;
  const inbound=rows.filter(x=>String(x.DIRECTION||"")==="1"&&
   (String(x.PROVIDER_ID||"").toUpperCase()==="CRM_EMAIL"||
    String(x.TYPE_ID||"")==="4"));
  out.incomingEmails=inbound.length;
  out.attachmentCount=rows.reduce((n,x)=>n+attachmentCount(x),0);
  const messages=inbound.map(x=>[x.SUBJECT,x.DESCRIPTION,
   (x.COMMUNICATIONS||[]).map(v=>value(v.VALUE||v)).join(" ")].join(" ")).join(" ").slice(0,22000);
  const more=signals(messages);
  out.signals={gases:[...new Set([...out.signals.gases,...more.gases])],
   portable:out.signals.portable||more.portable,
   fixed:out.signals.fixed||more.fixed,
   service:out.signals.service||more.service,
   tender:out.signals.tender||more.tender};
  out.corporateDomains=[...new Set([...out.corporateDomains,...mail.extract(messages)])].slice(0,8);
  if(inbound.length)out.evidenceSources.push("inbound_deal_email");
  if(out.attachmentCount)out.evidenceSources.push("deal_attachment_present");
  out.status=out.status==="deal_read"?"deal_and_activities_read":"activities_read";
 }catch{out.evidenceSources.push("deal_activities_unavailable")}
 // No original email bodies, files, full contact details or inferred company
 // names are logged or shared with external public AI services.
 return out;
}
function queueDeals(deals){
 const sorted=(deals||[]).filter(x=>x&&/^\d+$/.test(text(x.ID)))
  .sort((a,b)=>Date.parse(b.DATE_CREATE||0)-Date.parse(a.DATE_CREATE||0));
 let added=0;
 for(const d of sorted){
  const id=text(d.ID);
  if(visited.has(id)||pending.has(id))continue;
  if(queue.length>=200)break;
  pending.add(id);queue.push(d);added++;
 }
 state.queued=queue.length;
 if(queue.length&&!working)void pump();
 return added;
}
async function pump(){
 if(working)return;working=true;state.status="scanning";
 try{
  let cycle=0;
  while(queue.length&&cycle<18){
   const d=queue.shift(),id=text(d.ID);
   pending.delete(id);if(visited.has(id))continue;
   visited.add(id);state.attempted++;cycle++;
   try{
    const item=await inspect(d);
    profiles.set(id,item);state.inspected++;
    if(item.incomingEmails)state.withEmail++;
    if(item.attachmentCount)state.withAttachments++;
    if(item.signals.gases.length||item.signals.portable||item.signals.fixed||item.signals.service)state.withNeeds++;
   }catch{state.errors++}
   await sleep(250);
  }
  state.updatedAt=new Date().toISOString();
  state.queued=queue.length;
  state.status=queue.length?"partial":"ready";
  console.log(JSON.stringify({component:"deal-intake",event:"read-only-progress",
   attempted:state.attempted,inspected:state.inspected,pending:queue.length,
   withEmail:state.withEmail,withAttachments:state.withAttachments,
   withNeeds:state.withNeeds,errors:state.errors}));
  }finally{
  working=false;
  // The previous implementation processed one group of 18 then stopped
  // despite having unprocessed deals waiting.
  scheduleNextBatch();
 }
}
function get(id){return profiles.get(text(id))||null}
function forCompany(id){
 return [...profiles.values()].filter(x=>x.companyId&&x.companyId===text(id))
  .sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)).slice(0,15);
}
function stats(){return {...state}}
module.exports={queueDeals,get,forCompany,stats,signals};

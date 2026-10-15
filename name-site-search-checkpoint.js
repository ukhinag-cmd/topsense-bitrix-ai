"use strict";
// Durable negative website-search research per CRM company. Saved in the
// existing PRIVATE analytical store; never Bitrix24, never paid AI.
// A new phone, INN or algorithm version invalidates old negative results.
const crypto=require("crypto");
const PREFIX="site-profile:v1:910000000000";
const VERSION=2,TTL_MS=14*24*60*60*1000;
const known=new Map(),pending=new Map();
let timer=null,writing=false,restored=0,stored=0,errors=0,lastError="";
function str(x){return String(x??"").trim()}
function configured(){return Boolean(str(process.env.GOOGLE_SHEET_STORE_URL)&&str(process.env.GOOGLE_SHEET_STORE_SECRET))}
function signature(c){
 const id=str(c?.id);
 if(!/^[1-9]\d*$/.test(id))return "";
 const data=[VERSION,id,str(c.name).toLowerCase().replace(/ё/g,"е"),
  str(c.crmInn).replace(/\D/g,""),
  ...(c.crmPhones||[]).map(x=>str(x).replace(/\D/g,"")).sort(),
  ...(c.crmEmails||[]).map(x=>str(x).toLowerCase()).sort(),
  str(c.suppliedSiteCandidate),
  ...(c.suppliedSiteCandidates||[])].join("|");
 return crypto.createHash("sha256").update(data).digest("hex");
}
function valid(p,id){
 return p?.recordType==="topsense-company-site-search-v2"&&
  str(p.companyId)===id&&p.version===VERSION&&
  /^[0-9a-f]{64}$/.test(str(p.fingerprint))&&
  ["not_found","no_confirmed_site","needs_review"].includes(p.status)&&
  Number.isFinite(Date.parse(p.checkedAt||""));
}
function ingest(rows){
 let n=0;
 for(const row of rows||[]){
  const key=str(row?.key);
  if(!key.startsWith(PREFIX))continue;
  const id=key.slice(PREFIX.length),p=row?.payload;
  if(!/^[1-9]\d*$/.test(id)||!valid(p,id))continue;
  const before=known.get(id);
  if(before&&Date.parse(before.checkedAt||0)>Date.parse(p.checkedAt))continue;
  known.set(id,p);n++;
 }
 restored+=n;return n;
}
function get(c,now=Date.now()){
 const id=str(c?.id),p=known.get(id);
 if(!p||!valid(p,id)||p.fingerprint!==signature(c))return null;
 const since=Date.parse(p.checkedAt);
 if(since>now||now-since>TTL_MS)return null;
 return {status:p.status,candidates:[],checkedAt:p.checkedAt,
  note:"Недавний поиск сохранён; при новых реквизитах будет повторён",
  negativeSearchCheckpoint:true};
}
function offer(c,p){
 if(!configured()||!c||!p||!["not_found","no_confirmed_site","needs_review"].includes(p.status))return false;
 const id=str(c.id),fp=signature(c);
 if(!fp)return false;
 const prev=known.get(id)||pending.get(id)?.payload;
 if(prev&&prev.fingerprint===fp&&prev.status===p.status&&
    Date.now()-Date.parse(prev.checkedAt||0)<TTL_MS)return false;
 pending.set(id,{key:PREFIX+id,payload:{
  recordType:"topsense-company-site-search-v2",version:VERSION,companyId:id,
  fingerprint:fp,status:p.status,checkedAt:new Date().toISOString()}});
 schedule();return true;
}
function schedule(delay=13000){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},delay);
 if(timer?.unref)timer.unref();
}
async function flush(){
 if(writing||!pending.size||!configured())return;
 writing=true;const batch=[...pending.values()].slice(0,4);
 batch.forEach(v=>pending.delete(v.payload.companyId));
 try{
  const r=await fetch(str(process.env.GOOGLE_SHEET_STORE_URL),{
   method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({action:"upsert",secret:str(process.env.GOOGLE_SHEET_STORE_SECRET),rows:batch}),
   signal:AbortSignal.timeout(22000)});
  const result=await r.json();
  if(!r.ok||result?.ok===false)throw Error("site-search-checkpoint-failed");
  ingest(batch);stored+=batch.length;lastError="";
 }catch{
  lastError="save_error";errors++;
  for(const row of batch)if(!pending.has(row.payload.companyId))
   pending.set(row.payload.companyId,row);
 }finally{writing=false;if(pending.size)schedule(lastError?45000:8000)}
}
function stats(){return {loaded:known.size,restored,stored,pending:pending.size,errors,lastError}}
module.exports={PREFIX,signature,valid,ingest,get,offer,flush,stats};

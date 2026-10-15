"use strict";
// Durable deal-only website evidence, separate from CRM company-site records.
// Names change as legal identity is verified; stable analytical ID does not.
const crypto=require("crypto"),prefix="site-profile:v1:96";
const saved=new Map(),pending=new Map();
let timer=null,busy=false,restored=0,stored=0,errors=0,lastError="";
const str=x=>String(x??"").trim();
function keyFor(id){
 const val=str(id);
 if(!val.startsWith("dealonly:"))return "";
 return prefix+(BigInt("0x"+crypto.createHash("sha256").update(val).digest("hex").slice(0,13))%10000000000n)
  .toString().padStart(10,"0");
}
function validate(r,id){
 if(!r||r.recordType!=="topsense-deal-only-site-v1"||str(r.id)!==id)return false;
 if(!r.confirmed||!/^https?:\/\//i.test(str(r.site)))return false;
 if(!Number.isFinite(Date.parse(r.checkedAt||"")))return false;
 if(!["identity_verified","profile_read"].includes(r.stage))return false;
 try{
  const u=new URL(r.site);
  return ["https:","http:"].includes(u.protocol)&&u.hostname.includes(".")&&
   !u.username&&!u.password&&!u.port;
 }catch{return false}
}
function ingest(rows){
 let count=0;
 for(const row of rows||[]){
  const p=row?.payload,id=str(p?.id);
  if(!id||row.key!==keyFor(id)||!validate(p,id))continue;
  const old=saved.get(id);
  if(old&&Date.parse(old.checkedAt)>=Date.parse(p.checkedAt))continue;
  saved.set(id,p);count++;
 }
 restored+=count;return count;
}
function get(id){return saved.get(str(id))||null}
function apply(client){
 const r=get(client?.id);
 if(!r||!validate(r,str(client.id)))return client;
 if(client.websiteResearch?.status==="confirmed"&&client.websiteResearch?.checkedSite&&
    client.websiteResearch.checkedSite!==r.site)return client;
 return {...client,siteCandidate:r.site,
  siteSource:"Подтверждённый сайт из архивного исследования сделок",
  siteStatus:r.stage==="profile_read"?"site_profiled":"site_identity_verified",
  siteProfileUrl:r.stage==="profile_read"?r.site:"",
  siteProfileTitle:r.siteTitle||"",
  siteProfileDescription:r.siteDescription||"",
  organizationType:r.siteType||client.organizationType||"",
  siteResearchRestored:true,
  websiteResearch:{...(client.websiteResearch||{}),
   status:"confirmed",checkedSite:r.site,
   evidence:r.proof||"Проверка сайта по независимым реквизитам",
   activityTypeConfirmedBySite:Boolean(r.siteType),
   checkedAt:r.checkedAt,persisted:true}};
}
function offer(client,siteResult,siteProfile){
 const id=str(client?.id);
 if(!keyFor(id)||siteResult?.status!=="confirmed"||!siteResult.site)return false;
 let url;
 try{
  url=new URL(siteResult.site);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.port)return false;
 }catch{return false}
 const stage=["site_profiled","site_read_no_clear_type","site_read_ambiguous_type"].includes(siteProfile?.status)?
  "profile_read":"identity_verified";
 const siteType=str(siteProfile?.siteType);
 const legalType=require("./client-taxonomy").known(siteType)?siteType:"";
 const now=new Date().toISOString();
 const row={recordType:"topsense-deal-only-site-v1",id,confirmed:true,
  site:url.origin,stage,siteType:legalType,
  siteTitle:str(siteProfile?.siteTitle).slice(0,220),
  siteDescription:str(siteProfile?.siteDescription).slice(0,500),
  proof:str(siteResult.note).slice(0,230),checkedAt:now};
 const previous=saved.get(id)||pending.get(id)?.payload;
 if(previous&&previous.site===row.site&&previous.siteType===row.siteType&&previous.stage===stage)
  return false;
 pending.set(id,{key:keyFor(id),payload:row});
 schedule();
 return true;
}
function schedule(delay=7000){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},delay);
 if(timer?.unref)timer.unref();
}
async function flush(){
 if(busy||!pending.size)return;
 const endpoint=str(process.env.GOOGLE_SHEET_STORE_URL);
 const secret=str(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!endpoint||!secret){lastError="private_store_not_configured";return}
 busy=true;
 const batch=[...pending.values()].slice(0,12);
 batch.forEach(x=>pending.delete(x.payload.id));
 try{
  const resp=await fetch(endpoint,{method:"POST",
   headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch}),
   signal:AbortSignal.timeout(22000)});
  const p=await resp.json();
  if(!resp.ok||p?.ok===false)throw Error("site_store_unavailable");
  ingest(batch);stored+=batch.length;lastError="";
  console.log(JSON.stringify({component:"deal-only-site-ledger",event:"sites-saved",count:batch.length}));
 }catch{
  errors++;lastError="write_failed";
  for(const row of batch)if(!pending.has(row.payload.id))pending.set(row.payload.id,row);
  console.warn(JSON.stringify({component:"deal-only-site-ledger",event:"checkpoint-failed"}));
 }finally{busy=false;if(pending.size)schedule(lastError?50000:7000)}
}
function stats(){return {loaded:saved.size,restored,stored,pending:pending.size,errors,lastError}}
module.exports={prefix,keyFor,validate,ingest,get,apply,offer,flush,stats};

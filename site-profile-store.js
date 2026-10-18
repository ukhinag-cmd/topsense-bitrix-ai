"use strict";
// Free, read-only website evidence is checkpointed in the EXISTING private
// Google Sheet store. No Bitrix mutations and no AI calls are made here.
const crypto=require("crypto");
const PREFIX="site-profile:v1:";
const TTL_MS=21*24*60*60*1000;
const statuses=new Set(["site_profiled","site_preliminary_profiled","site_read_no_clear_type","site_read_ambiguous_type","site_identity_unclear"]);
const pending=new Map();
let timer=null,writing=false,loadedRows=0,storedRows=0,writeErrors=0,lastError="",batchLimit=4,consecutiveSuccesses=0;

function configured(){
 return Boolean(String(process.env.GOOGLE_SHEET_STORE_URL||"").trim()&&String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim());
}
function inputUrl(c){
 if(!c)return "";
 const individuallyIdentified=Boolean(c.verifiedOrgType)||
  ["Официальный сайт, проверенный по юридическим данным",
   "Сайт организации, установленный по независимым источникам; содержимое и доступность ещё не проверены",
   "Поиск по названию — подтверждено независимыми реквизитами",
   "Сайт из подписи входящего письма",
   "Сайт из карточки компании, присланной письмом"].includes(c.siteSource);
 if(individuallyIdentified&&c.siteCandidate)return c.siteCandidate;
 // A company's own corporate mail domain outranks an unverified CRM URL.
 if(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(c.corporateDomain||""))return "https://"+c.corporateDomain;
 return c.siteCandidate||"";
}
function fingerprint(c){
 let host="";
 try{host=new URL(inputUrl(c)).hostname.toLowerCase().replace(/^www\./,"")}catch{}
 if(!host||!c?.id)return "";
 const identity=[
  String(c.id),
  String(c.name||"").toLocaleLowerCase("ru-RU").replace(/ё/g,"е").replace(/\s+/g," ").trim(),
  host,
  String(c.siteSource||"")
 ];
 return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function acceptable(profile){
 return Boolean(profile&&statuses.has(profile.status)&&
  (!["site_profiled","site_preliminary_profiled"].includes(profile.status)||String(profile.siteType||"").trim()));
}
function fresh(row,now=Date.now()){
 if(!row||row.recordType!=="topsense-site-profile"||!acceptable(row.profile))return false;
 const timestamp=Date.parse(String(row.checkedAt||""));
 return Number.isFinite(timestamp)&&timestamp<=now&&now-timestamp<=TTL_MS&&
  /^[0-9a-f]{64}$/.test(String(row.fingerprint||""));
}
async function request(action,rows){
 const url=String(process.env.GOOGLE_SHEET_STORE_URL||"").trim();
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim();
 if(!url||!secret)throw Error("private_store_unconfigured");
 const body=JSON.stringify({action,secret,...(rows?{rows}:{})});
 let lastError=null;
 // All writes are upserts with stable keys. An ambiguous timeout can safely
 // retry the identical payload, never creating another paid reservation.
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const response=await fetch(url,{method:"POST",
    headers:{"content-type":"application/json","accept":"application/json"},
    body,redirect:"follow",signal:AbortSignal.timeout(28000)});
   const raw=await response.text();
   let result;
   try{result=JSON.parse(raw)}catch{
    const e=Error("private_store_invalid_json");
    e.retryable=response.ok||response.status>=500||response.status===429;
    throw e;
   }
   if(!response.ok||result?.ok===false){
    const e=Error("private_store_rejected");
    e.retryable=response.status===429||response.status>=500;
    throw e;
   }
   return result;
  }catch(e){
   lastError=e;
   const transient=e.retryable===true||
    /aborted due to timeout|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(e?.message||e));
   if(!transient||attempt===3)break;
   console.warn(JSON.stringify({component:"site-profile-store",event:"bridge-retry",
    action,attempt,reason:String(e.message||e).slice(0,90)}));
   await new Promise(resolve=>setTimeout(resolve,attempt*1800));
  }
 }
 throw lastError||Error("private_store_unavailable");
}
function fromRows(rows){
 const map=new Map();
 for(const entry of rows||[]){
  const key=String(entry?.key||"");
  const record=entry?.payload;
  const id=key.startsWith(PREFIX)?key.slice(PREFIX.length):"";
  if(!/^\d+$/.test(id)||!fresh(record)||String(record.companyId)!==id)continue;
  map.set(id,record);
 }
 return map;
}
async function load(){
 const map=new Map();
 if(!configured())return map;
 try{
  const response=await request("load");
  for(const row of (Array.isArray(response.rows)?response.rows:[])){
   const key=String(row?.key||"");
   const p=row?.payload;
   if(!key.startsWith(PREFIX)||!fresh(p))continue;
   const id=key.slice(PREFIX.length);
   if(!/^\d+$/.test(id)||String(p.companyId)!==id)continue;
   map.set(id,p);
  }
  loadedRows=map.size;lastError="";
 }catch(e){lastError="load_error";writeErrors++;console.warn(JSON.stringify({component:"site-profile-store",event:"restore-unavailable"}))}
 return map;
}
function restored(c,row,now=Date.now()){
 return fresh(row,now)&&row.fingerprint===fingerprint(c)?{...row.profile,restoredFromStore:true}:null;
}
function serialise(profile){
 return {status:profile.status,source:String(profile.source||"").slice(0,160),
  url:String(profile.url||"").slice(0,600),
  siteTitle:String(profile.siteTitle||"").slice(0,300),
  siteDescription:String(profile.siteDescription||"").slice(0,600),
  siteHeadings:(profile.siteHeadings||[]).slice(0,18).map(s=>String(s).slice(0,230)),
  sitePageCount:Number(profile.sitePageCount||0),
  sitePagesVisited:(profile.sitePagesVisited||[]).slice(0,6).map(s=>String(s).slice(0,600)),
  siteContactPages:(profile.siteContactPages||[]).slice(0,6).map(s=>String(s).slice(0,600)),
  siteActivityReason:String(profile.siteActivityReason||"").slice(0,260),
  siteIdentityEvidence:String(profile.siteIdentityEvidence||"").slice(0,100),
  siteIdentityVerified:profile.siteIdentityVerified===true,
  emailSenderDomain:String(profile.emailSenderDomain||"").slice(0,180),
  siteType:profile.siteType||null,
  siteConfidence:String(profile.siteConfidence||"").slice(0,160),
  staffEvidence:profile.staffEvidence?.count>0?{
   count:Number(profile.staffEvidence.count),year:Number(profile.staffEvidence.year)||null,
   approximate:Boolean(profile.staffEvidence.approximate),
   source:String(profile.staffEvidence.source||"").slice(0,100),
   sourceUrl:String(profile.staffEvidence.sourceUrl||"").slice(0,400),
   basis:String(profile.staffEvidence.basis||"").slice(0,250)
  }:null,
  checkedAt:String(profile.checkedAt||new Date().toISOString())};
}
function schedule(ms=15000){
 if(timer||!configured())return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},ms);
 if(typeof timer.unref==="function")timer.unref();
}
function queue(c,profile){
 if(!configured()||!acceptable(profile))return;
 const fp=fingerprint(c);
 if(!fp)return;
 const id=String(c.id);
 pending.set(PREFIX+id,{key:PREFIX+id,payload:{
  recordType:"topsense-site-profile",companyId:id,fingerprint:fp,
  checkedAt:String(profile.checkedAt||new Date().toISOString()),profile:serialise(profile)
 }});
 schedule();
}
async function flush(){
 if(!configured()||writing||!pending.size)return;
 writing=true;
 const rows=[...pending.values()].slice(0,batchLimit);
 for(const row of rows)pending.delete(row.key);
 try{
  await request("upsert",rows);
  storedRows+=rows.length;lastError="";
  consecutiveSuccesses++;
  // Gradually restore throughput when the existing Apps Script bridge
  // accepts small writes; avoid overwhelming it with concurrent bulk updates.
  if(consecutiveSuccesses>=5&&batchLimit<6){
   batchLimit++;consecutiveSuccesses=0;
  }
 }catch(e){
  writeErrors+=rows.length;lastError="save_error";
  consecutiveSuccesses=0;
  // Retry the SAME evidence in smaller upserts; do not discard anything.
  batchLimit=Math.max(1,Math.floor(batchLimit/2));
  // Failed batch is not discarded; keep newest evidence on conflicting keys.
  for(const row of rows)if(!pending.has(row.key))pending.set(row.key,row);
  console.warn(JSON.stringify({component:"site-profile-store",event:"checkpoint-unavailable",rows:rows.length}));
 }finally{
  writing=false;
  if(pending.size)schedule(lastError?60000:15000);
 }
}
function stats(){return {configured:configured(),cacheRowsLoaded:loadedRows,siteProfilesStored:storedRows,
 writeErrors,pendingWrites:pending.size,lastError,batchLimit};}
module.exports={configured,inputUrl,fingerprint,fresh,restored,fromRows,load,queue,flush,stats};

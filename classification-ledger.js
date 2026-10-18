"use strict";
// Persistent per-CRM-ID analytical types; saved to existing PRIVATE store.
// This is NOT a CRM edit, and provisional types remain explicitly provisional.
const crypto=require("crypto");
const taxonomy=require("./client-taxonomy");
// Existing Google Apps Script read bridge returns the original site-profile
// namespace but does not consistently return newly introduced key families.
// Reserved synthetic numeric IDs share that readable namespace without
// ever becoming website profiles: the recordType remains type-ledger only.
const PREFIX="site-profile:v1:900000000000";
const LEGACY_PREFIX="classification:type:v1:";
const records=new Map(),pending=new Map();
let timer=null,writing=false,restored=0,stored=0,errors=0,lastError="";
const str=v=>String(v??"").trim();
function identity(c){
 const id=str(c?.id),name=str(c?.name).toLocaleLowerCase("ru-RU").replace(/ё/g,"е").replace(/\s+/g," ");
 return id&&name?crypto.createHash("sha256").update(id+"|"+name).digest("hex"):"";
}
function inboundProof(c){
 return c?.researchStatus==="inbound_self_description_qualified"&&
  taxonomy.known(c?.organizationType)&&
  str(c?.segmentSource).startsWith("Собственная деятельность в письме сделки ")&&
  /подтверждённым совпадением ИНН/.test(str(c?.verification));
}
function rank(c){
 if(inboundProof(c))return 5;
 const source=str(c?.segmentSource).toLowerCase(),conf=str(c?.segmentConfidence).toLowerCase();
 if(source.includes("название crm")||conf.includes("по названию"))return 1;
 if(c?.siteStatus==="research_completed")return 6;
 if(c?.siteStatus==="official_site_verified"||c?.verifiedOrgType)return 5;
 if(c?.siteStatus==="site_profiled"||conf.includes("профильным раздел")||source.includes("проверенного сайта"))return 4;
 if(/подтверждено|официальный сайт|подтверждена/.test(conf)||source.includes("официальный сайт"))return 4;
 if(c?.aiStatus==="classified"||source.includes("ai")||source.includes("сохранённая аналитика"))return 2;
 return 2;
}
function valid(row,id){
 return Boolean(row&&row.recordType==="topsense-type-ledger-v1"&&
  /^[0-9]+$/.test(id)&&str(row.companyId)===id&&
  /^[0-9a-f]{64}$/.test(str(row.identityHash))&&taxonomy.known(row.type)&&
  Number.isInteger(row.rank)&&row.rank>=1&&row.rank<=6&&
  Number.isFinite(Date.parse(row.savedAt||"")));
}
function ingest(rows){
 let count=0;
 for(const entry of rows||[]){
  const key=str(entry?.key);
  const prefix=key.startsWith(PREFIX)?PREFIX:key.startsWith(LEGACY_PREFIX)?LEGACY_PREFIX:null;
  if(!prefix)continue;
  const id=key.slice(prefix.length),row=entry.payload;
  if(!valid(row,id))continue;
  const old=records.get(id);
  if(old&&Date.parse(old.savedAt)>=Date.parse(row.savedAt))continue;
  records.set(id,row);count++;
 }
 restored+=count;return count;
}
function get(id){return records.get(str(id))||null}
function apply(c){
 const saved=get(c?.id);
 if(!saved||!taxonomy.known(saved.type))return c;
 // A qualified customer is locked to the LAST persisted decision.
 // A new deal without correspondence, a changed website or a manual CRM
 // field edit must never silently rewrite the company's type or site.
 const identityChanged=Boolean(identity(c)&&saved.identityHash!==identity(c));
 // Reused CRM ID/renamed legal entity is NOT proof of the original
 // organization. Keep its previous qualification in the durable ledger
 // without misassigning it to a potentially different company.
 if(identityChanged)return {...c,organizationType:"",type:"",
  companyIdentityReviewRequired:true,previousQualifiedType:saved.type,
  previousQualifiedName:saved.companyName||"",
  researchStatus:"identity_changed_requires_review"};
 // A name-only or preliminary AI result is NOT a permanently qualified type.
 // Permit ONLY verified new first-party activity evidence to supersede it.
 if(saved.rank<=2&&inboundProof(c))return {...c,
  previousProvisionalType:saved.type,pendingEvidenceUpgrade:true,
  classificationFrozen:false,ledgerRestored:true};
 return {...c,organizationType:saved.type,type:saved.type,
  category:saved.category||c.category,
  segmentSource:"Квалификация закреплена · "+(saved.source||"сохранённый источник"),
  segmentConfidence:saved.confidence||"Сохранённая квалификация",
  verification:saved.verification||"Сохранено в аналитической базе",
  siteProfileUrl:saved.siteUrl||c.siteProfileUrl||"",
  siteVerified:saved.siteUrl||c.siteVerified||"",
  classificationFrozen:saved.rank>=4,
  classificationProvisional:saved.rank<4,
  classificationFrozenAt:saved.rank>=4?saved.savedAt:null,
  ledgerRestored:true,companyIdentityReviewRequired:false,
  researchStatus:c.researchStatus||"qualified_immutable"};
}
function offer(c){
 const id=str(c?.id),type=str(c?.organizationType);
 if(!/^\d+$/.test(id)||!taxonomy.known(type))return false;
 const hash=identity(c);
 if(!hash)return false;
 const existing=records.get(id)||pending.get(id)?.payload;
 // No fresh correspondence => never rewrite an already qualified record.
 // Even with fresh correspondence, the existing type is kept until a
 // separate evidence-based requalification is explicitly approved.
 // Only preliminaries may be upgraded; actual verified qualifications stay
 // immutable. Identity hash MUST still refer to the same original legal card.
 if(existing&&!(existing.rank<=2&&inboundProof(c)&&existing.identityHash===hash))return false;
 const nextRank=rank(c);
 const row={recordType:"topsense-type-ledger-v1",companyId:id,identityHash:hash,
  companyName:str(c.name).slice(0,180),
  type,category:str(c.category).slice(0,80),rank:nextRank,
  source:str(c.segmentSource).slice(0,280),
  confidence:str(c.segmentConfidence).slice(0,120),
  verification:str(c.verification).slice(0,140),
  siteUrl:str(c.siteProfileUrl||c.siteVerified).slice(0,350),
  savedAt:new Date().toISOString()};
 pending.set(id,{key:PREFIX+id,payload:row});
 schedule();return true;
}
function offerMany(companies){
 let queued=0;
 for(const c of companies||[])if(offer(c))queued++;
 return queued;
}
function schedule(delay=2200){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},delay);
 if(timer.unref)timer.unref();
}
async function flush(){
 if(writing||!pending.size)return;
 const url=str(process.env.GOOGLE_SHEET_STORE_URL),secret=str(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!url||!secret){lastError="store_not_configured";return}
 writing=true;
 const batch=[...pending.entries()].slice(0,18);
 for(const [id] of batch)pending.delete(id);
 try{
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch.map(x=>x[1])}),
   signal:AbortSignal.timeout(22000)});
  const response=await r.json();
  if(!r.ok||response?.ok===false)throw Error("type_ledger_write_failed");
  ingest(batch.map(x=>x[1]));stored+=batch.length;lastError="";
  console.log(JSON.stringify({component:"classification-ledger",event:"types-checkpointed",
   batch:batch.length,total:records.size,remaining:pending.size}));
 }catch{
  errors++;lastError="write_failed";
  for(const [id,row] of batch)if(!pending.has(id))pending.set(id,row);
  console.warn(JSON.stringify({component:"classification-ledger",event:"checkpoint-failed",
   attempted:batch.length,remaining:pending.size}));
 }finally{writing=false;if(pending.size)schedule(lastError?18000:2200)}
}
function stats(){
 const byRank={};
 for(const row of records.values()){
  const key=String(row.rank);
  byRank[key]=(byRank[key]||0)+1;
 }
 return {loaded:records.size,restored,stored,pending:pending.size,errors,lastError,
  provisional:[...records.values()].filter(x=>x.rank<4).length,
  frozenVerified:[...records.values()].filter(x=>x.rank>=4).length,byRank};
}
module.exports={PREFIX,LEGACY_PREFIX,identity,rank,valid,ingest,apply,offer,offerMany,flush,stats,get};

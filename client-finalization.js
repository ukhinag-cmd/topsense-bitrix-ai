"use strict";
// TOP-SENSE: immutable company RESEARCH only, not a frozen CRM relationship.
// A completed company remains in the main registry; contacts, opportunities,
// payments, ownership, and new CRM events continue to be refreshed read-only.
const crypto=require("crypto");
const valid={has:require("./client-taxonomy").known};
const PREFIX="client:completed:v1:";
const completed=new Map(),pending=new Map();
let flushing=false,timer=null,restored=0,stored=0,errors=0,lastError="";
const string=x=>String(x??"").trim();
function identity(c){
 const id=string(c?.id);
 const name=string(c?.name).toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ");
 return id&&name?crypto.createHash("sha256").update(id+"|"+name).digest("hex"):"";
}
function safeWebsite(value){
 try{
  const u=new URL(string(value));
  return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password&&u.hostname.includes(".")?u.origin:"";
 }catch{return""}
}
function ingest(rows){
 let added=0;
 for(const e of rows||[]){
  const key=string(e?.key);
  if(!key.startsWith(PREFIX))continue;
  const p=e?.payload||{},id=key.slice(PREFIX.length);
  if(!/^\d+$/.test(id)||p.recordType!=="topsense-company-research-complete"||
   string(p.companyId)!==id||!valid.has(p.organizationType)||
   !safeWebsite(p.siteUrl)||!/^[0-9a-f]{64}$/.test(string(p.identityHash)))continue;
  if(completed.has(id))continue;
  completed.set(id,p);added++;
 }
 restored+=added;
 return added;
}
function isComplete(id){return completed.has(string(id))}
function get(id){return completed.get(string(id))||null}
function apply(c){
 const row=get(c?.id);
 if(!row)return c;
 // The company name and CRM/relationship fields remain LIVE.
 // Historical verified site and type are now immutable for research passes.
 const changed=Boolean(identity(c)&&row.identityHash!==identity(c));
 // A CRM ID reused for a different legal name is a conflict, NOT proof that
 // the old qualified legal entity now has the changed name.
 if(changed)return {...c,organizationType:"",type:"",
  previousQualifiedType:row.organizationType,
  companyIdentityReviewRequired:true,
  researchStatus:"completed_identity_changed_review",
  researchCompletedAt:row.completedAt};
 return {...c,organizationType:row.organizationType,type:row.organizationType,
  category:row.category||c.category,siteStatus:"research_completed",
  siteProfileUrl:row.siteUrl,siteVerified:row.siteUrl,
  segmentConfidence:row.segmentConfidence||"Ранее подтверждено",
  segmentSource:row.source||"Постоянный реестр проверенных компаний",
  verification:row.verification||"Исследование компании завершено",
  researchStatus:changed?"completed_identity_changed_review":"completed",
  researchCompletedAt:row.completedAt,companyIdentityReviewRequired:changed};
}
function criteria(c,context={}){
 const missing=[];
 if(!c||!c.id||!identity(c))missing.push("company_identity");
 if(!valid.has(c?.organizationType))missing.push("approved_type");
 const website=safeWebsite(c?.siteVerified||c?.siteProfileUrl);
 // Only independently reviewed legal-site attribution permits an immutable
 // "research complete" lock. A CRM/AI website candidate is not enough.
 const verifiedSite=c?.siteStatus==="official_site_verified"&&
  valid.has(c?.verifiedOrgType)&&
  string(c?.siteSource)==="Официальный сайт, проверенный по юридическим данным";
 if(!website||!verifiedSite)missing.push("verified_company_website");
 if(!context.contactsAt)missing.push("contacts_not_audited");
 if(!(Array.isArray(c?.contactEmails)&&c.contactEmails.length>0) &&
    !(Array.isArray(c?.contactNames)&&c.contactNames.length>0))missing.push("linked_contacts_missing");
 // "No purchase" is a verified outcome ONLY after full stage/history audit.
 const purchase=string(c?.saleInfo?.purchaseStatus);
 // Positive stage/document evidence can be confirmed individually even when
 // global orphan-deal audit is still partial. A negative requires full audit.
 const hasPositive=/^БЫЛА/.test(purchase);
 const hasNegative=/^НЕ БЫЛО/.test(purchase)&&context.salesStatus==="complete";
 if(!hasPositive&&!hasNegative)missing.push("purchase_status_unverified");
 if(context.duplicateIds?.has(string(c?.id)))missing.push("duplicate_identity_pending");
 // An AI-only verdict is preliminary even if an AI declared site ownership.
 if(/^AI\s*[—-]/.test(string(c?.verification))||c?.verification==="Предварительная классификация")
  missing.push("classification_requires_verification");
 return {complete:missing.length===0,missing,website};
}
function schedule(){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},5000);
 if(typeof timer.unref==="function")timer.unref();
}
function queue(c,context={}){
 if(!c||isComplete(c.id)||pending.has(string(c.id)))return false;
 const v=criteria(c,context);if(!v.complete)return false;
 const id=string(c.id);
 pending.set(id,{key:PREFIX+id,payload:{
  recordType:"topsense-company-research-complete",companyId:id,
  identityHash:identity(c),organizationType:c.organizationType,
  category:string(c.category).slice(0,100),
  siteUrl:v.website,segmentConfidence:string(c.segmentConfidence).slice(0,100),
  source:string(c.segmentSource).slice(0,280),
  verification:string(c.verification).slice(0,110),
  completedAt:new Date().toISOString(),policy:"research-only-lock-v1"
 }});
 schedule();return true;
}
async function flush(){
 if(flushing||!pending.size)return;
 const url=string(process.env.GOOGLE_SHEET_STORE_URL),secret=string(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!url||!secret){lastError="store_not_configured";return}
 flushing=true;
 const batch=[...pending.values()].slice(0,15);
 for(const e of batch)pending.delete(e.payload.companyId);
 try{
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch}),signal:AbortSignal.timeout(20000)});
  const result=await r.json();
  if(!r.ok||result?.ok===false)throw Error("private_store_write_failed");
  ingest(batch);stored+=batch.length;lastError="";
  console.log(JSON.stringify({component:"client-finalization",event:"research-locked",
   count:batch.length,total:completed.size}));
 }catch{
  errors++;lastError="checkpoint_failed";
  for(const e of batch)if(!pending.has(e.payload.companyId))pending.set(e.payload.companyId,e);
  console.warn(JSON.stringify({component:"client-finalization",event:"checkpoint-failed"}));
 }finally{flushing=false;if(pending.size)schedule()}
}
function stats(){return {completed:completed.size,restored,stored,waiting:pending.size,errors,lastError}}
module.exports={identity,criteria,ingest,apply,isComplete,get,queue,flush,stats};

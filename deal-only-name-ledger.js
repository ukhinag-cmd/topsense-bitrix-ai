"use strict";
// Durable names for analytical deal-only clients. No Bitrix mutations.
// Uses existing private Google Sheet store, never public GitHub for client data.
const crypto=require("crypto");
const prefix="site-profile:v1:95"; // readable namespace in existing bridge
const entries=new Map(),pending=new Map();
let stored=0,restored=0,errors=0,lastError="",timer=null,busy=false;
const str=x=>String(x??"").trim();
function keyFor(id){
 const s=str(id);
 if(!s.startsWith("dealonly:"))return "";
 const hash=crypto.createHash("sha256").update(s).digest();
 const value=(hash.readUIntBE(0,5)%10000000000).toString().padStart(10,"0");
 return prefix+value;
}
function valid(v,id,key=keyFor(id)){
 const parsed=require("./client-canonical-name").parse(v?.canonicalName);
 return Boolean(parsed&&v?.recordType==="topsense-deal-only-canonical-name"&&
  str(v.id)===str(id)&&key&&
  /^[0-9a-f]{64}$/.test(str(v.identityHash))&&
  v.identityHash===crypto.createHash("sha256").update(str(id)).digest("hex")&&
  ["legal_name_verified","legal_name_from_incoming_requisites"].includes(v.nameStatus)&&
  typeof v.verified==="boolean"&&
  (v.nameStatus!=="legal_name_verified"||v.verified)&&
  Number.isFinite(Date.parse(v.savedAt||"")));
}
function ingest(rows){
 let count=0;
 for(const r of rows||[]){
  const v=r?.payload,id=str(v?.id),key=keyFor(id);
  if(!key||str(r.key)!==key||!valid(v,id,key))continue;
  const old=entries.get(id);
  if(old&&(old.verified&&!v.verified ||
   old.verified===v.verified&&Date.parse(old.savedAt)>=Date.parse(v.savedAt)))continue;
  entries.set(id,v);count++;
 }
 restored+=count;return count;
}
function apply(c){
 const id=str(c?.id),v=entries.get(id);
 if(!v||!valid(v,id))return c;
 if(c.nameStatus==="legal_name_verified"&&c.identityVerified===true&&!v.verified)return c;
 if(c.nameStatus==="identity_conflict")return c;
 // Reapply only the display identity; all deal IDs, amounts, opportunities,
 // CRM references and immutable analytical key stay untouched.
 const raw=str(c.originalName||c.name);
 const aliases=[...new Set([raw,...(c.aliases||[]),...(v.aliases||[]),v.canonicalName].filter(Boolean))].slice(0,16);
 return {...c,originalName:raw,name:v.canonicalName,displayName:v.canonicalName,
  legalForm:require("./client-canonical-name").parse(v.canonicalName)?.opf||"",
  nameStatus:v.nameStatus,nameEvidence:v.nameEvidence,
  identityVerified:v.verified,aliases,canonicalInn:v.inn||"",
  nameRestoredFromPrivateStore:true};
}
function offer(c){
 const id=str(c?.id),key=keyFor(id);
 if(!key||!["legal_name_verified","legal_name_from_incoming_requisites"].includes(c.nameStatus))return false;
 const parsed=require("./client-canonical-name").parse(c.name);
 if(!parsed)return false;
 const verified=c.nameStatus==="legal_name_verified"&&c.identityVerified===true;
 const old=entries.get(id)||pending.get(id)?.payload;
 if(old&&(old.verified&&!verified ||
  old.canonicalName===parsed.name&&old.verified===verified))return false;
 const row={recordType:"topsense-deal-only-canonical-name",id,
  identityHash:crypto.createHash("sha256").update(id).digest("hex"),
  canonicalName:parsed.name,nameStatus:c.nameStatus,verified,
  inn:verified?str(c.canonicalInn).slice(0,12):"",
  aliases:[...new Set((c.aliases||[]).map(str).filter(x=>x.length<=160))].slice(0,16),
  nameEvidence:(c.nameEvidence||[]).slice(0,3).map(x=>({
   source:str(x.source).slice(0,70),sourceRef:str(x.sourceRef).slice(0,250),
   verified:Boolean(x.verified)})),
  savedAt:new Date().toISOString()};
 pending.set(id,{key,payload:row});schedule();return true;
}
function schedule(delay=6500){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},delay);
 if(typeof timer?.unref==="function")timer.unref();
}
async function flush(){
 if(busy||!pending.size)return;
 const url=str(process.env.GOOGLE_SHEET_STORE_URL),secret=str(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!url||!secret){lastError="private_store_not_configured";return}
 busy=true;
 const batch=[...pending.values()].slice(0,12);
 for(const item of batch)pending.delete(item.payload.id);
 try{
  const response=await fetch(url,{method:"POST",
   headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch}),
   signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok||data?.ok===false)throw Error("name_checkpoint_unavailable");
  ingest(batch);stored+=batch.length;lastError="";
  console.log(JSON.stringify({component:"deal-only-canonical-ledger",event:"names-saved",count:batch.length}));
 }catch{
  errors++;lastError="write_failed";
  for(const row of batch)if(!pending.has(row.payload.id))pending.set(row.payload.id,row);
  console.warn(JSON.stringify({component:"deal-only-canonical-ledger",event:"checkpoint-failed",count:batch.length}));
 }finally{busy=false;if(pending.size)schedule(lastError?60000:6500)}
}
function get(id){return entries.get(str(id))||null}
function stats(){return {loaded:entries.size,restored,stored,pending:pending.size,errors,lastError}}
module.exports={prefix,keyFor,valid,ingest,get,apply,offer,flush,stats};

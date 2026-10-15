"use strict";
// Durable *analytical* inventory recovered from unlinked historical CRM deals.
// This is NOT an authoritative legal-entity register: names from deal titles
// remain explicitly provisional. Uses existing private store; no CRM writes.
const crypto=require("node:crypto");
const PREFIX="site-profile:v1:971000000000";
const MANIFEST=PREFIX+"0000000000000000";
const pending=[],records=new Map();
let snapshot=null,writer=false,timer=null,saved=0,failures=0,lastError="",restored=0;
const str=x=>String(x??"").trim();
function shortRecord(g){
 return {key:str(g.key).slice(0,160),name:str(g.name).slice(0,180),
  rawName:str(g.rawName).slice(0,180),confidence:str(g.confidence).slice(0,60),
  linkedExisting:Boolean(g.linkedExisting),
  existingCrmIds:(g.existingCrmIds||[]).slice(0,12).map(str),
  dealCount:Math.max(0,Number(g.dealCount)||0),
  dealRefs:(g.dealRefs||[]).slice(0,12).map(d=>({
   id:str(d.id),title:str(d.title).slice(0,180),
   createdAt:str(d.createdAt).slice(0,40),
   url:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(str(d.id))+"/",
   relationshipEvidence:"Название из сделки — юрлицо требует проверки"}))};
}
function digest(groupRows,totalDeals){
 return crypto.createHash("sha256").update(JSON.stringify({totalDeals,
  names:groupRows.map(x=>[x.key,x.dealCount,x.dealRefs.map(d=>d.id)])}))
 .digest("hex");
}
function hashId(hex){
 return BigInt("0x"+hex.slice(0,12)).toString().padStart(16,"0");
}
function chunkKey(id,i){
 return PREFIX+id+String(i).padStart(4,"0");
}
function read(rows){
 const current=new Map((rows||[]).filter(x=>str(x?.key).startsWith(PREFIX)).map(x=>[x.key,x.payload]));
 const manifest=current.get(MANIFEST);
 if(!manifest||manifest.recordType!=="topsense-deal-inventory-manifest"||
    !/^\d{16}$/.test(str(manifest.id))||!Number.isInteger(manifest.parts)||
    manifest.parts<1||manifest.parts>180||!Number.isFinite(Date.parse(manifest.at||"")))
  return false;
 const all=[];
 for(let i=1;i<=manifest.parts;i++){
  const part=current.get(chunkKey(manifest.id,i));
  if(!part||part.recordType!=="topsense-deal-inventory-chunk"||
     part.id!==manifest.id||part.index!==i||!Array.isArray(part.groups))return false;
  all.push(...part.groups);
 }
 if(all.length!==manifest.count||all.some(x=>!x.key||!x.name||!Array.isArray(x.dealRefs)))
  return false;
 // Complete manifest is the commit point; incomplete writes never replace
 // an older in-memory snapshot. Recompute the digest for corruption checking.
 if(digest(all,manifest.totalDeals)!==manifest.digest)return false;
 if(snapshot&&Date.parse(snapshot.at)>Date.parse(manifest.at))return false;
 snapshot={at:manifest.at,groups:all,totalDeals:manifest.totalDeals,
  crmCards:manifest.crmCards,hash:manifest.digest,id:manifest.id};
 restored++;
 return true;
}
function schedule(ms=12000){
 if(timer||!pending.length)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},ms);
 if(timer?.unref)timer.unref();
}
function queue(fullGroups,context={}){
 if(!Array.isArray(fullGroups)||context.complete!==true||
   !Number.isSafeInteger(context.totalDeals)||context.totalDeals<1000)return false;
 const groups=fullGroups.map(shortRecord).filter(x=>x.key&&x.name);
 // A source regression must not silently destroy the larger saved inventory.
 if(snapshot&&groups.length<snapshot.groups.length*0.75&&
    context.totalDeals>=snapshot.totalDeals*0.9){
  lastError="candidate_count_regressed";return false;
 }
 const checksum=digest(groups,context.totalDeals);
 if(snapshot?.hash===checksum)return false;
 const id=hashId(checksum);
 const parts=[];
 for(let i=0;i<groups.length;i+=22)parts.push(groups.slice(i,i+22));
 if(!parts.length||parts.length>180)return false;
 const at=new Date().toISOString();
 const rows=parts.map((chunk,i)=>({key:chunkKey(id,i+1),
  payload:{recordType:"topsense-deal-inventory-chunk",id,index:i+1,groups:chunk}}));
 // Manifest LAST, so readers either restore the completed old snapshot
 // or the new fully committed one.
 rows.push({key:MANIFEST,payload:{recordType:"topsense-deal-inventory-manifest",
  id,parts:parts.length,count:groups.length,totalDeals:context.totalDeals,
  crmCards:Number(context.crmCards)||0,digest:checksum,at}});
 pending.splice(0,pending.length,...rows);
 // Show completed in-memory history immediately, even while checkpointing.
 snapshot={at,groups,totalDeals:context.totalDeals,crmCards:Number(context.crmCards)||0,
  hash:checksum,id};
 schedule();
 console.log(JSON.stringify({component:"deal-only-inventory",event:"snapshot-queued",
  groups:groups.length,parts:parts.length,deals:context.totalDeals}));
 return true;
}
async function flush(){
 if(writer||!pending.length)return;
 const url=str(process.env.GOOGLE_SHEET_STORE_URL),secret=str(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!url||!secret){lastError="private_store_not_configured";return}
 writer=true;
 const batch=pending.slice(0,Math.min(3,pending.length));
 try{
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json",
   accept:"application/json"},body:JSON.stringify({action:"upsert",secret,rows:batch}),
   signal:AbortSignal.timeout(26000)});
  const response=await r.json();
  if(!r.ok||response?.ok===false)throw Error("checkpoint_write_failed");
  pending.splice(0,batch.length);saved+=batch.length;lastError="";
  if(!pending.length)console.log(JSON.stringify({
   component:"deal-only-inventory",event:"snapshot-stored",
   groups:snapshot?.groups.length,dealCount:snapshot?.totalDeals}));
 }catch{
  failures++;lastError="checkpoint_write_failed";
  console.warn(JSON.stringify({component:"deal-only-inventory",
   event:"snapshot-save-retry",remaining:pending.length}));
 }finally{writer=false;if(pending.length)schedule(lastError?30000:1700)}
}
function available(existingCompanies=[],freshGroups=[],complete=false){
 if(complete)return freshGroups;
 if(!snapshot)return freshGroups;
 const norm=require("./crm-unlinked-discovery").normalize;
 const known=new Set(existingCompanies.map(c=>norm(c.name)));
 const valid=snapshot.groups.filter(x=>!x.linkedExisting&&!known.has(x.key));
 // Partial recent deal reads are NOT a complete census. Preserve old
 // full-history evidence until a new completed scan supersedes it.
 return valid;
}
function stats(){return {restored,stored,pending:pending.length,failures,lastError,
  available:Boolean(snapshot),groups:snapshot?.groups.length||0,
  sourceDeals:snapshot?.totalDeals||0,savedAt:snapshot?.at||null,
  source:"last_completed_full_historical_scan"}}
module.exports={PREFIX,MANIFEST,read,queue,flush,available,stats,digest,shortRecord};

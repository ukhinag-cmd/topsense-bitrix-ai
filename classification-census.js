"use strict";
// Durable display checkpoint for the LAST COMPLETED classification census.
// Counts are not company evidence and never create or change a classification.
const KEY="meta:topsense-classification-census:v1";
let saved=null,pending=null,writing=false,writeErrors=0,lastError="",timer=null;
const finiteInt=n=>Number.isSafeInteger(n)&&n>=0;
function valid(p){
 return Boolean(p&&p.recordType==="topsense-classification-census"&&
  finiteInt(p.typed)&&finiteInt(p.total)&&finiteInt(p.crmCards)&&
  p.typed<=p.total&&p.total<=p.crmCards&&
  Number.isFinite(Date.parse(p.completedAt||"")));
}
function ingest(rows){
 for(const r of rows||[]){
  if(r.key!==KEY||!valid(r.payload))continue;
  if(!saved||Date.parse(r.payload.completedAt)>=Date.parse(saved.completedAt))saved=r.payload;
 }
 return saved;
}
function display(total,typed,ready,crmCards){
 if(ready)return {total,typed,untyped:total-typed,provisional:false,completedAt:null,source:"current"};
 // Virtual deduplication can change while site/domain evidence restores.
 // When the underlying CRM card population has not changed, retain the last
 // finished census, explicitly labelling its former population as historical.
 if(saved&&(saved.total===total||saved.crmCards===crmCards))return {
  total:saved.total,typed:saved.typed,untyped:saved.total-saved.typed,
  provisional:true,completedAt:saved.completedAt,
  source:saved.total===total?"last_complete":"last_complete_virtual_groups_changed"};
 return {total,typed,untyped:total-typed,provisional:true,completedAt:null,source:"live_provisional"};
}
function consider(total,typed,crmCards,ready){
 if(!ready||![total,typed,crmCards].every(finiteInt)||typed>total||total>crmCards)return false;
 if(saved&&saved.total===total&&saved.typed===typed&&saved.crmCards===crmCards)return false;
 if(pending&&pending.total===total&&pending.typed===typed&&pending.crmCards===crmCards)return false;
 pending={recordType:"topsense-classification-census",total,typed,crmCards,completedAt:new Date().toISOString()};
 schedule();return true;
}
function schedule(){
 if(timer||!pending)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},2500);
 if(timer.unref)timer.unref();
}
async function flush(){
 if(writing||!pending)return;
 const url=String(process.env.GOOGLE_SHEET_STORE_URL||"").trim();
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim();
 if(!url||!secret){lastError="store_not_configured";return}
 writing=true;
 const row=pending;pending=null;
 try{
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:[{key:KEY,payload:row}]}),
   signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok||data?.ok===false)throw Error("snapshot_store_error");
  saved=row;lastError="";
  console.log(JSON.stringify({component:"classification-census",event:"checkpoint-saved",typed:row.typed,total:row.total}));
 }catch{
  writeErrors++;lastError="save_failed";
  if(!pending)pending=row;
  console.warn(JSON.stringify({component:"classification-census",event:"checkpoint-error"}));
 }finally{writing=false;if(pending)schedule()}
}
function stats(){return {available:Boolean(saved),completedAt:saved?.completedAt||null,writeErrors,lastError,pending:Boolean(pending)}}
module.exports={KEY,valid,ingest,display,consider,flush,stats};

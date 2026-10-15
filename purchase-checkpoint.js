"use strict";
// Positive shipment/payment stage evidence only; no claim that an open deal
// or a WON deal proves purchase. Stored in existing private Google Sheets store.
const PREFIX="sales:purchase:v1:";
const saved=new Map(),pending=new Map();
let flushing=false,timer=null,restored=0,stored=0,errors=0,lastError="";
const positive=p=>p&&p.recordType==="topsense-confirmed-purchase"&&
 String(p.purchaseStatus)==="БЫЛА"&&
 (p.shipped===true||p.paid===true||p.qualified===true);
function sanitize(id,record){
 return {recordType:"topsense-confirmed-purchase",companyId:String(id),
  purchaseStatus:"БЫЛА",shipped:Boolean(record.shipped),paid:Boolean(record.paid),
  qualified:Boolean(record.qualified),purchaseDealCount:Number(record.purchaseDealCount)||0,
  purchaseBasis:String(record.purchaseBasis||"").slice(0,240),
  purchaseItems:(record.purchaseItems||[]).slice(0,35).map(x=>String(x).slice(0,160)),
  purchaseDeals:(record.purchaseDeals||[]).slice(0,40),
  stageEvidence:(record.stageEvidence||[]).slice(0,8),
  purchaseAmount:Number.isFinite(record.purchaseAmount)?record.purchaseAmount:null,
  purchaseCurrency:String(record.purchaseCurrency||"").slice(0,8),
  amountStatus:String(record.amountStatus||"").slice(0,140),
  savedAt:new Date().toISOString()};
}
function ingest(rows){
 let count=0;
 for(const row of rows||[]){
  const key=String(row?.key||"");
  if(!/^sales:purchase:v1:[0-9]+$/.test(key))continue;
  const id=key.slice(PREFIX.length),p=row.payload;
  if(!positive(p)||String(p.companyId)!==id)continue;
  const before=saved.get(id);
  if(before&&Date.parse(before.savedAt||"")>Date.parse(p.savedAt||""))continue;
  saved.set(id,p);count++;
 }
 restored+=count;return count;
}
function get(id){return saved.get(String(id))||null}
function schedule(){
 if(timer||!pending.size)return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},5000);
 if(timer.unref)timer.unref();
}
function queue(records){
 let count=0;
 for(const [id,rec] of records||[]){
  if(!/^[0-9]+$/.test(String(id))||!rec||rec.purchaseStatus!=="БЫЛА"||
   !(rec.shipped||rec.paid||rec.qualified))continue;
  const value=sanitize(id,rec);
  // Avoid rewriting the same historical evidence on every successful scan.
  const prior=saved.get(String(id));
  if(prior&&JSON.stringify({...prior,savedAt:null})===JSON.stringify({...value,savedAt:null}))continue;
  pending.set(String(id),{key:PREFIX+String(id),payload:value});count++;
 }
 schedule();return count;
}
async function flush(){
 if(flushing||!pending.size)return;
 const url=String(process.env.GOOGLE_SHEET_STORE_URL||"").trim();
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim();
 if(!url||!secret){lastError="store_not_configured";return}
 flushing=true;
 const batch=[...pending.entries()].slice(0,12);
 for(const [id] of batch)pending.delete(id);
 try{
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch.map(([,row])=>row)}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();
  if(!response.ok||result?.ok===false)throw Error("purchase_checkpoint_write_failed");
  ingest(batch.map(([,row])=>row));stored+=batch.length;lastError="";
  console.log(JSON.stringify({component:"purchase-checkpoint",event:"purchase-evidence-saved",count:batch.length,total:saved.size}));
 }catch{
  errors++;lastError="checkpoint_failed";
  for(const [id,row] of batch)if(!pending.has(id))pending.set(id,row);
  console.warn(JSON.stringify({component:"purchase-checkpoint",event:"checkpoint-failed",count:batch.length}));
 }finally{flushing=false;if(pending.size)schedule()}
}
function stats(){return {loaded:saved.size,restored,stored,waiting:pending.size,errors,lastError}}
module.exports={PREFIX,positive,ingest,get,queue,flush,stats};

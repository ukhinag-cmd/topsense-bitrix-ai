"use strict";
// Durable identity of an ORIGINAL inbound sender domain for a deal-only
// analytical group. Does not write to Bitrix24 or call a paid model.
// Prevents a proven website type vanishing on Render restart.
const crypto=require("node:crypto");
const {senderDomain}=require("./sender-domain-site-proof");
const PREFIX="site-profile:v1:7";
const saved=new Map(),pending=new Map();
let stored=0,restored=0,errors=0,timer=null,flushing=false;
function key(id){
 const v=String(id||"");
 if(!v.startsWith("dealonly:"))return "";
 const hex=crypto.createHash("sha256").update(v).digest("hex").slice(0,12);
 return PREFIX+(parseInt(hex,16)%10000000000000).toString().padStart(13,"0");
}
function ingest(entries){
 let count=0;
 for(const row of entries||[]){
  const item=row?.payload,id=String(item?.id||"");
  if(!id.startsWith("dealonly:")||row?.key!==key(id)||
   item?.recordType!=="topsense-deal-only-sender-domain-v1"||
   !senderDomain(item.domain)||senderDomain(item.domain)!==item.domain)continue;
  saved.set(id,item.domain);count++;
 }
 restored+=count;return count;
}
function get(id){return saved.get(String(id||""))||""}
function remember(id,domain){
 const k=key(id),d=senderDomain(domain);
 if(!k||!d||saved.get(id)===d)return false;
 saved.set(id,d);
 pending.set(k,{key:k,payload:{recordType:"topsense-deal-only-sender-domain-v1",
  id:String(id),domain:d,verifiedFrom:"original_inbound_sender",
  observedAt:new Date().toISOString()}});
 if(!timer){timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},3000);
  timer.unref?.();}
 return true;
}
async function flush(){
 if(flushing||!pending.size)return;
 const url=String(process.env.GOOGLE_SHEET_STORE_URL||"");
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"");
 if(!url||!secret)return;
 flushing=true;
 const batch=[...pending.values()].slice(0,12);
 try{
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({action:"upsert",secret,rows:batch}),
   signal:AbortSignal.timeout(22000)});
  const j=await r.json();
  if(!r.ok||j?.ok===false)throw Error("sender_checkpoint_failure");
  for(const item of batch)pending.delete(item.key);
  stored+=batch.length;
  console.log(JSON.stringify({component:"deal-only-sender-ledger",event:"sender-domains-saved",count:batch.length,total:saved.size}));
 }catch(e){errors++;}
 finally{
  flushing=false;
  if(pending.size&&!timer){timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},30000);
   timer.unref?.();}
 }
}
function stats(){return {stored,restored,known:saved.size,pending:pending.size,errors}}
module.exports={key,ingest,get,remember,flush,stats};

"use strict";
const worklist=require("./qualification-review-worklist");
const crypto=require("node:crypto");
const KEY="review-worker:v1:checkpoint";
const done=new Map(),pending=new Map();
const intake=require("./crm-deal-intake");
let running=false,cycles=0,queued=0,checked=0,errors=0,lastAt=null,lastError="",dirty=false;
const toId=v=>String(v??"").trim();
function signature(c){return crypto.createHash("sha256").update(JSON.stringify([c.name,c.crmIdList||[c.id],c.latestCorrespondenceActivityId||"",c.siteVerified||c.siteProfileUrl||""])).digest("hex").slice(0,24)}
function ingest(rows){const p=(rows||[]).find(r=>r?.key===KEY)?.payload;if(!p||p.recordType!=="topsense-review-worker-checkpoint-v1"||!Array.isArray(p.seen))return 0;for(const item of p.seen){if(Array.isArray(item)&&/^\d+$/.test(String(item[0]))&&/^[0-9a-f]{24}$/.test(String(item[1])))done.set(String(item[0]),String(item[1]))}return done.size}
async function save(){const url=String(process.env.GOOGLE_SHEET_STORE_URL||""),secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"");if(!url||!secret)throw Error("checkpoint_unavailable");const payload={recordType:"topsense-review-worker-checkpoint-v1",seen:[...done],updatedAt:new Date().toISOString()};const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",secret,rows:[{key:KEY,payload}]}),signal:AbortSignal.timeout(25000)});const p=await r.json();if(!r.ok||p?.ok===false)throw Error("checkpoint_write_failed")}

async function deals(companyId,order="ASC"){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"").trim();
 if(!base||!/^\d+$/.test(companyId))throw Error("CRM read connection unavailable");
 const url=new URL("crm.deal.list.json",base.endsWith("/")?base:base+"/");
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({filter:{COMPANY_ID:Number(companyId)},order:{ID:order},
 select:["ID","COMPANY_ID","TITLE","DATE_CREATE","CONTACT_ID","STAGE_ID"],start:0}),
 signal:AbortSignal.timeout(18000)});
 const data=await response.json();
 if(!response.ok||data.error||!Array.isArray(data.result))throw Error("CRM deal list failed");
 return data.result.filter(x=>toId(x.COMPANY_ID)===companyId&&/^\d+$/.test(toId(x.ID))).slice(0,3);
}
async function tick(companies){
 if(running)return {status:"busy"};
 if(String(process.env.TOPSENSE_ANALYTICS_READONLY)!=="1")return {status:"read_only_required"};
 if(!Array.isArray(companies)||companies.length<500)return {status:"snapshot_not_ready"};
 running=true;lastAt=new Date().toISOString();cycles++;
 let inspected=0,submitted=0;
 try{
 const all=worklist.inspect(companies).items;
 let changed=false;
 for(const [id,p] of pending){
  if(p.dealIds.every(dealId=>Boolean(intake.get(dealId)))){
   done.set(id,p.signature);pending.delete(id);changed=true;dirty=true;
  }
 }
 for(const item of all){
  if(inspected>=3)break;
  const id=toId(item.id);
  if(pending.has(id))continue;
  const owner=companies.find(c=>(c.crmIdList||[c.id]).map(toId).includes(id));
  if(!owner||done.get(id)===signature(owner))continue;
  try{
   // Only deals explicitly linked to this CRM legal entity.
   const [oldest,newest]=await Promise.all([deals(id,"ASC"),deals(id,"DESC")]);
   const found=[...new Map([...oldest.slice(0,2),...newest.slice(0,2)].map(d=>[toId(d.ID),d])).values()];
   submitted+=intake.queueDeals(found);
   inspected++;checked++;
   if(found.length){pending.set(id,{signature:signature(owner),dealIds:found.map(d=>toId(d.ID))});}
   else{done.set(id,signature(owner));changed=true;dirty=true;}
  }catch(e){errors++;lastError=String(e.message||e).slice(0,100);break}
 }
 if(dirty){try{await save();dirty=false}catch(e){errors++;lastError=String(e.message||e).slice(0,100);}}
 queued+=submitted;
 const summary={component:"qualification-review-processor",event:"cycle",at:lastAt,
 inspected,submitted,totalChecked:checked,remaining:Math.max(0,all.length-done.size),errors};
 console.log(JSON.stringify(summary));return summary;
 }finally{running=false}
}
function stats(){return {cycles,queued,checked,errors,lastAt,lastError,checkpointed:done.size,inFlight:pending.size,checkpointWritePending:dirty}}
module.exports={tick,stats,ingest,signature};

"use strict";
const worklist=require("./qualification-review-worklist");
const intake=require("./crm-deal-intake");
let running=false,cycles=0,queued=0,checked=0,errors=0,lastAt=null,lastError="";
const done=new Set(),toId=v=>String(v??"").trim();
async function deals(companyId){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"").trim();
 if(!base||!/^\d+$/.test(companyId))throw Error("CRM read connection unavailable");
 const url=new URL("crm.deal.list.json",base.endsWith("/")?base:base+"/");
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({filter:{COMPANY_ID:Number(companyId)},order:{ID:"ASC"},
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
 for(const item of all){
  if(inspected>=3)break;
  const id=toId(item.id);
  if(done.has(id))continue;
  const owner=companies.find(c=>(c.crmIdList||[c.id]).map(toId).includes(id));
  if(!owner)continue;
  try{
   // Only deals explicitly linked to this CRM legal entity.
   const found=await deals(id);
   submitted+=intake.queueDeals(found);
   inspected++;done.add(id);checked++;
  }catch(e){errors++;lastError=String(e.message||e).slice(0,100);break}
 }
 queued+=submitted;
 const summary={component:"qualification-review-processor",event:"cycle",at:lastAt,
 inspected,submitted,totalChecked:checked,remaining:Math.max(0,all.length-done.size),errors};
 console.log(JSON.stringify(summary));return summary;
 }finally{running=false}
}
function stats(){return {cycles,queued,checked,errors,lastAt,lastError}}
module.exports={tick,stats};

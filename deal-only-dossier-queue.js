"use strict";
// Cyclic, bounded READ-ONLY examination of CRM-less historical customer deals.
// Process one oldest and one newest linked deal from each candidate group.
// Does not create CRM entities, send email, place paid model calls, or infer
// legal identity solely from a transaction subject.
const intake=require("./crm-deal-intake");
let next=0,lastAt=null,groupsConsidered=0,dealsSubmitted=0,cycles=0;
function select(clients,{perRun=60}={}){
 const cases=(clients||[]).filter(c=>c?.companyCardMissing&&
  Array.isArray(c.dealRefs)&&c.dealRefs.length);
 if(!cases.length)return [];
 const max=Math.max(1,Math.min(120,Math.floor(Number(perRun)||60)));
 const rows=[],seen=new Set();
 let explored=0;
 for(let i=0;i<cases.length&&rows.length<max;i++){
  const c=cases[(next+i)%cases.length];
  explored++;
  const ordered=c.dealRefs.slice().sort((a,b)=>
   Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0));
  // The first inquiry has identity clues; later messages can include
  // requisites/POs. Never assume that a request proves a purchase.
  const pair=ordered.length>1?[ordered[0],ordered[ordered.length-1]]:ordered;
  for(const d of pair){
   const id=String(d?.id||"");
   if(!/^[1-9]\d*$/.test(id)||seen.has(id)||intake.get(id))continue;
   seen.add(id);
   rows.push({ID:id,TITLE:String(d.title||"").slice(0,300),
    COMPANY_ID:"",CONTACT_ID:String(d.contactId||""),
    DATE_CREATE:String(d.createdAt||""),STAGE_ID:String(d.stageId||"")});
   if(rows.length>=max)break;
  }
 }
 next=(next+explored)%cases.length;
 groupsConsidered+=explored;
 return rows;
}
function tick(clients,opts){
 const chosen=select(clients,opts);
 const accepted=chosen.length?intake.queueDeals(chosen):0;
 cycles++;
 lastAt=new Date().toISOString();
 dealsSubmitted+=accepted;
 if(cycles%4===1||accepted){
  console.log(JSON.stringify({component:"deal-only-dossier-queue",
   event:"bounded-mail-analysis",groupsConsidered,submitted:accepted,
   overallSubmitted:dealsSubmitted,candidates:clients?.length||0}));
 }
 return accepted;
}
function stats(){return {cycles,lastAt,groupsConsidered,dealsSubmitted}}
module.exports={select,tick,stats};

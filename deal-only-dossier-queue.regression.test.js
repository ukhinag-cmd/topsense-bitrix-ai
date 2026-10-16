"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const intake=require("./crm-deal-intake");
const queue=require("./deal-only-dossier-queue");
const c=(id,refs)=>({id:"dealonly:discovered:"+id,
 companyCardMissing:true,name:"ООО «Промышленное предприятие "+id+"»",
 dealRefs:refs.map(([deal,at])=>({id:String(deal),
  title:"Заявка на ТОП-СЕНС",createdAt:at}))});
test("Bounded deep-read cycle selects first and latest deal of each unlinked client, no synthetic CRM writes",()=>{
 const prior=intake.get;
 try{
  intake.get=()=>null;
  const arr=[c("A",[[100,"2024-01-01"],[150,"2025-01-01"],[200,"2026-01-01"]]),
   c("B",[[300,"2026-01-02"],[320,"2026-02-02"]])];
  const got=queue.select(arr,{perRun:4});
  assert.deepEqual(got.map(x=>x.ID),["100","200","300","320"]);
  assert.ok(got.every(x=>x.COMPANY_ID===""));
  assert.ok(got.every(x=>x.TITLE==="Заявка на ТОП-СЕНС"));
 }finally{intake.get=prior}
});
test("Unverified single request, duplicate and malformed deal ID never create extra customer records",()=>{
 const old=intake.get;
 try{
  intake.get=x=>x==="910"?{id:"910"}:null;
  const arr=[c("C",[[910,"2025-01-01"],[911,"2025-03-01"]]),
   c("D",[[911,"2025-03-01"],[0,"2025-05-01"]]),
   {id:"dealonly:bad",companyCardMissing:false,dealRefs:[{id:"999"}]}];
  const rows=queue.select(arr,{perRun:8});
  assert.deepEqual(rows.map(x=>x.ID),["911"]);
 }finally{intake.get=old}
});

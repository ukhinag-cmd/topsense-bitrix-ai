"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const ledger=require("./classification-ledger");
function row(id,name,type,rank=4,date="2026-10-15T05:00:00.000Z"){
 return {key:ledger.PREFIX+id,payload:{
  recordType:"topsense-type-ledger-v1",companyId:id,
  identityHash:ledger.identity({id,name}),type,rank,
  source:"Проверенный сайт",confidence:"Предварительная",category:"Подрядчики",savedAt:date
 }};
}
const contractor="Промышленный генподрядчик";
const engineer="Интегратор АСУ ТП";
test("a saved company type survives a restart with the site profiler still empty",()=>{
 const name="ООО Заводская Интеграция";
 assert.equal(ledger.ingest([row("40001",name,contractor)]),1);
 const card={id:"40001",name,organizationType:"",siteStatus:"site_pending"};
 const restored=ledger.apply(card);
 assert.equal(restored.organizationType,contractor);
 assert.equal(restored.ledgerRestored,true);
 assert.equal(restored.siteStatus,"site_pending");
 assert.equal(restored.siteVerified||"","");
});
test("a type based only on the company name cannot override stronger stored site evidence",()=>{
 const x=ledger.apply({id:"40001",name:"ООО Заводская Интеграция",
  organizationType:engineer,segmentSource:"Название CRM, без подтверждения сайтом",siteStatus:"site_pending"});
 assert.equal(x.organizationType,contractor);
});
test("a new verified first-party site may supersede old preliminary type",()=>{
 const name="ООО Заводская Интеграция";
 const c={id:"40001",name,organizationType:engineer,siteStatus:"official_site_verified",
  segmentSource:"Подтверждено официальным сайтом"};
 assert.equal(ledger.apply(c).organizationType,engineer);
});
test("company identity changes do not silently carry classification to another legal entity",()=>{
 const value=ledger.apply({id:"40001",name:"ДРУГАЯ ОРГАНИЗАЦИЯ",
  organizationType:"",siteStatus:"site_pending"});
 assert.equal(value.organizationType,"");
 assert.equal(ledger.get("40001").type,contractor);
});
test("never persist a missing type, wrong company ID or fictional subtype",()=>{
 assert.equal(ledger.offer({id:"4",name:"Новая",organizationType:""}),false);
 assert.equal(ledger.ingest([{...row("40001","ООО Заводская Интеграция",contractor),key:ledger.PREFIX+"40002"}]),0);
 assert.equal(ledger.offer({id:"5",name:"Компания",organizationType:"Придуманный тип"}),false);
});
test("enriched website type can be queued for permanent per-company storage",()=>{
 const c={id:"40002",name:"ООО Приборстрой",organizationType:engineer,
  segmentSource:"Деятельность с официального сайта",siteStatus:"site_profiled"};
 assert.equal(ledger.offer(c),true);
 assert.equal(ledger.offer(c),false);
});

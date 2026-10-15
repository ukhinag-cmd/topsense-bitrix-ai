"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const site=require("./website-profiler");
const infer=require("./client-type-inference");
const store=require("./site-profile-store");
const existingGet=site.get;
test("unverified legal-name website provides explicitly provisional activity type, not verified ownership",()=>{
 try{
  site.get=()=>({status:"site_preliminary_profiled",
   source:"Поиск по юридическому наименованию — предварительно",
   url:"https://example-industrial.ru",
   siteType:"Промышленный генподрядчик",
   siteActivityReason:"Компания выполняет подрядные работы"});
  const c={id:"811111",name:"ООО НЕВСКАЯ СЕРВИСНАЯ КОМПАНИЯ",
   category:"Не определены",crmEmails:[],organizationType:""};
  const result=infer.apply([c])[0];
  assert.equal(result.organizationType,"Промышленный генподрядчик");
  assert.equal(result.siteStatus,"site_preliminary_profiled");
  assert.equal(result.siteIdentityVerified,false);
  assert.equal(result.siteCandidate,"https://example-industrial.ru");
  assert.equal(result.siteProfileUrl,"");
  assert.equal(result.siteVerified,undefined);
  assert.match(result.segmentConfidence,/принадлежность сайта не подтверждена/);
  assert.equal(result.verification,"Предварительная классификация");
 }finally{site.get=existingGet}
});
test("a provisional source can be checkpointed but must remain provisional on restore",()=>{
 const c={id:"811111",name:"ООО НЕВСКАЯ СЕРВИСНАЯ КОМПАНИЯ",
  siteCandidate:"https://example-industrial.ru",
  siteSource:"Поиск по юридическому наименованию — предварительно"};
 const p={status:"site_preliminary_profiled",url:"https://example-industrial.ru",
  siteType:"Промышленный генподрядчик",siteConfidence:"Предварительная: нет реквизитов",
  checkedAt:new Date().toISOString()};
 const record={recordType:"topsense-site-profile",companyId:c.id,
  fingerprint:store.fingerprint(c),checkedAt:p.checkedAt,profile:p};
 assert.equal(store.fresh(record),true);
 assert.equal(store.restored(c,record).status,"site_preliminary_profiled");
 assert.equal(store.fresh({...record,profile:{...p,status:"site_preliminary_profiled",siteType:""}}),false);
});
test("a current unverified source never reclassifies a previously verified organization",()=>{
 try{
  site.get=()=>({status:"site_preliminary_profiled",siteType:"Промышленный генподрядчик",
   url:"https://possible.example.ru"});
  const c={id:"811112",name:"АО ХИМИЧЕСКИЙ ЗАВОД",
   organizationType:"Нефтехимическое / химическое предприятие",
   type:"Нефтехимическое / химическое предприятие",
   siteVerified:"https://chemical.example.ru"};
  const r=infer.apply([c])[0];
  assert.equal(r.organizationType,"Нефтехимическое / химическое предприятие");
  assert.equal(r.siteVerified,"https://chemical.example.ru");
 }finally{site.get=existingGet}
});
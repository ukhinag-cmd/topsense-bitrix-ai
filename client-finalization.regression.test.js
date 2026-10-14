"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {types}=require("./company-types");
function freshModule(){
 const path=require.resolve("./client-finalization");
 delete require.cache[path];
 return require("./client-finalization");
}
function sample(){
 return {id:"501",name:"ООО Тестовый нефтесервис",organizationType:types.find(t=>t.name==="Промышленный сервис / техническая эксплуатация").name,
  siteStatus:"official_site_verified",siteVerified:"https://example.org",
  category:"Подрядчики",segmentConfidence:"Высокая — официальный сайт",
  segmentSource:"Официальный сайт: проверены реквизиты",
  verification:"Подтверждено официальным сайтом",
  contactEmails:["buyer@example.org"],contactNames:["Контакт компании"],
  saleInfo:{purchaseStatus:"НЕ БЫЛО",linkedDeals:[]}};
}
function context(){return {contactsAt:new Date().toISOString(),salesStatus:"complete",duplicateIds:new Set()}}
test("Cannot finalize based on name-only, missing site, missing contact, unknown purchases, or incomplete sales",()=>{
 const {criteria}=freshModule(),c=sample();
 assert.equal(criteria(c,context()).complete,true);
 assert.equal(criteria({...c,siteStatus:"site_pending"},context()).complete,false);
 assert.equal(criteria({...c,contactEmails:[],contactNames:[]},context()).complete,false);
 assert.equal(criteria(c,{...context(),salesStatus:"partial"}).complete,false);
 assert.equal(criteria({...c,saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ"}},context()).complete,false);
 assert.equal(criteria(c,{...context(),duplicateIds:new Set(["501"])}).complete,false);
 assert.equal(criteria({...c,verification:"AI — требует проверки"},context()).complete,false);
 assert.equal(criteria({...c,organizationType:"Придуманный тип"},context()).complete,false);
});
test("Closed research survives ingestion and still allows new contacts, deals and sales to change",()=>{
 const locker=freshModule(),c=sample(),stamp=locker.identity(c);
 const row={key:"client:completed:v1:501",payload:{recordType:"topsense-company-research-complete",companyId:"501",
  identityHash:stamp,organizationType:c.organizationType,siteUrl:"https://example.org",
  category:"Подрядчики",completedAt:"2026-10-14T08:00:00Z"}};
 assert.equal(locker.ingest([row]),1);
 assert.equal(locker.isComplete("501"),true);
 const now={...c,organizationType:"",siteVerified:"https://unknown.example",
  contactEmails:["new@example.org"],saleInfo:{purchaseStatus:"БЫЛА",paid:true,purchaseDeals:[{id:"123"}]}};
 const result=locker.apply(now);
 assert.equal(result.organizationType,c.organizationType);
 assert.equal(result.siteProfileUrl,"https://example.org");
 assert.deepEqual(result.contactEmails,["new@example.org"]);
 assert.equal(result.saleInfo.paid,true);
 assert.equal(result.saleInfo.purchaseDeals[0].id,"123");
 assert.equal(locker.queue(c,context()),false);
});
test("Immutable completion checkpoint is private, minimal, durable and stops re-queuing",async()=>{
 const locker=freshModule(),c=sample();
 const oldEnv={url:process.env.GOOGLE_SHEET_STORE_URL,secret:process.env.GOOGLE_SHEET_STORE_SECRET};
 const oldFetch=global.fetch;const items=[];
 try{
  process.env.GOOGLE_SHEET_STORE_URL="https://private-store.example";
  process.env.GOOGLE_SHEET_STORE_SECRET="test-only";
  global.fetch=async (_u,options)=>{
   const payload=JSON.parse(options.body);
   assert.equal(payload.action,"upsert");
   items.push(...payload.rows);
   return{ok:true,json:async()=>({ok:true})};
  };
  assert.equal(locker.queue(c,context()),true);
  await locker.flush();
  assert.equal(items.length,1);
  const payload=items[0].payload;
  assert.equal(payload.companyId,c.id);
  assert.equal(payload.siteUrl,"https://example.org");
  assert.equal("contactEmails" in payload,false);
  assert.equal("saleInfo" in payload,false);
  assert.equal("crmPhones" in payload,false);
  assert.equal(locker.isComplete(c.id),true);
 }finally{
  global.fetch=oldFetch;
  if(oldEnv.url===undefined)delete process.env.GOOGLE_SHEET_STORE_URL;
  else process.env.GOOGLE_SHEET_STORE_URL=oldEnv.url;
  if(oldEnv.secret===undefined)delete process.env.GOOGLE_SHEET_STORE_SECRET;
  else process.env.GOOGLE_SHEET_STORE_SECRET=oldEnv.secret;
 }
});

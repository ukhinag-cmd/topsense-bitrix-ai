"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const naming=require("./client-canonical-name");
const ledger=require("./deal-only-name-ledger");
const intake=require("./crm-deal-intake");
const registry=require("./deal-only-client-registry");
const group=require("./crm-unlinked-discovery");
test("messy initial deal title upgrades to independently corroborated legal name and retains stable client ID",()=>{
 const before={id:"dealonly:discovered:ис16",name:"ИС-16",
  rawName:"ИС-16",dealRefs:[{id:"11266"},{id:"13466"}],
  saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ"}};
 const after=naming.resolve(before,[{legalName:"ООО «Инжиниринговые системы-16»",
  inn:"8603223202",source:"official_website_and_inn",sourceRef:"https://is-16.su/requisites",
  verified:true}]);
 assert.equal(after.id,before.id);
 assert.equal(after.name,"ООО «ИНЖИНИРИНГОВЫЕ СИСТЕМЫ-16»");
 assert.equal(after.nameStatus,"legal_name_verified");
 assert.equal(after.identityVerified,true);
 assert.deepEqual(after.dealRefs,before.dealRefs);
 assert.deepEqual(after.saleInfo,before.saleInfo);
 assert.ok(after.aliases.includes("ИС-16"));
});
test("missing legal-form evidence never invents an ООО or other OPF",()=>{
 const v=naming.resolve({id:"dealonly:discovered:вектор",name:"ВЕКТОР",rawName:"Вектор"},[]);
 assert.equal(v.name,"ВЕКТОР");
 assert.equal(v.nameStatus,"deal_title_provisional");
 assert.equal(naming.parse(v.name),null);
});
test("first and follow-up emails can carry legal name and requisites later than the initial inquiry",()=>{
 const emails=[
  {ID:"10",TYPE_ID:"4",DIRECTION:"1",DESCRIPTION:"Здравствуйте, нужен газоанализатор ТОП-СЕНС 310"},
  {ID:"11",TYPE_ID:"4",DIRECTION:"2",DESCRIPTION:"Предлагаем прибор, направляем КП"},
  {ID:"12",TYPE_ID:"4",DIRECTION:"1",
   DESCRIPTION:"Наименование организации: ООО «Инжиниринговые системы-16» ИНН: 8603223202\nАдрес: Нижневартовск"}
 ];
 const summary=intake.summarizeActivities(emails);
 assert.equal(summary.legalNameCandidates.length,1);
 assert.equal(summary.legalNameCandidates[0].activityId,"12");
 assert.equal(summary.legalNameCandidates[0].inn,"8603223202");
 const c=naming.resolve({id:"dealonly:discovered:ис16",name:"ИС-16",dealRefs:[{id:"42"}]},
  naming.fromIntake([{id:"42"}],()=>({legalNameCandidates:summary.legalNameCandidates})));
 assert.equal(c.name,"ООО «ИНЖИНИРИНГОВЫЕ СИСТЕМЫ-16»");
 assert.equal(c.nameStatus,"legal_name_from_incoming_requisites");
 assert.equal(c.identityVerified,false);
});
test("third-party or conflicting legal names cannot silently override an already named client",()=>{
 const initial={id:"dealonly:discovered:гспремонт",name:"ООО «ГСП Ремонт»"};
 const rejected=naming.resolve(initial,[{
  legalName:"АО «ГСП-7»",source:"incoming_email_requisites",
  sourceRef:"CRM activity 100"}]);
 assert.equal(rejected.name,initial.name);
 assert.equal(rejected.nameStatus,"identity_conflict");
 const conflicting=naming.resolve(initial,[
  {legalName:"ООО «ГСП Ремонт»",source:"official_website_and_inn",inn:"7737106202",
   verified:true,sourceRef:"https://gsp-r.ru/requisites"},
  {legalName:"АО «ГСП-7»",source:"official_website_and_inn",inn:"7737106203",
   verified:true,sourceRef:"https://gsp-7.ru/requisites"}
 ]);
 assert.equal(conflicting.name,initial.name);
 assert.equal(conflicting.nameStatus,"identity_conflict");
});
test("durable private name records survive an ingest/restore cycle and do not lose aliases or purchase history",()=>{
 const id="dealonly:discovered:недостройэкспорт";
 const initial={id,name:"НЕДОСТРОЙЭКСПОРТ",dealRefs:[{id:"100"},{id:"101"}],
  saleInfo:{paid:true,purchaseStatus:"БЫЛА"}};
 const confirmed=naming.resolve(initial,[{
  legalName:"ООО «Северные инжиниринговые системы»",
  source:"independent_manual_review",verified:true,
  sourceRef:"Official site + CRM INN/phone compared"}]);
 assert.equal(confirmed.nameStatus,"legal_name_verified");
 assert.equal(ledger.offer(confirmed),true);
 const key=ledger.keyFor(id);
 const restoredRow={key,payload:{recordType:"topsense-deal-only-canonical-name",
  id,identityHash:require("node:crypto").createHash("sha256").update(id).digest("hex"),
  canonicalName:confirmed.name,nameStatus:"legal_name_verified",verified:true,
  inn:"",aliases:confirmed.aliases,nameEvidence:confirmed.nameEvidence,
  savedAt:"2026-10-15T10:30:00.000Z"}};
 assert.equal(ledger.ingest([restoredRow]),1);
 const result=ledger.apply(initial);
 assert.equal(result.name,confirmed.name);
 assert.equal(result.id,id);
 assert.deepEqual(result.dealRefs,initial.dealRefs);
 assert.deepEqual(result.saleInfo,initial.saleInfo);
 assert.ok(result.aliases.includes("НЕДОСТРОЙЭКСПОРТ"));
});
test("name ledger rejects tampered mapping and refuses to replace verified names with weaker evidence",()=>{
 const id="dealonly:discovered:неправильнаягруппа";
 const wrong={key:ledger.keyFor(id),payload:{
  recordType:"topsense-deal-only-canonical-name",id,
  canonicalName:"ООО «Другая компания»",nameStatus:"legal_name_verified",
  identityHash:"bad",verified:true,savedAt:"2026-10-15T10:30:00Z"}};
 assert.equal(ledger.ingest([wrong]),0);
 const row=ledger.apply({id,name:"Неправильная группа"});
 assert.equal(row.name,"Неправильная группа");
});

test("generic deal title can discover a legally named company from a subsequent inbound email",()=>{
 const original=intake.get;
 try{
  group.ingest([
   {ID:"80701",TITLE:"Запрос стоимости газоанализатора",COMPANY_ID:"0",DATE_CREATE:"2025-11-12T12:00:00+03:00"},
   {ID:"80702",TITLE:"Переносной газоанализатор — уточнение срока",COMPANY_ID:"0",DATE_CREATE:"2025-11-13T12:00:00+03:00"}
  ],{complete:true});
  intake.get=id=>id==="80701"?{legalNameCandidates:[
   {name:"ООО «Региональный технический центр»",activityId:"18",inn:""}]}:
   {legalNameCandidates:[{name:"ООО «Региональный технический центр»",activityId:"36",inn:""}]};
  const found=group.group([]);
  const c=found.find(x=>x.key==="региональный технический центр");
  assert.ok(c);
  assert.equal(c.dealCount,2);
  const cards=registry.view([]);
  const card=cards.find(x=>x.id==="dealonly:discovered:региональный технический центр");
  assert.ok(card);
  assert.equal(card.name,"ООО «РЕГИОНАЛЬНЫЙ ТЕХНИЧЕСКИЙ ЦЕНТР»");
  assert.equal(card.nameStatus,"legal_name_from_incoming_requisites");
  assert.deepEqual(card.dealRefs.map(x=>x.id).sort(),["80701","80702"]);
 }finally{intake.get=original}
});

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
test("new site research cannot silently supersede previously qualified type",()=>{
 const name="ООО Заводская Интеграция";
 const c={id:"40001",name,organizationType:engineer,siteStatus:"official_site_verified",
  segmentSource:"Подтверждено официальным сайтом"};
 assert.equal(ledger.apply(c).organizationType,contractor);
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

test("verified original inbound letter upgrades only provisional earlier type",()=>{
 const name="ООО Точная Компания",id="40003";
 assert.equal(ledger.ingest([row(id,name,engineer,1)]),1);
 const preliminary=ledger.apply({id,name,organizationType:engineer,siteStatus:"site_pending"});
 assert.equal(preliminary.organizationType,engineer);
 assert.equal(preliminary.classificationFrozen,false);
 assert.equal(preliminary.classificationProvisional,true);
 const verified={id,name,organizationType:contractor,
  researchStatus:"inbound_self_description_qualified",
  segmentSource:"Собственная деятельность в письме сделки 40 (активность 101), совпадает ИНН из реквизитов",
  segmentConfidence:"Высокая — исходное входящее письмо с ИНН и юридическим наименованием",
  verification:"Собственное заявление компании с подтверждённым совпадением ИНН"};
 assert.equal(ledger.apply(verified).organizationType,contractor);
 assert.equal(ledger.offer(verified),true);
 assert.equal(ledger.offer(verified),false);
 assert.equal(ledger.apply({...verified,name:"ДРУГАЯ КОМПАНИЯ"}).organizationType,"");
});
test("a frozen verified type never changes even with new original letter evidence",()=>{
 const name="ООО Проверенный Подрядчик",id="40004";
 assert.equal(ledger.ingest([row(id,name,contractor,5)]),1);
 const fresh={id,name,organizationType:engineer,
  researchStatus:"inbound_self_description_qualified",
  segmentSource:"Собственная деятельность в письме сделки 99, совпадает ИНН из реквизитов",
  verification:"Собственное заявление компании с подтверждённым совпадением ИНН"};
 assert.equal(ledger.apply(fresh).organizationType,contractor);
 assert.equal(ledger.offer(fresh),false);
});

test("CRM website alone never freezes a new company type",()=>{
 const id="49901",name="ООО Пример";
 const candidate={id,name,organizationType:engineer,siteStatus:"site_profiled",
  siteSource:"Сайт из CRM",segmentSource:"Деятельность в профильных разделах сайта",
  segmentConfidence:"Подтверждено профильными разделами"};
 assert.equal(ledger.rank(candidate),3);
 assert.equal(ledger.offer(candidate),true);
 const legacy={id:"49902",name,organizationType:contractor,
  siteStatus:"official_site_verified",verifiedOrgType:contractor,
  siteSource:"Официальный сайт, проверенный по юридическим данным"};
 assert.equal(ledger.rank(legacy),5);
});
test("historical site-only locks remain unchanged and flagged for audit",()=>{
 const id="49903",name="ООО Контрагент";
 assert.equal(ledger.ingest([row(id,name,contractor,4)]),1);
 const old=ledger.apply({id,name,organizationType:engineer});
 assert.equal(old.organizationType,contractor);
 assert.equal(old.classificationFrozen,true);
 assert.equal(old.classificationNeedsLegalReview,true);
 assert.equal(old.classificationVerified,false);
});

test("legacy website type can be corroborated only with identical sender-domain type",()=>{
 const id="49911",name="ООО Тестовый Сервис",type=contractor;
 assert.equal(ledger.ingest([row(id,name,type,4)]),1);
 const proof={id,name,organizationType:type,type,
  researchStatus:"mail_domain_site_qualified",
  siteStatus:"site_profiled",siteIdentityVerified:true,
  siteSource:"Домен отправителя входящего письма",
  emailSenderDomain:"verified.example",
  siteProfileUrl:"https://verified.example",
  segmentConfidence:"Подтверждено — домен входящего отправителя совпал с сайтом"};
 const corroborated=ledger.apply(proof);
 assert.equal(corroborated.organizationType,type);
 assert.equal(corroborated.pendingEvidenceUpgrade,true);
 assert.equal(ledger.offer(corroborated),true);
 assert.equal(ledger.offer(corroborated),false);
 const conflict=ledger.apply({...proof,organizationType:engineer});
 assert.equal(conflict.organizationType,type);
 assert.equal(ledger.offer({...proof,organizationType:engineer}),false);
});

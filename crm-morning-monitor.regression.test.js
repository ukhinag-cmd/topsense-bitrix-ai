"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");
const crypto=require("node:crypto");
const monitor=require("./crm-morning-monitor");
const ledger=require("./classification-ledger");
const intake=require("./crm-deal-intake");
const id="917260";
function saved(name,type,at="2026-10-15T06:05:00Z"){
 return {recordType:"topsense-type-ledger-v1",companyId:id,
  identityHash:crypto.createHash("sha256").update(id+"|"+name.toLowerCase()).digest("hex"),
  type,companyName:name,category:"Подрядчики",rank:3,
  source:"Проверенная деятельность предприятия",confidence:"Подтверждено",
  verification:"Сверено",siteUrl:"https://factory.example/",
  savedAt:at};
}
test("Qualified company type/site/name cannot be changed by fresh website scan or manual CRM edit",()=>{
 ledger.ingest([{key:ledger.PREFIX+id,payload:saved("ООО Тестовое предприятие","Монтажно-строительная организация")}]);
 const altered=ledger.apply({id,name:"ООО Исправленный менеджером",
  organizationType:"Дилер промышленного оборудования",
  category:"Партнёрские продажи",siteVerified:"https://wrong.example/",
  segmentSource:"Новое совпадение по сайту"});
 assert.equal(altered.organizationType,"");
 assert.equal(altered.name,"ООО Исправленный менеджером");
 assert.equal(altered.previousQualifiedType,"Монтажно-строительная организация");
 assert.equal(altered.companyIdentityReviewRequired,true);
 const original=ledger.apply({id,name:"ООО Тестовое предприятие",
  organizationType:"Дилер промышленного оборудования",
  siteVerified:"https://wrong.example/"});
 assert.equal(original.organizationType,"Монтажно-строительная организация");
 assert.equal(original.siteVerified,"https://factory.example/");
 assert.equal(original.classificationFrozen,true);
 assert.equal(ledger.offer({...original,organizationType:"Производитель КИПиА / датчиков"}),false);
});
test("Daily change policy is Moscow-local 08:00 and distinguishes email from calls",()=>{
 assert.equal(monitor.hour(new Date("2026-10-16T04:59:00Z")),7);
 assert.equal(monitor.hour(new Date("2026-10-16T05:00:00Z")),8);
 assert.equal(monitor.isCorrespondence({TYPE_ID:4}),true);
 assert.equal(monitor.isCorrespondence({TYPE_ID:2,PROVIDER_ID:"VOXIMPLANT_CALL"}),false);
 assert.equal(monitor.isCorrespondence({TYPE_ID:6,PROVIDER_ID:"IMOPENLINES_SESSION"}),true);
 assert.deepEqual(monitor.ownerBindings({OWNER_TYPE_ID:2,OWNER_ID:90,BINDINGS:[
  {OWNER_TYPE_ID:4,OWNER_ID:10}]}).map(x=>x.type),[4,2]);
});
test("Morning scan counts new deals but revisits only old customer email threads, never edits Bitrix",async()=>{
 const prevFetch=global.fetch,oldQueue=intake.queueDeals;
 const priorEnv={BITRIX_WEBHOOK_BASE:process.env.BITRIX_WEBHOOK_BASE,
  GOOGLE_SHEET_STORE_URL:process.env.GOOGLE_SHEET_STORE_URL,
  GOOGLE_SHEET_STORE_SECRET:process.env.GOOGLE_SHEET_STORE_SECRET};
 process.env.BITRIX_WEBHOOK_BASE="https://example.bitrix24.ru/rest/test/";
 process.env.GOOGLE_SHEET_STORE_URL="https://private.test/";
 process.env.GOOGLE_SHEET_STORE_SECRET="test";
 const methods=[],savedRows=[],queued=[];
 const asResponse=x=>({ok:true,status:200,json:async()=>x});
 global.fetch=async(url,opts)=>{
  const target=String(url),b=JSON.parse(opts.body);
  if(target==="https://private.test/"){
   if(b.action==="load")return asResponse({ok:true,rows:[]});
   if(b.action==="upsert"){savedRows.push(...b.rows);return asResponse({ok:true})}
   throw Error("unknown store action");
  }
  const method=target.match(/\/([^/]+)\.json$/)?.[1]||"";
  methods.push({method,params:b});
  if(method==="crm.deal.list")return asResponse({result:[
   {ID:100012,TITLE:"Новый запрос без переписки",COMPANY_ID:201,DATE_CREATE:"2026-10-16T04:10:00Z"}]});
  if(method==="crm.activity.list")return asResponse({result:[
   {ID:500019,TYPE_ID:4,PROVIDER_ID:"EMAIL",OWNER_TYPE_ID:2,OWNER_ID:123,
    CREATED:"2026-10-16T04:30:00Z",SUBJECT:"Письмо менеджера"},
   {ID:500020,TYPE_ID:2,PROVIDER_ID:"VOXIMPLANT_CALL",OWNER_TYPE_ID:2,OWNER_ID:144,
    CREATED:"2026-10-16T04:31:00Z"}]});
  if(method==="crm.deal.get")return asResponse({result:{
   ID:123,COMPANY_ID:77,TITLE:"Старая сделка",DATE_CREATE:"2024-03-01T04:00:00Z"}});
  throw Error("Unexpected CRM method "+method);
 };
 intake.queueDeals=(deals,opts)=>{queued.push({deals,opts});return deals.length};
 try{
  const early=await monitor.tick(new Date("2026-10-16T04:59:00Z"));
  assert.equal(early.status,"not_due");
  const out=await monitor.tick(new Date("2026-10-16T05:01:00Z"));
  assert.equal(out.status,"complete");
  assert.equal(out.newDeals,1);
  assert.equal(out.newMessages,1);
  assert.equal(out.companiesWithMessages,1);
  assert.equal(out.linkedDealsQueued,1);
  assert.deepEqual(queued[0].deals.map(d=>String(d.ID)),["123"]);
  assert.equal(queued[0].opts.force,true);
  assert.equal(monitor.forCompany("77").status,"new_correspondence_requires_evidence_review");
  assert.equal(savedRows.length,1);
  assert.equal(savedRows[0].key,monitor.KEY);
  assert.ok(methods.every(x=>!/\.(add|update|delete)$/.test(x.method)));
  const again=await monitor.tick(new Date("2026-10-16T07:30:00Z"));
  assert.equal(again.status,"not_due");
 }finally{
  global.fetch=prevFetch;intake.queueDeals=oldQueue;
  for(const [k,v] of Object.entries(priorEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v}
 }
});
test("Main server schedules daily change scanner with no paid AI and keeps Bitrix strictly READ-ONLY",()=>{
 const server=fs.readFileSync("server.js","utf8");
 assert.match(server,/function dailyReadOnlyCrmChanges/);
 assert.match(server,/crm-morning-monitor/);
 const intakeSource=fs.readFileSync("crm-deal-intake.js","utf8");
 assert.match(intakeSource,/function queueDeals\(deals,\{force=false\}/);
 const dashboard=fs.readFileSync("crm-dashboard.js","utf8");
 assert.match(dashboard,/crmMorningMonitor:/);
});

test("Deal intake honors forced re-inspection only when new correspondence was seen",()=>{
 const source=fs.readFileSync("crm-deal-intake.js","utf8");
 assert.match(source,/function queueDeals\(deals,\{force=false\}=\{\}\)/);
 assert.match(source,/if\(\(visited\.has\(id\)&&!force\)\|\|pending\.has\(id\)\)continue/);
 assert.match(source,/if\(force\)visited\.delete\(id\)/);
});

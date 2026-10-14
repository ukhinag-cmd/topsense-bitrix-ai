"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const overview=require("./client-overview");
const details=require("./client-segments");
const type="Промышленный генподрядчик";
const seed={id:"4010",name:"ООО Промышленный Генподряд",organizationType:type,category:"Подрядчики",
 crmIdList:["4010"],crmUrl:"https://topsense.bitrix24.ru/crm/company/details/4010/",saleInfo:{}};
function page(info){return overview.render({companies:[{...seed,...info}],status:"ready"},"Обзор",type,"1")}
function detailed(info){return details.html({companies:[{...seed,...info}],status:"ready"})}
test("Verified website appears visibly as an address and clickable company title",()=>{
 const info={siteProfileUrl:"https://contractor.example/works",siteStatus:"site_profiled"};
 const output=page(info);
 assert.ok(output.includes("Сайт изучен"));
 assert.ok(output.includes("Сайт: <a"));
 assert.ok(output.includes("contractor.example ↗"));
 assert.ok(output.includes("https://contractor.example/works"));
 assert.ok(output.includes("Открыть в Bitrix24 ↗"));
});
test("A corporate domain or CRM candidate is visible, but NOT called a verified website",()=>{
 for(const info of [
  {corporateDomain:"contractor.example",siteStatus:"site_absent"},
  {siteCandidate:"https://contractor.example",siteStatus:"site_pending"}
 ]){
  const output=page(info);
  assert.ok(output.includes("Сайт-кандидат · требует подтверждения"));
  assert.ok(output.includes("contractor.example ↗"));
  assert.ok(!output.includes("Сайт изучен"));
 }
});
test("Missing website never creates an invented URL",()=>{
 const output=page({siteStatus:"site_absent"});
 assert.ok(output.includes("Сайт не найден"));
 assert.ok(!output.includes('class="websiteAddress"'));
 assert.ok(output.includes("Открыть в Bitrix24"));
});
test("Detailed company list carries same explicit URL and trust status",()=>{
 const verified=detailed({siteProfileUrl:"https://contractor.example",siteStatus:"site_profiled"});
 const pending=detailed({siteCandidate:"https://contractor.example",siteStatus:"site_pending"});
 assert.ok(verified.includes("Сайт: <a"));
 assert.ok(verified.includes("contractor.example"));
 assert.ok(verified.includes("изучен"));
 assert.ok(pending.includes("не подтверждён"));
 assert.ok(pending.includes("contractor.example"));
});

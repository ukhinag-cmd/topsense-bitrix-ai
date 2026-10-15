"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const crypto=require("node:crypto");
const ledger=require("./deal-only-site-ledger");
test("site verified after legal INN matching survives restore with stable synthetic client ID",()=>{
 const id="dealonly:discovered:инжиниринговыесистемы16";
 const c={id,name:"ООО «Инжиниринговые системы-16»",
  dealRefs:[{id:"100"}],saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ"}};
 const mockResult={status:"confirmed",site:"https://is-16.su",note:"Совпали: ИНН, телефон"};
 const mockWebsite={status:"site_profiled",siteType:"Инжиниринговая компания",
  siteTitle:"ИС-16",siteDescription:"Проектирование и инжиниринг"};
 assert.equal(ledger.offer(c,mockResult,mockWebsite),true);
 const key=ledger.keyFor(id);
 assert.match(key,/^site-profile:v1:96\d{10}$/);
 const row={key,payload:{recordType:"topsense-deal-only-site-v1",
   id,confirmed:true,site:"https://is-16.su",stage:"profile_read",
   siteType:"Инжиниринговая компания",siteTitle:"ИС-16",
   siteDescription:"Проектирование и инжиниринг",proof:"Совпали: ИНН, телефон",
   checkedAt:"2026-10-15T10:00:00.000Z"}};
 assert.equal(ledger.ingest([row]),1);
 const restored=ledger.apply(c);
 assert.equal(restored.id,id);
 assert.equal(restored.siteCandidate,"https://is-16.su");
 assert.equal(restored.organizationType,"Инжиниринговая компания");
 assert.equal(restored.siteStatus,"site_profiled");
 assert.deepEqual(restored.dealRefs,c.dealRefs);
});
test("mere corporate group site hint cannot be saved as verified subsidiary site",()=>{
 const c={id:"dealonly:holding:test",name:"ООО ГСП-7"};
 assert.equal(ledger.offer(c,{status:"needs_review",site:"https://gsprom.ru"},null),false);
 const falsified={key:ledger.keyFor(c.id),payload:{id:c.id,
  recordType:"topsense-deal-only-site-v1",confirmed:false,
  site:"https://gsprom.ru",stage:"profile_read",checkedAt:"2026-10-15T10:00:00Z"}};
 assert.equal(ledger.ingest([falsified]),0);
});
test("current independently confirmed website beats an older stored URL",()=>{
 const id="dealonly:discovered:инжиниринговыесистемы16";
 const c={id,name:"ООО «Инжиниринговые системы-16»",
  websiteResearch:{status:"confirmed",checkedSite:"https://newsite.su"}};
 const observed=ledger.apply(c);
 assert.equal(observed.websiteResearch.checkedSite,"https://newsite.su");
 assert.equal(observed.siteCandidate,undefined);
});

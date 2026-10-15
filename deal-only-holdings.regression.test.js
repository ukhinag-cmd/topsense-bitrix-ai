"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const deals=require("./deal-only-client-registry"),groups=require("./holding-network");
test("CRM clients absent from manually entered company cards still appear by original deals",()=>{
 deals.ingest(new Map([
  ["10102",{ID:"10102",TITLE:'ООО "АВТОМАТИЗАЦИЯ И БЕЗОПАСНОСТЬ" для тендера',COMPANY_ID:"0",DATE_CREATE:"2025-01-16T14:12:17+03:00"}],
  ["12210",{ID:"12210",TITLE:"Автоматизация и Безопасность ТС-310ст-4шт",COMPANY_ID:"0",DATE_CREATE:"2025-01-20T12:10:06+03:00"}],
  ["23642",{ID:"23642",TITLE:"ПАО АКРОН замена сенсора",COMPANY_ID:"0",DATE_CREATE:"2025-06-24T12:16:38+03:00"}],
  ["24434",{ID:"24434",TITLE:"ГК АКРОН ХОЛДИНГ: закупка анализатора",COMPANY_ID:"0"}]
 ]),{complete:true});
 const out=deals.view([]);
 assert.equal(out.length,3);
 const automation=out.find(x=>x.id.includes("automation-security"));
 const acron=out.find(x=>x.id.includes("acron-fertilizers"));
 const akronHolding=out.find(x=>x.id.includes("akron-industrial-holding"));
 assert.deepEqual(automation.dealRefs.map(x=>x.id).sort(),["10102","12210"]);
 assert.equal(automation.companyCardMissing,true);
 assert.equal(automation.relationshipPotential.userConfirmed,true);
 assert.deepEqual(acron.dealRefs.map(x=>x.id),["23642"]);
 assert.deepEqual(akronHolding.dealRefs.map(x=>x.id),["24434"]);
 assert.notEqual(acron.name,akronHolding.name);
 assert.equal(acron.saleInfo.purchaseStatus,"ПРОВЕРЯЕТСЯ");
});
test("Company recovered from deals disappears as a duplicate if its real CRM company card exists",()=>{
 deals.ingest([{ID:"10102",TITLE:'ООО "Автоматизация и Безопасность"',COMPANY_ID:"0"},
  {ID:"23642",TITLE:"ПАО Акрон замена сенсора",COMPANY_ID:"0"}],{complete:true});
 const found=deals.view([{id:"42",name:"АВТОМАТИЗАЦИЯ И БЕЗОПАСНОСТЬ, ООО"}]);
 assert.equal(found.length,1);
 assert.equal(found[0].name,"ПАО «Акрон»");
});
test("A mistaken mention of Acron Holding cannot be attributed to the fertilizer producer",()=>{
 assert.equal(deals.identify("ГК АКРОН ХОЛДИНГ закупка оборудования").key,"akron-industrial-holding");
 assert.equal(deals.identify("ПАО АКРОН замена сенсора").key,"acron-fertilizers");
 assert.equal(deals.identify("Акрон Холдинг и ПАО Акрон согласуют встречу"),null);
});
test("Holdings attach separate member identifiers and only their own published contacts",()=>{
 const clients=[
  {id:"G-62-2790",name:"ГСП РЕМОНТ, ООО",crmIdList:["62","2790"],saleInfo:{purchaseStatus:"БЫЛА"}},
  {id:"288",name:"ООО «ГСП-7»",crmIdList:["288"],saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ"}},
  {id:"dealonly:acron-fertilizers",name:"ПАО «Акрон»",crmIdList:[]},
  {id:"dealonly:akron-industrial-holding",name:"ГК «Акрон Холдинг»",crmIdList:[]}
 ];
 const decorated=groups.decorate(clients);
 assert.equal(decorated[0].holdingId,"gazstroyprom");
 assert.equal(decorated[1].holdingId,"gazstroyprom");
 assert.equal(decorated[2].holdingId,"acron-fertilizer-group");
 assert.equal(decorated[3].holdingId,"akron-industrial-group");
 const h=groups.view(clients).find(h=>h.id==="gazstroyprom");
 assert.equal(h.inAnalytics,2);
 const repair=h.members.find(m=>m.name.includes("Ремонт"));
 const gsp7=h.members.find(m=>m.name.includes("ГСП-7"));
 assert.equal(repair.email,"info@gsp-r.ru");
 assert.equal(gsp7.email,"info@gsp-7.ru");
 assert.deepEqual(repair.companyCrmIds,["62","2790"]);
 assert.deepEqual(gsp7.companyCrmIds,["288"]);
 assert.ok(h.newCandidates.some(m=>m.name.includes("Комплектация")&&m.email==="in@gsp-k.ru"));
});

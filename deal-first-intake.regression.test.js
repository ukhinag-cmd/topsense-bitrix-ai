"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const mod=require("./crm-deal-intake");
test("detects gas and purchase request from the deal, not company name",()=>{
 const s=mod.signals("Нужны переносные ТОП-СЕНС 310, H2S и CO, запрос цены, 2 шт.");
 assert.deepEqual(s.gases,["H2S","CO"]);
 assert.equal(s.portable,true);
 assert.equal(s.fixed,false);
 assert.equal(s.tender,true);
});
test("gas detector service need differs from new product purchase",()=>{
 const s=mod.signals("Ремонт и поверка газоанализатора, CH4, O2, NH3");
 assert.deepEqual(s.gases,["CH4","O2","NH3"]);
 assert.equal(s.service,true);
});
test("inert or unrelated texts do not create a gas or company identity",()=>{
 const s=mod.signals("Письмо о предоставлении реквизитов");
 assert.equal(s.gases.length,0);
 assert.equal(s.portable,false);
 assert.equal(s.fixed,false);
 assert.equal(mod.get("9999"),null);
 assert.deepEqual(mod.forCompany("9999"),[]);
});

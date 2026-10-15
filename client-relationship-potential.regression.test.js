"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const calc=require("./client-relationship-potential");
test("full CRM history detects repeat buyers without inventing payments",()=>{
 const rows=[
  {ID:"100",COMPANY_ID:"2790",TITLE:"ГСП Ремонт ТС 310 CH4 O2",DATE_CREATE:"2025-10-01T11:00:00+03:00"},
  {ID:"101",COMPANY_ID:"2790",TITLE:"ГСП Ремонт ТС 610 H2S",DATE_CREATE:"2026-07-01T11:00:00+03:00"},
  {ID:"102",COMPANY_ID:"0",TITLE:"ГСП Ремонт, ещё 10 шт",DATE_CREATE:"2026-09-01T11:00:00+03:00"},
  {ID:"103",COMPANY_ID:"288",TITLE:"ГСП-7 ТС 310",DATE_CREATE:"2026-09-01T11:00:00+03:00"}];
 calc.build(rows);
 const c=calc.score({id:"2790",name:"ООО ГСП Ремонт",
  organizationType:"Ремонтный подрядчик ОПО / остановочный ремонт",
  saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ"}},new Date("2026-10-15T09:00:00Z"));
 assert.equal(c.dealCount,2);
 assert.equal(c.userConfirmed,true);
 assert.equal(c.buyerVerified,false);
 assert.equal(c.level,"Очень высокий");
 assert.ok(c.models.includes("310")&&c.models.includes("610"));
 assert.ok(c.gases.includes("H2S"));
 const unrelated=calc.score({id:"288",name:"ООО ГСП-7",organizationType:""},new Date("2026-10-15T09:00:00Z"));
 assert.equal(unrelated.userConfirmed,false);
 assert.equal(unrelated.dealCount,1);
});
test("without a verified company ID, merely mentioning GSP in a deal is insufficient",()=>{
 calc.build([{ID:"202",COMPANY_ID:"0",TITLE:"ГСП Ремонт СН4 15 шт"}]);
 const c=calc.score({id:"62",name:"ГСП РЕМОНТ"});
 assert.equal(c.dealCount,0);
 assert.equal(c.buyerVerified,false);
 assert.equal(c.userConfirmed,true);
 assert.match(c.note,/История напрямую/);
});

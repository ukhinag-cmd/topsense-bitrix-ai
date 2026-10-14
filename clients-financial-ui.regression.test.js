"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const financeSrc=fs.readFileSync(path.join(__dirname,"financial-2025.js"),"utf8");
const reqSrc=fs.readFileSync(path.join(__dirname,"company-requisites.js"),"utf8");
const overviewSrc=fs.readFileSync(path.join(__dirname,"client-overview.js"),"utf8");
test("Client types open real company cards; route is paginated and charts contain links",()=>{
 const types=[{name:"Монтажно-строительная организация",family:"Подрядчики"},
  {name:"Дилер промышленного оборудования",family:"Торговля"}];
 const m={exports:{}};
 vm.runInNewContext(overviewSrc,{module:m,exports:m.exports,require:x=>{
  if(x==="./company-types")return{types};
  throw Error("unexpected import: "+x);
 }});
 const companies=[{id:"200",name:"ООО Реальный подрядчик",organizationType:types[0].name,
  category:"Подрядчики",crmIdList:["200"],crmUrl:"https://bitrix.test/company/200"},
 {id:"202",name:"ООО Поставщик",organizationType:types[1].name,
  category:"Партнёрские продажи",crmIdList:["202"],crmUrl:"https://bitrix.test/company/202"}];
 const page=m.exports.render({companies,crmCardTotal:2,status:"ready"},"Обзор",types[0].name,1);
 assert.ok(page.includes("ООО Реальный подрядчик"));
 assert.ok(!page.includes("ООО Поставщик"));
 assert.ok(page.includes("id=\"clients\""));
 assert.ok(page.includes("href=\"/contractors?type="));
 const section=m.exports.render({companies,crmCardTotal:2},"Подрядчики");
 assert.ok(section.includes("ООО Реальный подрядчик"));
 assert.ok(!section.includes("ООО Поставщик"));
});
test("Requisites: checksum, strict entity match and conflicting INNs fail closed",()=>{
 const fin={exports:{}};vm.runInNewContext(financeSrc,{module:fin,exports:fin.exports,URL});
 const mod={exports:{}};
 vm.runInNewContext(reqSrc,{module:mod,exports:mod.exports,require:p=>{
  if(p==="./financial-2025")return fin.exports;
  throw Error(p);
 }});
 const a=mod.exports.validInn,b=mod.exports.consolidate;
 assert.equal(a("7707083893"),"7707083893");
 assert.equal(a("500100732259"),"500100732259");
 assert.equal(a("7707083894"),"");
 const grouped=b([{ID:10,ENTITY_TYPE_ID:4,ENTITY_ID:"200",RQ_INN:"7707083893"},
 {ID:11,ENTITY_TYPE_ID:4,ENTITY_ID:"200",RQ_INN:"7710140679"},
 {ID:12,ENTITY_TYPE_ID:4,ENTITY_ID:"202",RQ_INN:"7707083893"},
 {ID:13,ENTITY_TYPE_ID:3,ENTITY_ID:"204",RQ_INN:"7707083893"}]);
 assert.equal(grouped.conflicts,1);
 assert.equal(grouped.map.get("200").inn,"");
 assert.equal(grouped.map.get("202").inn,"7707083893");
 assert.equal(grouped.map.has("204"),false);
 const unresolved=fin.exports.withRequisite(fin.exports.empty(),{status:"inn_recorded",inn:"7707083893"});
 assert.equal(unresolved.inn,"7707083893");
 assert.equal(unresolved.amountRUB,null);
 assert.equal(unresolved.status,"inn_only");
 const mismatch=fin.exports.withRequisite({inn:"7710140679",amountRUB:2222,year:2025},{status:"inn_recorded",inn:"7707083893"});
 assert.equal(mismatch.amountRUB,null);
});

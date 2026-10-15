"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const types=require("./company-types").types;
const overview=require("./client-overview");
const segments=require("./client-segments");
const subtype="Промышленный генподрядчик";
const records=[
 {id:"105",name:"Подрядная компания",organizationType:subtype,category:"Подрядчики",crmIdList:["105"],crmUrl:"https://topsense.bitrix24.ru/crm/company/details/105/",saleInfo:{purchaseStatus:"НЕ БЫЛО"}},
 {id:"106",name:"Проектная компания",organizationType:"Инжиниринговая компания",category:"Проектные продажи",crmUrl:"https://topsense.bitrix24.ru/crm/company/details/106/",saleInfo:{}}
];
test("All available subtypes are visible and each links to a server-side client list",()=>{
 const output=overview.render({companies:records,status:"ready"},"Обзор");
 assert.ok(types.length>=49);
 for(const type of types){
  const href="/contractors?type="+encodeURIComponent(type.name)+"#clients";
  assert.ok(output.includes(href),"Missing subtype link: "+type.name);
 }
});
test("Industrial general contractor filter shows only matching companies",()=>{
 const output=overview.render({companies:records,status:"ready"},"Обзор",subtype,"1");
 assert.ok(output.includes("Подрядная компания"));
 assert.ok(!output.includes('companyTitle">Проектная компания'));
 assert.ok(output.includes('id="clients"'));
 assert.ok(output.includes("CRM 105"));
});
test("No matches show a zero-state instead of an empty page",()=>{
 const output=overview.render({companies:[]},"Обзор",subtype,"1");
 assert.ok(output.includes("По выбранному типу компаний пока не обнаружено."));
 assert.ok(output.includes(subtype));
});
test("Detailed client view exposes the same subtype through a plain link",()=>{
 const output=segments.html({companies:records,crmCardTotal:2});
 assert.ok(output.includes("/contractors?type="+encodeURIComponent(subtype)+"#clients"));
 assert.ok(output.includes("Промышленный генподрядчик"));
});

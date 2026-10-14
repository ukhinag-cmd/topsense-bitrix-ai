"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const overview=require("./client-overview");
const staff=require("./staff-evidence");
const type="Промышленный генподрядчик";
function card(id,name,purchaseStatus,extras={}){
 return {id:String(id),name,organizationType:type,category:"Подрядчики",
  crmUrl:"https://topsense.bitrix24.ru/crm/company/details/"+id+"/",
  crmIdList:[String(id)],saleInfo:{purchaseStatus},finance2025:{year:2025,amountRUB:null},
  ...extras};
}
test("Visual customer dashboard can filter only purchasers without counting leads as purchases",()=>{
 const companies=[
  card(1,"ООО ТЭКСТРО","БЫЛА"),card(2,"ООО Ещё подрядчик","НЕ БЫЛО"),
  card(3,"ООО Клиент на проверке","ПРОВЕРЯЕТСЯ")];
 const all=overview.render({companies},"Обзор","","1");
 const selected=overview.render({companies},"Обзор","","1","buyers");
 assert.ok(all.includes("Покупали у нас"));
 assert.ok(selected.includes("ООО ТЭКСТРО"));
 assert.ok(!selected.includes("ООО Ещё подрядчик"));
 assert.ok(!selected.includes("ООО Клиент на проверке"));
 assert.ok(selected.includes('href="/contractors?purchase=buyers&'));
});
test("Identical company names are visually one expandable group, without mixing CRM IDs or purchases",()=>{
 const companies=[
  card(1,"ООО ТЭКСТРО","БЫЛА"),card(2,"ТЭКСТРО","ПРОВЕРЯЕТСЯ"),
  card(3,"ООО Монтаж","БЫЛА")];
 const html=overview.render({companies},"Обзор");
 assert.ok(html.includes("отдельных CRM-записи"));
 assert.ok(html.includes("CRM 1"));
 assert.ok(html.includes("CRM 2"));
 assert.ok(html.includes("юридическую идентичность"));
 assert.ok(html.includes("Сделки, покупки, реквизиты и сайты этих карточек не смешиваются"));
});
test("Staff count on the company site is shown with provenance, approximate marker and no invented year",()=>{
 const e=staff.fromPages([{pageUrl:"https://tekstro.ru/o-kompanii/",
  meta:{body:"Штат предприятия на сегодняшний день насчитывает около 500 высококвалифицированных специалистов."}}]);
 assert.equal(e.count,500);assert.equal(e.year,null);assert.equal(e.approximate,true);
 const html=overview.render({companies:[card(1,"ООО ТЭКСТРО","БЫЛА",{staffEvidence:e})]},"Обзор");
 assert.ok(html.includes("около 500 чел. (год не указан)"));
 assert.ok(html.includes("Выручка за 2025 год: нет подтверждённых данных"));
 assert.ok(html.includes("Источник ↗"));
});
test("Do not sum employee counts across duplicate CRM cards or suppress conflicting values",()=>{
 const e={count:500,approximate:true,year:null,sourceUrl:"https://tekstro.ru",source:"Официальный сайт",basis:"Штат"};
 const same=staff.forGroup([{staffEvidence:e},{staffEvidence:e}]);
 assert.equal(same.count,500);
 const conflict=staff.forGroup([{staffEvidence:e},{staffEvidence:{...e,count:700}}]);
 assert.equal(conflict.count,null);
});
test("2025 headcount requires an explicitly dated and sourced figure",()=>{
 assert.equal(staff.fromCompany({UF_CRM_AI_EMPLOYEE_COUNT:500,UF_CRM_AI_EMPLOYEE_YEAR:2025}).count,null);
 const x=staff.fromCompany({UF_CRM_AI_EMPLOYEE_COUNT:500,UF_CRM_AI_EMPLOYEE_YEAR:2025,
  UF_CRM_AI_EMPLOYEE_SOURCE:"ФНС отчёт 2025"});
 assert.equal(x.count,500);assert.equal(x.year,2025);
});

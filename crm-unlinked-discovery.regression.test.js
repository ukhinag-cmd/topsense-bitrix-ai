"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const disc=require("./crm-unlinked-discovery");
const known=require("./deal-only-client-registry");
function item(id,title,company="0",contact=""){return {ID:String(id),TITLE:title,COMPANY_ID:company,CONTACT_ID:contact,DATE_CREATE:"2025-11-12T12:00:00+03:00",STAGE_ID:"NEW"}}
test("complete inventory reports missing company IDs and single/multiple title company cues",()=>{
 const a=[
  item(1,'ООО "Автоматизация и Безопасность" для тендера'),
  item(2,'ООО "Автоматизация и Безопасность" ТС-310 ст 4 шт',""),
  item(3,"ПАО АКРОН замена сенсора"),
  item(4,"ГК АКРОН ХОЛДИНГ закупка прибора"),
  item(5,'RE: Сверка взаиморасчетов ООО "ТС Инжиниринг" и ООО "Автоматизация и Безопасность"'),
  item(6,"Запрос цены на газоанализатор ТС-310"),
  item(7,'ООО "Автоматизация и Безопасность" повторный заказ',"111")
 ];
 const stats=disc.ingest(a,{complete:true});
 assert.equal(stats.totalDeals,7);
 assert.equal(stats.withoutCompanyId,6);
 assert.equal(stats.identifiedDeals,3); // 1, 2, 3 (holding only via curated registry)
 assert.equal(stats.ambiguousDeals,1);
 assert.equal(stats.unidentifiedDeals,2);
 const g=disc.group([]);
 const av=g.find(x=>x.key==="автоматизация и безопасность");
 assert.ok(av);
 assert.equal(av.dealCount,2);
 assert.equal(av.linkedExisting,false);
 assert.ok(g.every(x=>x.dealRefs.every(d=>d.id!=="7")));
});
test("distinct legal entities sharing a holding keyword are never a consolidated customer",()=>{
 disc.ingest([
  item(20,'ООО "ГСП Ремонт" ТС 310'),
  item(21,'ООО "ГСП Ремонт" ТС 610'),
  item(22,'ООО "ГСП-7" ТС 310'),
  item(23,'ООО "ГСП-7" ТС 610')
 ],{complete:true});
 const g=disc.group([]);
 assert.equal(g.length,2);
 assert.equal(g.find(x=>x.key==="гсп ремонт").dealCount,2);
 assert.equal(g.find(x=>x.key==="гсп 7").dealCount,2);
});
test("same-name existing CRM card is not minted again as a new client",()=>{
 disc.ingest([item(32,'ООО "Промприбор сервис" запрос цены'),
  item(33,'ООО "Промприбор сервис" ТС-310')],{complete:true});
 const existing=[{id:"341",name:"ПРОМПРИБОР СЕРВИС, ООО",crmIdList:["341"]}];
 const g=disc.group(existing);
 assert.equal(g.length,1);
 assert.equal(g[0].linkedExisting,true);
 assert.deepEqual(g[0].existingCrmIds,["341"]);
 const synthetic=known.view(existing);
 assert.equal(synthetic.length,0);
});
test("distinct OPF and multi-party business correspondence are never force-merged",()=>{
 disc.ingest([item(40,'ООО "Орион Системы" ТС-310'),
  item(41,'АО "Орион Системы" ТС-610'),
  item(42,'ООО "Орион Системы" и ООО "Новый клиент" договор')],{complete:true});
 const g=disc.group([]);
 assert.equal(g.length,0);
 assert.equal(disc.stats().ambiguousDeals,1);
});
test("unlinked prospect is listed with original deals and no invented purchase status",()=>{
 disc.ingest([item(51,'ООО "Новая Сервисная Компания" ТС 310'),
  item(52,'ООО "Новая Сервисная Компания" ТС 610')],{complete:true});
 const result=known.view([]);
 const prospect=result.find(x=>x.id.startsWith("dealonly:discovered:"));
 assert.ok(prospect);
 assert.equal(prospect.companyCardMissing,true);
 assert.equal(prospect.crmDealCount,2);
 assert.equal(prospect.saleInfo.purchaseStatus,"ПРОВЕРЯЕТСЯ");
 assert.deepEqual(prospect.dealRefs.map(x=>x.id),["51","52"]);
});

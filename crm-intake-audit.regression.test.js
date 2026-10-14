"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const code=fs.readFileSync(path.join(__dirname,"crm-intake-audit.js"),"utf8");
test("Historic lead/deal audit uses only read APIs, recovers contacts by CRM ID and filters dates",async()=>{
 const calls=[],events=[];
 const rows={
  "crm.lead.list.json":[
   {ID:"10",TITLE:"Запрос анализаторов",DATE_CREATE:"2026-10-09T10:00:00+03:00",COMPANY_TITLE:"Проект Лаб",STATUS_ID:"NEW",CONTACT_ID:"88",ASSIGNED_BY_ID:"114"},
   {ID:"11",TITLE:"Delivery status notification",DATE_CREATE:"2026-10-12T10:00:00+03:00",STATUS_ID:"NEW"}],
  "crm.deal.list.json":[
   {ID:"20",TITLE:"Коммерческая заявка",DATE_CREATE:"2026-09-12T09:00:00+03:00",COMPANY_ID:"5",STAGE_ID:"NEW"},
   {ID:"21",TITLE:"Заказ",DATE_CREATE:"2026-10-12T09:00:00+03:00",COMPANY_ID:"0",CONTACT_ID:"88",STAGE_ID:"NEW"},
   {ID:"22",TITLE:"Старый заказ",DATE_CREATE:"2026-08-01T09:00:00+03:00",STAGE_ID:"NEW"}],
  "crm.contact.list.json":[{ID:"88",COMPANY_ID:"5"}]
 };
 const fakeFetch=async(url,options)=>{
  const method=String(url).split("/").pop();
  const params=JSON.parse(options.body);
  calls.push({method,params});
  return {ok:true,json:async()=>({result:rows[method]||[],total:(rows[method]||[]).length})};
 };
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,URL,AbortSignal,
  fetch:fakeFetch,setTimeout:(fn)=>{fn();return 0;},process:{env:{BITRIX_WEBHOOK_BASE:"https://bitrix.test/rest/"}},
  console:{log:x=>events.push(JSON.parse(x)),warn:x=>events.push(JSON.parse(x))}});
 await module.exports.refresh([{id:"5",name:"ООО Ресурс"}]);
 const result=module.exports.snapshot();
 assert.equal(result.status,"ready");
 assert.equal(result.stats.leads,2);
 assert.equal(result.stats.deals,2);
 assert.equal(result.stats.viaContact,2);
 assert.equal(result.stats.unlinked,1);
 assert.equal(result.stats.technical,1);
 assert.equal(result.items.some(x=>x.id==="22"),false);
 assert.ok(calls.every(x=>x.method.endsWith(".list.json")));
 assert.ok(calls.filter(x=>x.method!=="crm.contact.list.json").every(x=>x.params.filter[">=DATE_CREATE"]==="2026-09-06T00:00:00+03:00"));
 const html=module.exports.html({kind:"lead",link:"unlinked",page:1});
 assert.ok(html.includes("Входящие лиды"));
 assert.ok(!html.includes("Коммерческая заявка"));
 assert.ok(events.some(x=>x.event==="audit-finished"));
});

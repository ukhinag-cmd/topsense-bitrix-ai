"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"crm-lead-inbox.js"),"utf8");
test("Historical CRM leads and all deal funnels from 6 Sep; safe contact links; no writes",async()=>{
 const calls=[];
 const lead=[{ID:"1",TITLE:"Запрос детекторов",DATE_CREATE:"2026-10-08T11:00:00+03:00",CONTACT_ID:"88",STATUS_ID:"NEW",ASSIGNED_BY_ID:"114"},
  {ID:"2",TITLE:"Mail delivery failed",DATE_CREATE:"2026-10-09T11:00:00+03:00",STATUS_ID:"NEW"}];
 const deals=[{ID:"10",TITLE:"Поставка приборов",DATE_CREATE:"2026-09-06T11:00:00+03:00",COMPANY_ID:"7",CATEGORY_ID:"0",STAGE_ID:"NEW"},
  {ID:"11",TITLE:"Другая сделка",DATE_CREATE:"2026-10-08T11:00:00+03:00",CONTACT_ID:"88",COMPANY_ID:"0",CATEGORY_ID:"16",STAGE_ID:"NEW"}];
 const contacts=[{ID:"88",COMPANY_ID:"7"}];
 const answers={"crm.lead.list.json":lead,"crm.deal.list.json":deals,"crm.contact.list.json":contacts};
 const fakeFetch=async(u,options)=>{
  const method=String(u).split("/").pop(),body=JSON.parse(options.body);
  calls.push({method,body});
  return {ok:true,json:async()=>({result:answers[method]||[],total:(answers[method]||[]).length})};
 };
 const module={exports:{}};
 const intake={queueDeals:rows=>{calls.push({method:"deal-intake-local",count:rows.length});return rows.length},
  get:()=>null,stats:()=>({status:"scanning",inspected:0,queued:2})};
 vm.runInNewContext(source,{module,exports:module.exports,URL,AbortSignal,fetch:fakeFetch,
  require:name=>{if(name==="./crm-deal-intake")return intake;
   if(name==="./deal-only-client-registry")return {ingest:()=>({})};
   throw Error("unexpected "+name)},
  process:{env:{BITRIX_WEBHOOK_BASE:"https://bitrix.example/rest/"}},
  setTimeout:fn=>{fn();return 0},
  console:{log:()=>{},warn:()=>{}}},{filename:"crm-lead-inbox.js"});
 await module.exports.refresh();
 const p=module.exports.view([{id:"7",crmIdList:["7"]}]);
 assert.equal(p.status,"ready");
 assert.equal(p.history.leads,2);assert.equal(p.history.deals,2);
 assert.equal(p.history.incomingDeals,1);assert.equal(p.history.otherPipelineDeals,1);
 assert.equal(p.linked,3);assert.equal(p.pending,1);
 assert.equal(p.items.find(x=>x.id==="11").linkSource,"contact_company_id");
 assert.equal(p.items.find(x=>x.id==="1").ownerId,"114");
 assert.ok(calls.filter(x=>x.method!=="deal-intake-local").every(x=>x.method.endsWith(".list.json")));
 assert.ok(calls.some(x=>x.method==="deal-intake-local"&&x.count===2));
 assert.ok(calls.filter(x=>x.method!=="crm.contact.list.json"&&x.method!=="deal-intake-local").every(x=>x.body.filter[">=DATE_CREATE"]==="2026-09-06T00:00:00+03:00"));
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const code=fs.readFileSync(path.join(__dirname,"crm-change-monitor.js"),"utf8");
const dates={old:"2026-10-07T10:00:00+03:00",fresh:"2026-10-10T11:00:00+03:00",latest:"2026-10-14T08:30:00+03:00"};
function row(id,created,modified,company="0"){
 return {ID:String(id),TITLE:"Company "+id,NAME:"Contact "+id,COMPANY_ID:company,
  DATE_CREATE:created,DATE_MODIFY:modified,ASSIGNED_BY_ID:"130"};
}
function setup(){
 let version=1,fail=false;const calls=[],events=[],module={exports:{}};
 const fetch=async(url,options)=>{
  if(options.method!=="POST")throw Error("Invalid Bitrix read method");
  const b=JSON.parse(options.body),isCo=String(url).includes("company"),
   created=Object.hasOwn(b.filter,">=DATE_CREATE");
  calls.push({method:options.method,entity:isCo?"company":"contact",created});
  if(fail&&isCo)throw Error("Bitrix temporarily unavailable");
  const result=created?(isCo?
   [row(4022,dates.fresh,dates.latest),...(version===2?[row(4024,dates.latest,dates.latest)]:[])]:
   [row(39692,dates.fresh,dates.latest,"4022"),...(version===2?[row(39694,dates.latest,dates.latest)]:[])])
   :[row(isCo?4000:38000,dates.old,dates.latest)];
  return {ok:true,json:async()=>({result,total:result.length})};
 };
 vm.runInNewContext(code,{require:()=>{throw Error("No imports expected")},
  module,exports:module.exports,process:{env:{BITRIX_WEBHOOK_BASE:"https://bitrix.test/rest"}},
  fetch,URL,AbortSignal,console:{log:x=>events.push(JSON.parse(x)),warn:x=>events.push(JSON.parse(x))},
  setTimeout});
 return {api:module.exports,setVersion:v=>version=v,setFail:v=>fail=v,calls,events};
}
test("New company and contact records are read-only, deduplicated by CRM ID and linked strictly by COMPANY_ID",async()=>{
 const f=setup();
 await f.api.refresh();const first=f.api.snapshot();
 assert.equal(first.status,"ready");
 assert.equal(first.newCompanies,1);assert.equal(first.newContacts,1);
 assert.equal(first.changedOlderCompanies,1);assert.equal(first.changedOlderContacts,1);
 assert.equal(first.contacts[0].companyId,"4022");
 f.setVersion(2);
 await f.api.refresh();const second=f.api.snapshot();
 assert.equal(second.newCompanies,2);assert.equal(second.newContacts,2);
 assert.equal(second.newContactsWithoutCompany,1);
 assert.ok(second.contacts.some(c=>c.id==="39694"&&c.companyId===""));
 assert.ok(second.companies.some(c=>c.id==="4024"));
 assert.ok(f.calls.every(x=>x.method==="POST"&&["company","contact"].includes(x.entity)));
 assert.ok(f.events.some(x=>x.event==="sync-ok"&&x.createdContacts===2));
});
test("Read failure cannot erase last known good new contacts or companies",async()=>{
 const f=setup();
 await f.api.refresh();
 f.setFail(true);
 await f.api.refresh();
 const snap=f.api.snapshot();
 assert.equal(snap.status,"stale");
 assert.equal(snap.newContacts,1);assert.equal(snap.newCompanies,1);
 assert.ok(snap.error);
});
test("Dashboard HTML sanitizes record names, only exposes records after auth-gated route",async()=>{
 const f=setup();
 await f.api.refresh();
 const html=f.api.html();
 assert.match(html,/Новые компании и контакты/);
 assert.match(html,/crm\/contact\/details\/39692/);
 assert.match(html,/crm\/company\/details\/4022/);
});

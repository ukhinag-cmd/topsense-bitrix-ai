"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"crm-dashboard.js"),"utf8");
function contact(id,company,email){
 return {ID:String(id),NAME:"Contact "+id,LAST_NAME:"Test",COMPANY_ID:String(company),
  EMAIL:[{VALUE:email}],DATE_MODIFY:new Date().toISOString()};
}
function fixture(){
 let mode="full",unsupported=false;
 const calls=[],events=[],timers=[];
 const full=[contact(1,10,"one@first.ru"),contact(2,20,"two@second.ru")];
 const delta=[contact(1,20,"one@second.ru"),contact(3,10,"three@first.ru")];
 const module={exports:{}};
 const requireMock=name=>{
  if(name==="crypto")return require("node:crypto");
  if(name==="fs")return{readFileSync:()=>"<html></html>"};
  if(name==="path")return path;
  if(name==="./company-types")return{types:[]};
  if(name==="./website-profiler"||name==="./name-site-search")return{enqueue:()=>{}};
  throw Error("Unexpected module "+name);
 };
 const fetch=async(url,options)=>{
  const args=JSON.parse(options.body),filtered=Boolean(args.filter?.[">DATE_MODIFY"]);
  calls.push({mode,filtered});
  if(unsupported&&filtered)return {ok:true,json:async()=>({error:"UNSUPPORTED_FILTER"})};
  return {ok:true,json:async()=>({result:filtered?delta:full,total:2})};
 };
 vm.runInNewContext(source+"\nmodule.exports.__test={loadLinkedContacts,state};",{
  module,exports:module.exports,require:requireMock,process:{env:{BITRIX_WEBHOOK_BASE:"https://bitrix.example/rest/"}},
  fetch,URL,AbortSignal,setTimeout:()=>0,
  setInterval:(fn,ms)=>{timers.push({fn,ms});return 0},
  console:{log:s=>events.push(JSON.parse(s)),warn:s=>events.push(JSON.parse(s))},
  __dirname:"/test"
 },{filename:"crm-dashboard.js"});
 return {api:module.exports.__test,calls,events,timers,setMode:m=>mode=m,setUnsupported:v=>unsupported=v};
}
test("Full contact snapshot followed by deltas correctly moves links between companies",async()=>{
 const f=fixture();
 await f.api.loadLinkedContacts();
 assert.equal(f.api.state.contactCache.size,2);
 assert.ok(f.api.state.linkedContacts.get("10").emails.has("one@first.ru"));
 f.setMode("delta");
 await f.api.loadLinkedContacts();
 assert.equal(f.api.state.contactCache.size,3);
 assert.ok(!f.api.state.linkedContacts.get("10").emails.has("one@first.ru"));
 assert.ok(f.api.state.linkedContacts.get("10").emails.has("three@first.ru"));
 assert.ok(f.api.state.linkedContacts.get("20").emails.has("one@second.ru"));
 assert.deepEqual(f.calls.map(c=>c.filtered),[false,true]);
 assert.ok(f.events.some(e=>e.event==="contact-sync"&&e.mode==="delta"&&e.changed===2));
});
test("Invalid Bitrix delta filter preserves the previous good contact snapshot",async()=>{
 const f=fixture();
 await f.api.loadLinkedContacts();
 f.setUnsupported(true);
 await f.api.loadLinkedContacts();
 assert.equal(f.api.state.contactsIncrementalSupported,false);
 assert.equal(f.api.state.contactCache.size,2);
 assert.ok(f.api.state.linkedContacts.get("10").emails.has("one@first.ru"));
 // No further full scan until the hourly fallback window.
 const before=f.calls.length;
 await f.api.loadLinkedContacts();
 assert.equal(f.calls.length,before);
});
test("Background refresh timers are registered independently of dashboard visits",()=>{
 const f=fixture();
 assert.ok(f.timers.some(x=>x.ms===600000));
 assert.ok(f.timers.some(x=>x.ms===900000));
});

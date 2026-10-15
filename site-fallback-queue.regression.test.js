"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm");
const fs=require("node:fs"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"website-profiler.js"),"utf8");
function harness(){
 const module={exports:{}};
 const evidence={
  configured:()=>false,load:async()=>new Map(),restored:()=>null,queue:()=>{},
  inputUrl:c=>c.siteCandidate|| (c.corporateDomain?"https://"+c.corporateDomain:""),
  fingerprint:c=>JSON.stringify([c.id,c.name,c.corporateDomain,c.siteSource]),
  stats:()=>({configured:false})
 };
 const requireMock=name=>{
  if(name==="dns")return {promises:{lookup:async()=>[{address:"8.8.8.8",family:4}]}};
  if(name==="net")return{isIP:()=>0};
  if(name==="./client-type-inference")return{inferWebsiteActivity:()=>null};
  if(name==="./site-profile-store")return evidence;
  if(name==="./client-finalization")return{isComplete:()=>false};
  throw Error("Unexpected dependency "+name);
 };
 vm.runInNewContext(source,{module,exports:module.exports,require:requireMock,
  URL,TextDecoder,AbortSignal,Uint8Array,Date,console:{log:()=>{},warn:()=>{}},
  setTimeout:()=>({unref(){}}),fetch:async()=>{throw Error("fetch failed")}}, {filename:"website-profiler.js"});
 return module.exports;
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
test("failed corporate domain unlocks a distinct linked-contact alternative but cannot oscillate",async()=>{
 const p=harness();
 const original={id:"10",name:"Industrial Client",corporateDomain:"main.example",siteSource:"Корпоративный домен e-mail CRM"};
 const fallback={...original,corporateDomain:"alternate.example",siteSource:"Альтернативный домен привязанного контакта"};
 assert.equal(p.enqueue([original]),1);
 await tick();
 assert.equal(p.get("10").status,"site_unavailable");
 assert.equal(p.enqueue([fallback]),1);
 await tick();
 assert.equal(p.enqueue([original]),0);
 assert.equal(p.enqueue([fallback]),0);
});
test("temporary failed site is retried once only after cooldown",async()=>{
 const p=harness(), c={id:"11",name:"Service Client",corporateDomain:"service.example",siteSource:"Корпоративный домен e-mail CRM"};
 p.enqueue([c]);await tick();
 const at=Date.parse(p.get("11").checkedAt);
 assert.equal(p.retryTransient([c],at+60000),0);
 assert.equal(p.retryTransient([c],at+4*60*60*1000),1);
 await tick();
 assert.equal(p.retryTransient([c],at+8*60*60*1000),0);
});

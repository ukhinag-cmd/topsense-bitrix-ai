"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const {homepageVariants}=require("./website-profiler");
const four=[
 "https://example.ru/",
 "https://www.example.ru/",
 "http://www.example.ru/",
 "http://example.ru/"
];

test("HTTPS and HTTP, with and without www, are attempted in the specified order",()=>{
 for(const input of ["https://example.ru","https://www.example.ru/","http://example.ru","www.example.ru","example.ru","//example.ru"]){
  assert.deepEqual(homepageVariants(input),four,input);
 }
});
test("path and query survive protocol variants; unsafe or invalid URLs do not generate new hosts",()=>{
 assert.deepEqual(homepageVariants("https://example.ru/about?q=1#fragment"),four.map(x=>x+"about?q=1"));
 assert.deepEqual(homepageVariants("https://example.ru:8443/"),["https://example.ru:8443/"]);
 assert.deepEqual(homepageVariants("not-a-url"),["not-a-url"]);
 assert.deepEqual(homepageVariants("https://example.ru@127.0.0.1/"),["https://example.ru@127.0.0.1/"]);
 assert.deepEqual(homepageVariants(""),[]);
});
test("live homepage probe tries every variant until one is reachable and stops",async()=>{
 const attempts=[],module={exports:{}};
 const raw=fs.readFileSync(path.join(__dirname,"website-profiler.js"),"utf8");
 const fakeRequire=name=>{
  if(name==="dns")return {promises:{lookup:async()=>[{family:4,address:"8.8.8.8"}]}};
  if(name==="net")return {isIP:()=>0};
  if(name==="./client-type-inference")return {inferWebsiteActivity:()=>null};
  if(name==="./site-profile-store")return {configured:()=>false,stats:()=>({})};
  if(name==="./client-finalization")return {isComplete:()=>false};
  throw Error("Unexpected require "+name);
 };
 const html=new TextEncoder().encode("<html><title>Company</title><body>Company site</body></html>");
 const mockFetch=async url=>{
  const candidate=String(url);
  attempts.push(candidate);
  if(candidate!=="http://example.ru/")throw Error("Connection refused");
  let done=false;
  return {ok:true,status:200,headers:{get:key=>key==="content-type"?"text/html; charset=utf-8":null},
   body:{getReader:()=>({read:async()=>{if(done)return {done:true};done=true;return {done:false,value:html}},cancel:async()=>{}})}};
 };
 vm.runInNewContext(raw,{module,exports:module.exports,require:fakeRequire,
  URL,TextDecoder,AbortSignal,Uint8Array,Date,console:{log:()=>{},warn:()=>{}},
  setTimeout:()=>({unref(){}}),fetch:mockFetch},{filename:"website-profiler.js"});
 const result=await module.exports.fetchCorporateHome("example.ru");
 assert.equal(result.url,"http://example.ru");
 assert.deepEqual(attempts,four);
});

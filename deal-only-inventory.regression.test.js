"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const cache=require("./deal-only-inventory");
function prospect(n){
 return {key:"тестовый завод "+n,name:"ООО «Тестовый завод "+n+"»",
  rawName:"ООО Тестовый завод "+n,confidence:"one_explicit_legal_name",
  linkedExisting:false,existingCrmIds:[],dealCount:2,
  dealRefs:[{id:String(800000+n*2),title:"Завод "+n+" ТОП-СЕНС",
   createdAt:"2025-01-01T08:00:00+03:00"},
  {id:String(800001+n*2),title:"Завод "+n+" договор",
   createdAt:"2025-08-01T08:00:00+03:00"}]};
}
test("incomplete 1600 company refresh cannot replace a full 3700-company register",async()=>{
 const g=Array.from({length:2150},(_,i)=>prospect(i));
 assert.equal(cache.queue(g,{complete:false,totalDeals:17241,crmCards:1671}),false);
 assert.equal(cache.stats().groups,0);
 assert.equal(cache.queue(g,{complete:true,totalDeals:17241,crmCards:1671}),true);
 const old=cache.available([],[],false);
 assert.equal(old.length,2150);
 assert.deepEqual(old[0].dealRefs.map(x=>x.id),g[0].dealRefs.map(x=>x.id));
 assert.equal(cache.stats().sourceDeals,17241);
 assert.equal(cache.available([{id:"42",name:"ООО Тестовый завод 14"}],[],false).length,2149);
 // An incomplete scan cannot be used as a new complete customer census.
 assert.equal(cache.queue(g.slice(0,7),{complete:false,totalDeals:5250,crmCards:1671}),false);
 assert.equal(cache.stats().groups,2150);
});
test("private checkpoint commits manifest last; partial save or manifest alone cannot be restored",async()=>{
 const existing={url:process.env.GOOGLE_SHEET_STORE_URL,
  secret:process.env.GOOGLE_SHEET_STORE_SECRET,fetch:global.fetch};
 const output=[];
 try{
  process.env.GOOGLE_SHEET_STORE_URL="https://private-store.example.invalid";
  process.env.GOOGLE_SHEET_STORE_SECRET="regression-only-fake";
  global.fetch=async(_url,params)=>{
   const p=JSON.parse(params.body);
   assert.equal(p.action,"upsert");
   assert.equal(p.secret,"regression-only-fake");
   output.push(...p.rows);
   return {ok:true,json:async()=>({ok:true})};
  };
  while(cache.stats().pending){
   await cache.flush();
  }
  assert.ok(output.length>90);
  assert.equal(output[output.length-1].key,cache.MANIFEST);
  const prior=cache.stats().groups;
  assert.equal(cache.read(output),true);
  assert.equal(cache.stats().groups,prior);
  assert.equal(cache.stats().sourceDeals,17241);
  const incomplete=output.slice(0,-2).concat(output[output.length-1]);
  assert.equal(cache.read(incomplete),false);
  assert.equal(cache.stats().groups,prior);
  assert.equal(Object.hasOwn(output[0].payload.groups[0],"crmEmails"),false);
 }finally{
  global.fetch=existing.fetch;
  if(existing.url===undefined)delete process.env.GOOGLE_SHEET_STORE_URL;
  else process.env.GOOGLE_SHEET_STORE_URL=existing.url;
  if(existing.secret===undefined)delete process.env.GOOGLE_SHEET_STORE_SECRET;
  else process.env.GOOGLE_SHEET_STORE_SECRET=existing.secret;
 }
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const store=require("./site-profile-store");
const source={id:"110",name:'ООО "НЕФТЕСЕРВИС"',siteCandidate:"https://first.example/about",
 siteSource:"Сайт из CRM"};
const profile={status:"site_profiled",siteType:"Промышленный сервис / техническая эксплуатация",
 checkedAt:new Date().toISOString(),siteHeadings:["О компании"]};
function entry(c=source,p=profile){
 return {recordType:"topsense-site-profile",companyId:String(c.id),fingerprint:store.fingerprint(c),
  checkedAt:p.checkedAt,profile:p};
}
test("The same company/source restores a recent site-based preliminary type",()=>{
 const e=entry();
 assert.equal(e.fingerprint.length,64);
 assert.equal(store.fresh(e),true);
 assert.equal(store.restored(source,e).siteType,profile.siteType);
});
test("Different website domain, company name, or source invalidates existing evidence",()=>{
 const e=entry();
 for(const change of [
  {siteCandidate:"https://another.example"},
  {name:'ООО "ДРУГОЕ ПРЕДПРИЯТИЕ"'},
  {siteSource:"Домен привязанного контакта"},
  {id:"111"}
 ])assert.equal(store.restored({...source,...change},e),null);
});
test("Expired, malformed or transient records are never treated as proof",()=>{
 const e=entry(),old={...e,checkedAt:"2025-01-01T00:00:00.000Z"};
 assert.equal(store.fresh(old),false);
 assert.equal(store.fresh({...e,fingerprint:"short"}),false);
 assert.equal(store.fresh({...e,profile:{status:"site_unavailable"}}),false);
 assert.equal(store.fresh({...e,profile:{status:"site_profiled",siteType:""}}),false);
});
test("The checkpoint contains only public website evidence, never CRM contacts",async()=>{
 const before={url:process.env.GOOGLE_SHEET_STORE_URL,secret:process.env.GOOGLE_SHEET_STORE_SECRET,fetch:global.fetch};
 const fakeRows=[];
 try{
  process.env.GOOGLE_SHEET_STORE_URL="https://storage.example.invalid";
  process.env.GOOGLE_SHEET_STORE_SECRET="fake-test-secret";
  global.fetch=async(_url,options)=>{
   const body=JSON.parse(options.body);
   if(body.action==="load")return {ok:true,json:async()=>({ok:true,rows:fakeRows})};
   if(body.action==="upsert"){fakeRows.push(...body.rows);return {ok:true,json:async()=>({ok:true})};}
   throw Error("Unexpected action");
  };
  store.queue(source,{...profile,crmEmails:["private@example.com"],contactNames:["private person"]});
  await store.flush();
  assert.equal(fakeRows.length,1);
  const p=fakeRows[0].payload.profile;
  assert.equal(Object.hasOwn(p,"crmEmails"),false);
  assert.equal(Object.hasOwn(p,"contactNames"),false);
  assert.equal(p.siteType,profile.siteType);
  const recovered=await store.load();
  assert.equal(recovered.size,1);
  assert.equal(store.restored(source,recovered.get("110")).siteType,profile.siteType);
 }finally{
  global.fetch=before.fetch;
  if(before.url===undefined)delete process.env.GOOGLE_SHEET_STORE_URL;
  else process.env.GOOGLE_SHEET_STORE_URL=before.url;
  if(before.secret===undefined)delete process.env.GOOGLE_SHEET_STORE_SECRET;
  else process.env.GOOGLE_SHEET_STORE_SECRET=before.secret;
 }
});

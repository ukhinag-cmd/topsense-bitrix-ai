"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const worker=require("./qualification-review-processor");
test("review worker requires Bitrix read-only flag",async()=>{
 const previous=process.env.TOPSENSE_ANALYTICS_READONLY;
 try{
  process.env.TOPSENSE_ANALYTICS_READONLY="0";
  const r=await worker.tick(Array.from({length:500},(_,i)=>({id:String(i+1)})));
  assert.equal(r.status,"read_only_required");
 }finally{
  if(previous===undefined)delete process.env.TOPSENSE_ANALYTICS_READONLY;
  else process.env.TOPSENSE_ANALYTICS_READONLY=previous;
 }
});
test("review worker does not process an incomplete CRM snapshot",async()=>{
 const previous=process.env.TOPSENSE_ANALYTICS_READONLY;
 try{
  process.env.TOPSENSE_ANALYTICS_READONLY="1";
  const r=await worker.tick([{id:"42"}]);
  assert.equal(r.status,"snapshot_not_ready");
 }finally{
  if(previous===undefined)delete process.env.TOPSENSE_ANALYTICS_READONLY;
  else process.env.TOPSENSE_ANALYTICS_READONLY=previous;
 }
});
test("read-only review checkpoints accept fixed ID and stable fingerprint",()=>{
 const p=worker.signature({id:"104",name:"Example factory"});
 assert.match(p,/^[0-9a-f]{24}$/);
 const n=worker.ingest([{key:"review-worker:v1:checkpoint",payload:{
  recordType:"topsense-review-worker-checkpoint-v1",seen:[["104",p],["bad id",p]]}}]);
 assert.ok(n>=1);
 assert.ok(worker.stats().checkpointed>=1);
});

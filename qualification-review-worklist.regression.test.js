"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const queue=require("./qualification-review-worklist");

test("distinguishes prior paid review, error and reservation without rerunning model",()=>{
 queue.ingest([
  {key:"pilot:v4:result:101",payload:{status:"review"}},
  {key:"pilot:v4:result:102",payload:{status:"api_or_storage_error"}},
  {key:"pilot:v4:reservation:103",payload:{reservedUsd:0.05}},
  {key:"pilot:v3:result:101",payload:{status:"classified"}}
 ]);
 const result=queue.inspect([
  {id:"101",name:"Review client",organizationType:""},
  {id:"102",name:"Error client",organizationType:""},
  {id:"103",name:"Reserved client",organizationType:""}
 ]);
 assert.equal(result.total,3);
 assert.equal(result.totals.review,1);
 assert.equal(result.totals.error,1);
 assert.equal(result.totals.reservation_without_result,1);
});

test("never renders unescaped company-supplied HTML",()=>{
 queue.ingest([{key:"pilot:v4:result:104",payload:{status:"review"}}]);
 const markup=queue.render([{id:"104",name:"<script>alert(1)</script>",organizationType:""}]);
 assert.equal(markup.includes("<script>alert(1)</script>"),false);
 assert.ok(markup.includes("&lt;script&gt;"));
});

test("does not mix recovered deal-only clients into the CRM paid worklist",()=>{
 queue.ingest([{key:"pilot:v4:result:105",payload:{status:"review"}}]);
 const result=queue.inspect([{id:"105",name:"Historical",companyCardMissing:true,organizationType:""}]);
 assert.equal(result.total,0);
});

test("a previous paid AI type without sufficient evidence remains in the worklist",()=>{
 const ledger=require("./classification-ledger");
 const id="417711",name="ООО Условный Поставщик";
 const identity=ledger.identity({id,name});
 ledger.ingest([{key:ledger.PREFIX+id,payload:{
  recordType:"topsense-type-ledger-v1",companyId:id,identityHash:identity,
  type:"Интегратор АСУ ТП",rank:1,source:"Название CRM",
  savedAt:"2026-10-18T01:00:00.000Z"}}]);
 queue.ingest([{key:"pilot:v4:result:"+id,payload:{status:"review"}}]);
 const r=queue.inspect([{id,name,organizationType:"Интегратор АСУ ТП"}]);
 assert.equal(r.total,1);
 assert.equal(r.totals.provisional_prior_type,1);
 assert.equal(r.totals.already_qualified,0);
});

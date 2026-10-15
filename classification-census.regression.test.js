"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const census=require("./classification-census");
const sample={recordType:"topsense-classification-census",total:1557,typed:689,crmCards:1667,
 completedAt:"2026-10-15T02:00:00.000Z"};
test("rejects invalid and contradictory durable snapshots",()=>{
 assert.equal(census.valid({...sample,typed:1600}),false);
 assert.equal(census.valid({...sample,crmCards:1300}),false);
 assert.equal(census.valid({...sample,completedAt:"bad date"}),false);
 assert.equal(census.valid(sample),true);
});
test("keeps last completed value while website evidence restores",()=>{
 census.ingest([{key:census.KEY,payload:sample}]);
 assert.deepEqual(census.display(1557,496,false),{
  total:1557,typed:689,untyped:868,provisional:true,
  completedAt:sample.completedAt,source:"last_complete"
 });
});
test("uses live result after full restoration even when verified count corrects down",()=>{
 const p=census.display(1557,675,true);
 assert.equal(p.typed,675);
 assert.equal(p.untyped,882);
 assert.equal(p.provisional,false);
});
test("does not misrepresent prior population if company total changes",()=>{
 const p=census.display(1570,500,false);
 assert.equal(p.typed,null);
 assert.equal(p.untyped,null);
 assert.equal(p.source,"awaiting_complete");
});
test("does not save provisional or redundant readings",()=>{
 assert.equal(census.consider(1557,496,1667,false),false);
 assert.equal(census.consider(1557,689,1667,true),false);
});

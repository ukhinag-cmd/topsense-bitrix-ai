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
test("rejects silent shrinkage on an unchanged CRM and retains last completed evidence",()=>{
 const p=census.display(1557,675,true,1667);
 assert.equal(p.typed,689);
 assert.equal(p.untyped,868);
 assert.equal(p.provisional,true);
 assert.equal(p.source,"regression_under_review");
 assert.equal(p.observedTyped,675);
 assert.equal(census.consider(1557,675,1667,true),false);
});
test("last complete census survives temporary changes in virtual duplicate grouping",()=>{
 const p=census.display(1567,496,false,1667);
 assert.equal(p.total,1557);
 assert.equal(p.typed,689);
 assert.equal(p.source,"last_complete_virtual_groups_changed");
});
test("a new CRM card does not erase the prior completed census during startup",()=>{
 const p=census.display(1567,496,false,1668);
 assert.equal(p.typed,689);
 assert.equal(p.total,1557);
 assert.equal(p.provisional,true);
 assert.equal(p.source,"last_complete_crm_population_changed");
});
test("a new CRM company must not silently lower the finished typed count",()=>{
 const p=census.display(1567,500,true,1668);
 assert.equal(p.source,"regression_under_review");
 assert.equal(p.typed,689);
 assert.equal(p.observedTyped,500);
 assert.equal(census.consider(1567,500,1668,true),false);
});
test("real changes in source CRM inventory may update the finished census",()=>{
 const p=census.display(1567,675,true,1680);
 assert.equal(p.typed,675);
 assert.equal(p.provisional,false);
});
test("new companies do not make the last completed historical census vanish",()=>{
 const p=census.display(1570,500,false);
 assert.equal(p.typed,689);
 assert.equal(p.total,1557);
 assert.equal(p.untyped,868);
 assert.equal(p.provisional,true);
 assert.equal(p.source,"last_complete_virtual_groups_changed");
});
test("does not save provisional or redundant readings",()=>{
 assert.equal(census.consider(1557,496,1667,false),false);
 assert.equal(census.consider(1557,689,1667,true),false);
});

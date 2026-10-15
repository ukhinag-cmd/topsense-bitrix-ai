"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const cp=require("./purchase-checkpoint");
test("Only a verified positive shipment/payment stage can restore a buyer",()=>{
 const bad={recordType:"topsense-confirmed-purchase",companyId:"12",purchaseStatus:"НЕ БЫЛО",shipped:false,paid:false};
 assert.equal(cp.ingest([{key:cp.PREFIX+"12",payload:bad}]),0);
 assert.equal(cp.get("12"),null);
 const good={recordType:"topsense-confirmed-purchase",companyId:"12",purchaseStatus:"БЫЛА",
  shipped:true,paid:false,qualified:false,purchaseDealCount:1,
  savedAt:"2026-10-15T00:00:00.000Z",purchaseDeals:[{id:"777",stages:[{name:"Приборы отгружены"}]}]};
 assert.equal(cp.ingest([{key:cp.PREFIX+"12",payload:good}]),1);
 assert.equal(cp.get("12").purchaseStatus,"БЫЛА");
 assert.equal(cp.get("12").purchaseDeals[0].id,"777");
});
test("CRM ID mismatch is rejected; a failed later read does not remove verified purchases",()=>{
 const bad={recordType:"topsense-confirmed-purchase",companyId:"99",purchaseStatus:"БЫЛА",shipped:true};
 assert.equal(cp.ingest([{key:cp.PREFIX+"12",payload:bad}]),0);
 assert.equal(cp.get("12").purchaseStatus,"БЫЛА");
});
test("Review, WON alone and uncertain statuses do not enter purchase checkpoint",()=>{
 assert.equal(cp.queue([["13",{purchaseStatus:"БЫЛА",shipped:false,paid:false,qualified:false}],["14",{purchaseStatus:"ПРОВЕРЯЕТСЯ",shipped:true}]]),0);
 assert.equal(cp.get("13"),null);
});

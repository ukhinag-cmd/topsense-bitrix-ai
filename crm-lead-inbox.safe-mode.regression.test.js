"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const leadInbox=require("./crm-lead-inbox");
test("safe mode does not start historical lead/deal reading",async ()=>{
 const prior=process.env.TOPSENSE_ANALYTICS_PAUSE_HEAVY;
 try{
   process.env.TOPSENSE_ANALYTICS_PAUSE_HEAVY="1";
   const out=await leadInbox.refresh();
   assert.equal(out.status,"paused_for_safety");
   assert.equal(leadInbox.state.loading,false);
 }finally{
   if(prior===undefined)delete process.env.TOPSENSE_ANALYTICS_PAUSE_HEAVY;
   else process.env.TOPSENSE_ANALYTICS_PAUSE_HEAVY=prior;
 }
});

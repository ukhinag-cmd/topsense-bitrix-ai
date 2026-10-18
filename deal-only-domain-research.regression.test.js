"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const helper=require("./deal-only-domain-research");
test("deal-only synthetic site IDs are stable and separate from actual CRM IDs",()=>{
 const c={id:"dealonly:discovered:one",name:"Компания"};
 const a=helper.siteId(c),b=helper.siteId(c);
 assert.match(a,/^8[0-9]{13}$/);
 assert.equal(a,b);
 assert.equal(helper.siteId({id:"1234"}),"");
});
test("missing original incoming sender cannot silently classify a deal-only group",()=>{
 const group={id:"dealonly:discovered:noemail",name:"Предприятие",companyCardMissing:true,
  organizationType:"",dealRefs:[]};
 assert.equal(helper.domainFor(group),"");
 assert.equal(helper.apply([group])[0].organizationType,"");
});

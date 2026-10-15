"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const cache=require("./name-site-search-checkpoint");
test("negative result is reusable only for the same named CRM identity clues",()=>{
 const c={id:"1056",name:"ООО Невская Сервисная Компания",
  crmInn:"",crmPhones:[],crmEmails:[]};
 const key=cache.PREFIX+c.id;
 const row={key,payload:{recordType:"topsense-company-site-search-v2",
  version:2,companyId:c.id,fingerprint:cache.signature(c),
  status:"no_confirmed_site",checkedAt:new Date().toISOString()}};
 assert.equal(cache.ingest([row]),1);
 assert.equal(cache.get(c).status,"no_confirmed_site");
 assert.equal(cache.get({...c,crmInn:"7737106202"}),null);
 assert.equal(cache.get({...c,crmPhones:["+7 812 123 45 67"]}),null);
 assert.equal(cache.get({...c,name:"ООО Другая компания"}),null);
});
test("expired search never blocks research and forged evidence is discarded",()=>{
 const c={id:"1072",name:"ООО Производственное Предприятие",crmPhones:[]};
 const row={key:cache.PREFIX+c.id,payload:{recordType:"topsense-company-site-search-v2",
  version:2,companyId:c.id,fingerprint:cache.signature(c),
  status:"not_found",checkedAt:"2025-01-01T00:00:00Z"}};
 assert.equal(cache.ingest([row]),1);
 assert.equal(cache.get(c),null);
 assert.equal(cache.ingest([{key:cache.PREFIX+"notcompany",payload:row.payload}]),0);
});

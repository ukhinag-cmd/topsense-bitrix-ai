"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const registry=require("./deal-only-sender-ledger");
test("durable sender-domain mapping survives checkpoint reload without a Bitrix company card",()=>{
 const id="dealonly:discovered:factory-not-crm";
 const key=registry.key(id);
 assert.match(key,/^site-profile:v1:7[0-9]{13}$/);
 const restored=registry.ingest([{key,payload:{
  recordType:"topsense-deal-only-sender-domain-v1",id,domain:"factory.ru",
  verifiedFrom:"original_inbound_sender",observedAt:"2026-10-18T14:00:00Z"
 }}]);
 assert.equal(restored,1);
 assert.equal(registry.get(id),"factory.ru");
});
test("never ingest public-mail domain or mismatch identity key",()=>{
 const id="dealonly:discovered:public-mail";
 assert.equal(registry.ingest([{key:registry.key(id),payload:{
  recordType:"topsense-deal-only-sender-domain-v1",id,domain:"gmail.com"
 }}]),0);
 assert.equal(registry.ingest([{key:"site-profile:v1:799",payload:{
  recordType:"topsense-deal-only-sender-domain-v1",id,domain:"factory.ru"
 }}]),0);
 assert.equal(registry.get(id),"");
});

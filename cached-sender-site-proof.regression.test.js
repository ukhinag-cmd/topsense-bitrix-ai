"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const cached=require("./cached-sender-site-proof");
const site={status:"site_profiled",siteType:"Монтажно-строительная организация",
 url:"https://www.factory.ru",siteActivityReason:"Монтаж технологического оборудования"};
const deal={incomingEmails:1,senderEmails:["manager@factory.ru"]};
test("exact incoming corporate domain independently corroborates previously studied site",()=>{
 assert.equal(cached.match({dealEvidence:[deal]},site),"factory.ru");
});
test("wrong site and absence of sender proof reject inferred activity",()=>{
 assert.equal(cached.match({dealEvidence:[deal]},{...site,url:"https://other.ru"}),"");
 assert.equal(cached.match({dealEvidence:[{incomingEmails:0,senderEmails:["manager@factory.ru"]}]},site),"");
 assert.equal(cached.match({dealEvidence:[{incomingEmails:1,senderEmails:["buyer@gmail.com"]}]},site),"");
});
test("conflicting sender domains, vague site, and unclassified profile remain review-only",()=>{
 assert.equal(cached.match({dealEvidence:[deal,{incomingEmails:1,senderEmails:["a@another.ru"]}]},site),"");
 assert.equal(cached.match({dealEvidence:[deal]},{...site,siteActivityReason:""}),"");
 assert.equal(cached.match({dealEvidence:[deal]},{...site,status:"site_read_ambiguous_type"}),"");
});

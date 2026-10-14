"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const mail=require("./company-email-domains"),store=require("./site-profile-store");
test("all company email entries are scanned, not just first public mailbox",()=>{
 const emails=[{VALUE:"director@mail.ru"},{VALUE:"sales@plant-example.ru"},{VALUE:"hr@plant-example.ru"}];
 assert.deepEqual(mail.extract(emails),["plant-example.ru"]);
});
test("linked contacts with different corporate domains are not silently discarded",()=>{
 const ranks=mail.ranked(["person@other-example.ru","director@plant-example.ru","engineer@plant-example.ru"]);
 assert.deepEqual(ranks,[["plant-example.ru",2],["other-example.ru",1]]);
});
test("public mail providers and internal TOP-SENSE mail are not treated as client sites",()=>{
 assert.deepEqual(mail.extract(["a@gmail.com","b@yandex.ru","c@topsense.su"]),[]);
});
test("corporate mail outranks unverified CRM website without changing verified legal site",()=>{
 assert.equal(store.inputUrl({siteCandidate:"https://old-example.ru",siteSource:"Сайт из CRM",corporateDomain:"plant-example.ru"}),"https://plant-example.ru");
 assert.equal(store.inputUrl({siteCandidate:"https://verified-example.ru",siteSource:"Официальный сайт, проверенный по юридическим данным",corporateDomain:"group-example.ru"}),"https://verified-example.ru");
});
test("changing preferred corporate domain invalidates old site profile evidence",()=>{
 const old={id:"400",name:"ООО Промсервис",siteCandidate:"https://old-example.ru",siteSource:"Сайт из CRM",corporateDomain:"first-example.ru"};
 const changed={...old,corporateDomain:"second-example.ru"};
 assert.notEqual(store.fingerprint(old),store.fingerprint(changed));
});

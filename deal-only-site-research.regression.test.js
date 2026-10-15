"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const intake=require("./crm-deal-intake");
const research=require("./deal-only-site-research");
const search=require("./name-site-search");
test("Extract INN, corporate/free sender email, company URL and phone from later incoming email",()=>{
 const content=[
 {ID:"10",TYPE_ID:"4",DIRECTION:"1",SUBJECT:"КП на 310",
  DESCRIPTION:"Здравствуйте, прибор нужен срочно",
  COMMUNICATIONS:[{VALUE:"buyer@mail.ru"}]},
 {ID:"11",TYPE_ID:"4",DIRECTION:"2",SUBJECT:"Ответ менеджера",
  DESCRIPTION:"Направили ТКП"},
 {ID:"12",TYPE_ID:"4",DIRECTION:"1",
  DESCRIPTION:"Наименование компании: ООО «Инжиниринговые системы-16»; ИНН 8603223202; сайт https://is-16.su/contacts/ телефон +7 902 855 51 05",
  COMMUNICATIONS:[{VALUE:"sales@is-16.su"},{VALUE:"info@topsense.su"}]}
 ];
 const d=intake.summarizeActivities(content);
 assert.equal(d.firstIncomingSubject,"КП на 310");
 assert.equal(d.incomingEmails,2);
 assert.deepEqual(d.senderEmails.sort(),["buyer@mail.ru","sales@is-16.su"]);
 assert.ok(d.websiteHints.includes("https://is-16.su"));
 assert.ok(d.phoneHints.includes("+7 902 855 51 05"));
 const e=research.evidenceFor({id:"dealonly:test",dealRefs:[{id:"512"}]},
  ()=>({...d}));
 assert.equal(e.inn,"8603223202");
 assert.equal(e.dealReadCount,1);
 assert.ok(e.candidateSites.includes("https://is-16.su"));
 const prepared=research.prepare({id:"dealonly:test",name:"ИС-16"},e);
 assert.equal(search.eligible(prepared),true);
 assert.equal(prepared.dealOnlyResearch,true);
 assert.equal(prepared.crmInn,"8603223202");
 assert.ok(prepared.crmEmails.includes("sales@is-16.su"));
 assert.equal(prepared.siteCandidate,""); // candidate is NOT a verified website
});
test("Corporate email without independent identity match is only a site candidate",()=>{
 const e=research.evidenceFor({id:"dealonly:industrial",siteCandidate:"https://holding.example.org",
  dealRefs:[{id:"108"}]},
  ()=>({incomingEmails:1,senderEmails:["purchase@subsidiary.ru"],requisitesInnCandidates:[]}));
 assert.equal(e.inn,"");
 assert.ok(e.candidateSites.includes("https://subsidiary.ru"));
 assert.ok(e.candidateSites.includes("https://holding.example.org"));
 const c=research.enrich({id:"dealonly:industrial",name:"Нефтегаз комплект",dealRefs:[]},()=>null);
 assert.ok(!c.websiteResearch.checkedSite);
 assert.equal(c.websiteResearch.activityTypeConfirmedBySite,false);
});
test("Conflicting INNs from different letters never become a trusted site identity",()=>{
 const e=research.evidenceFor({id:"dealonly:conflict",dealRefs:[{id:"1"},{id:"2"}]},id=>({
  requisitesInnCandidates:id==="1"?["7707083893"]:["7737106202"],
  incomingEmails:1,senderEmails:["purchase@company.ru"]}));
 assert.equal(e.innConflict,true);
 const plan=research.prepare({id:"dealonly:conflict",name:"ООО «Компания Пром-Сервис»"},e);
 assert.equal(plan.crmInn,"");
 assert.equal(plan.dealOnlyResearch,true);
});
test("A distinct holding website must not be asserted as a company confirmed site",()=>{
 const c={id:"dealonly:holding_test",name:"ООО «ГСП-7»",
  siteCandidate:"https://gsprom.ru/",dealRefs:[]};
 const observed=research.enrich(c,()=>null);
 assert.equal(observed.websiteResearch.checkedSite,"");
 assert.equal(observed.siteCandidate,"https://gsprom.ru/");
});

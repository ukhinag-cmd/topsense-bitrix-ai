"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"crm-dashboard.js"),"utf8");
const email=require("./company-email-domains");
function harness(){
 const submitted=[],known=new Map(),retry=[],legalMap=new Map(),innQueued=[],dealCases=new Map();
 const profiler={
  get:id=>({status:known.get(String(id))||"site_absent"}),
  stats:()=>({restorationComplete:true,queued:0,active:0}),
  enqueue:list=>{submitted.push(...list);return list.length},
  retryTransient:list=>{retry.push(...list);return 0}
 };
 const req=x=>{
  if(x==="crypto")return require("node:crypto");
  if(x==="fs")return {readFileSync:()=>""};
  if(x==="path")return {join:()=>"/test"};
  if(x==="./company-types")return require("./company-types");
  if(x==="./company-email-domains")return email;
  if(x==="./website-profiler")return profiler;
  if(x==="./crm-deal-intake")return {forCompany:id=>dealCases.get(String(id))||[]};
  if(x==="./company-requisites")return {stats:()=>({status:"ready"}),get:id=>legalMap.get(String(id))||{status:"not_found"}};
  if(x==="./name-site-search")return {stats:()=>({remaining:0}),enqueueByInn:list=>{innQueued.push(...list);return list.length}};
  throw Error("Unexpected top-level or scheduler import "+x);
 };
 const mod={exports:{}},logs=[];
 vm.runInNewContext(source+"\nmodule.exports.__resume=resumeUnresolvedCompanySites;module.exports.__state=state;",
  {require:req,module:mod,exports:mod.exports,process:{env:{}},URL,URLSearchParams,Buffer,__dirname:"/test",
   setTimeout:()=>0,setInterval:()=>0,console:{log:x=>logs.push(JSON.parse(x)),warn:()=>{}}},
  {filename:"crm-dashboard.js"});
 const state=mod.exports.__state;
 state.companies=[];state.contactsAt="2026-10-15";
 return {state,profiler,known,submitted,retry,legalMap,innQueued,dealCases,logs,resume:mod.exports.__resume};
}
test("exhausted queue recovers a missing site from a linked contact domain",()=>{
 const h=harness();
 h.state.companies=[{id:"17",name:"Repair Services",crmEmails:[],siteCandidate:"",corporateDomain:""}];
 h.state.linkedContacts.set("17",{emails:new Set(["technician@repair-industrial.ru"]),names:[]});
 h.resume();
 assert.equal(h.submitted.length,1);
 assert.equal(h.submitted[0].corporateDomain,"repair-industrial.ru");
 assert.equal(h.submitted[0].siteSource,"Альтернативный домен привязанного контакта");
});
test("identity-unclear site may use second linked-contact domain, verified site cannot",()=>{
 const h=harness();
 h.state.companies=[
  {id:"22",name:"Maintenance Services",corporateDomain:"shared-holding.ru",crmEmails:["office@shared-holding.ru"]},
  {id:"23",name:"Verified Organisation",corporateDomain:"verified.ru",verifiedOrgType:"Интегратор АСУ ТП"}];
 h.known.set("22","site_identity_unclear");
 h.known.set("23","site_unavailable");
 h.state.linkedContacts.set("22",{emails:new Set(["operator@different-contractor.ru"]),names:[]});
 h.state.linkedContacts.set("23",{emails:new Set(["other@wrong-party.ru"]),names:[]});
 h.resume();
 assert.equal(h.submitted.length,1);
 assert.equal(h.submitted[0].id,"22");
 assert.equal(h.submitted[0].corporateDomain,"different-contractor.ru");
});
test("there is an explicit queue exhaustion event rather than a fake processing claim",()=>{
 const h=harness();
 h.state.companies=[{id:"25",name:"Unknown client",crmEmails:[],corporateDomain:""}];
 h.resume();
 assert.equal(h.submitted.length,0);
 assert.ok(h.logs.some(x=>x.event==="research-queue-exhausted"));
});

test("exhausted site queue schedules distinct verified-INN lookup",()=>{
 const h=harness();
 h.state.companies=[{id:"31",name:"OOO Industrial Automation",crmEmails:[],corporateDomain:"",siteCandidate:""}];
 h.legalMap.set("31",{status:"inn_recorded",inn:"7707083893"});
 h.resume();
 assert.equal(h.innQueued.length,1);
 assert.equal(h.innQueued[0].crmInn,"7707083893");
 assert.ok(h.logs.some(x=>x.event==="inn-site-discovery-started"&&x.queued===1));
});

test("deal inbound email domain is tried before manual CRM cards for an unlinked website",()=>{
 const h=harness();
 h.state.companies=[{id:"33",name:"ООО Промышленный сервис",crmEmails:[],corporateDomain:"",siteCandidate:""}];
 h.dealCases.set("33",[{id:"6000",incomingEmails:1,corporateDomains:["industrial-service.ru"]}]);
 h.resume();
 assert.equal(h.submitted.length,1);
 assert.equal(h.submitted[0].siteSource,"Домен из входящей сделки");
 assert.equal(h.submitted[0].corporateDomain,"industrial-service.ru");
 assert.ok(h.logs.some(x=>x.event==="deal-email-website-candidates-queued"));
});

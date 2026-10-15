"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const intake=require("./crm-deal-intake");
const sites=require("./name-site-search");
test("first inbound email is read chronologically; later correspondence adds need and company card",()=>{
 const rows=[
  {ID:"9",TYPE_ID:"4",DIRECTION:"2",SUBJECT:"КП отправлено"},
  {ID:"13",TYPE_ID:"4",DIRECTION:"1",CREATED:"2026-10-01T09:00:00+03:00",
   SUBJECT:"Первый запрос H2S O2"},
  {ID:"18",TYPE_ID:"4",DIRECTION:"2",SUBJECT:"Ответ менеджера",
   FILES:[{NAME:"Карточка предприятия.pdf"}]},
  {ID:"27",TYPE_ID:"4",DIRECTION:"1",SUBJECT:"Дополнение: NH3, стационарный",
   DESCRIPTION:"Реквизиты ИНН 8603223202"}
 ];
 const x=intake.summarizeActivities(rows.reverse());
 assert.equal(x.firstIncomingAt,"2026-10-01T09:00:00+03:00");
 assert.equal(x.firstIncomingSubject,"Первый запрос H2S O2");
 assert.deepEqual(x.firstIncomingSignals.gases,["H2S","O2"]);
 assert.deepEqual(x.laterCorrespondenceSignals.gases,["NH3"]);
 assert.deepEqual(x.signals.gases,["H2S","O2","NH3"]);
 assert.equal(x.incomingEmails,2);
 assert.equal(x.subsequentIncomingEmails,1);
 assert.equal(x.companyCardAttachmentCount,1);
 assert.equal(x.laterAttachmentCount,1);
 assert.deepEqual(x.requisitesInnCandidates,["8603223202"]);
});
test("short IS-16 identifier can enter independent website verification by CRM phone",()=>{
 const company={name:"ИС -16",crmPhones:["+7 (902) 855-51-05"],crmEmails:["test@mail.ru"]};
 assert.equal(sites.eligible(company),true);
 assert.equal(sites.eligible({...company,crmPhones:[]}),false);
 assert.equal(sites.eligible({...company,name:"Без названия"}),false);
 const pages=[{meta:{title:"ИС-16",description:"Контакты +7 902 855-51-05",
  headings:[],body:"Нижневартовск",identityText:"Телефон: +7 902 855-51-05"}}];
 const proof=sites.legalOrPhoneMatch(company,pages);
 assert.equal(proof.matched,true);
 assert.equal(proof.phoneMatch,true);
});
test("matching name alone never confirms an external website",()=>{
 const company={name:"ООО ИС-16",crmPhones:[],crmInn:""};
 const pages=[{meta:{title:"ООО ИС-16",description:"",
  headings:[],body:"Нижневартовск",identityText:""}}];
 assert.equal(sites.legalOrPhoneMatch(company,pages).matched,false);
});

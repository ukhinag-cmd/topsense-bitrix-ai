"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const overview=require("./client-overview");
const segments=require("./client-segments");
const main="https://avsv.gazprom-neft.ru/";
const group="https://gazprom-neft.ru/";
const record={id:"114",name:"АВТОМАТИКА-СЕРВИС",category:"Проектные продажи",
 crmUrl:"https://topsense.bitrix24.ru/crm/company/details/114/",
 crmIdList:["114"],siteCandidate:main,siteReferenceEvidence:"Independent legal identity and phone matched",
 corporateGroup:"ПАО Газпром нефть",siteStatus:"site_unavailable",
 relatedWebsites:[{url:group,relation:"corporate_group",label:"Сайт группы компаний",organization:"ПАО Газпром нефть"}]};
test("Company's own subdomain is the primary link and group's root remains secondary",()=>{
 const w=overview.companyWebsiteDetails(record);
 assert.equal(w.url,main);
 assert.equal(w.domain,"avsv.gazprom-neft.ru");
 assert.equal(w.verified,false);
 assert.equal(w.related.length,1);
 assert.equal(w.related[0].url,group);
 const html=overview.render({companies:[record]},"Обзор");
 assert.ok(html.includes('class="companyWebsite" href="'+main+'"'));
 assert.ok(html.includes('Основной сайт: <a'));
 assert.ok(html.includes("avsv.gazprom-neft.ru"));
 assert.ok(html.includes("Сайт группы ПАО Газпром нефть"));
 assert.ok(html.includes("gazprom-neft.ru ↗"));
 assert.ok(html.includes("не сайт этого юрлица"));
});
test("An outdated, mistakenly studied group homepage cannot override the legal entity site",()=>{
 const w=overview.companyWebsiteDetails({...record,siteProfileUrl:group,siteVerified:group,siteStatus:"site_profiled"});
 assert.equal(w.url,main);
 assert.equal(w.verified,false);
 assert.equal(w.related[0].url,group);
});
test("When only a group website is known, it is not presented as the company's own website",()=>{
 const v={...record,siteCandidate:"",siteReferenceEvidence:"",siteProfileUrl:group,siteVerified:group,siteStatus:"site_profiled"};
 const w=overview.companyWebsiteDetails(v);
 assert.equal(w.url,"");
 assert.equal(w.related.length,1);
 const html=overview.render({companies:[v]},"Обзор");
 assert.ok(!html.includes('class="companyWebsite"'));
 assert.ok(html.includes("Сайт группы ПАО Газпром нефть"));
 assert.ok(!html.includes("Сайт изучен"));
});
test("An unrelated corporate email domain does not create a fake group relation",()=>{
 const w=overview.companyWebsiteDetails({name:"Другая компания",corporateDomain:"gazprom-neft.ru"});
 assert.equal(w.url,"");
 assert.deepEqual(w.related,[]);
});
test("Detailed client view carries both site references without merging CRM identities",()=>{
 const html=segments.html({companies:[record],crmCardTotal:1});
 assert.ok(html.includes("avsv.gazprom-neft.ru"));
 assert.ok(html.includes("gazprom-neft.ru"));
 assert.ok(html.includes("Основной сайт:"));
 assert.ok(html.includes("Сайт группы "));
 assert.ok(html.includes("другое юрлицо"));
 assert.ok(html.includes("CRM ID"));
});

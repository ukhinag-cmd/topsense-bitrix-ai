"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const finder=require("./name-site-search");
const company={id:"1056",name:'ООО «Невская Сервисная Компания»',crmPhones:[],
 crmEmails:[],crmInn:""};
test("exact own title with legal form may enter provisional research",()=>{
 const pages=[{pageUrl:"https://nevskaya.example/",
 meta:{title:"ООО Невская Сервисная Компания — официальный сайт",
 headings:["О компании"],identityText:"Невская сервисная компания оказывает услуги"}}];
 assert.equal(finder.legalNameOnOwnSite(company,pages),true);
});
test("holding partner list must not be treated as its subsidiaries legal identity",()=>{
 const pages=[{pageUrl:"https://holding.example.org/partners/",
 meta:{title:"Холдинг — подрядчики",headings:["Наши партнёры"],
 identityText:"Партнеры: ООО Невская Сервисная Компания, АО Новый завод"}}];
 assert.equal(finder.legalNameOnOwnSite(company,pages),false);
});
test("no fabricated OPF; near names are insufficient",()=>{
 const pages=[{pageUrl:"https://nevskaya.example/",
 meta:{title:"Невская Сервисная Компания",headings:[],identityText:"Контакты"}}];
 assert.equal(finder.legalNameOnOwnSite(company,pages),false);
 assert.equal(finder.legalNameOnOwnSite({name:"НЕВСКАЯ СЕРВИСНАЯ КОМПАНИЯ"},pages),false);
});
test("site with stated legal name on requisites page is a provisional candidate",()=>{
 const pages=[{pageUrl:"https://nevskaya.example/requisites/",
 meta:{title:"Реквизиты",headings:["Контакты"],
 identityText:"Реквизиты: юридическое лицо ООО «Невская Сервисная Компания» ИНН: не указан"}}];
 assert.equal(finder.legalNameOnOwnSite(company,pages),true);
});

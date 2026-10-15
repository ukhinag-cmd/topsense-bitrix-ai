"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const path=require("node:path");
const code=fs.readFileSync(path.join(__dirname,"client-type-inference.js"),"utf8");
const types=require("./company-types").types;
const bryanskProfile={status:"site_profiled",source:"Корпоративный домен e-mail CRM",
 url:"https://bryanskpivo.ru",siteTitle:"Официальный сайт АО Брянскпиво",
 siteDescription:"АО Брянскпиво — предприятие пищевой промышленности",
 siteHeadings:["Контакты","О компании","Безалкогольные напитки","Солод","О производстве"],
 siteType:"Промышленный генподрядчик"};
const bryanskCard={id:"2872",name:'АО "Брянскпиво"',category:"Не определены",
 aiExplanation:"Производитель напитков и солода",siteVerified:"https://bryanskpivo.ru",
 crmUrl:"https://topsense.bitrix24.ru/crm/company/details/2872/",organizationType:""};
function setup(site){
 const module={exports:{}};
 const fakeRequire=n=>{
  if(n==="./company-types")return{types};
  if(n==="./client-taxonomy")return require("./client-taxonomy");
  if(n==="./website-profiler")return{get:()=>site};
  if(n==="./client-finalization")return{isComplete:()=>false,apply:c=>c};
  if(n==="./corporate-role-evidence")return{classify:()=>null};
  throw Error("Unexpected module: "+n);
 };
 vm.runInNewContext(code,{module,exports:module.exports,require:fakeRequire},{filename:"client-type-inference.js"});
 return module.exports;
}
test("Brewery 2872 keeps its verified site but is never an industrial general contractor",()=>{
 const value=setup(bryanskProfile).apply([bryanskCard])[0];
 assert.equal(value.id,"2872");
 assert.equal(value.category,"Конечные потребители");
 assert.equal(value.organizationType,"Производство напитков");
 assert.match(value.industryDescription,/пива.*солода/);
 assert.equal(value.siteProfileUrl,"https://bryanskpivo.ru");
});
test("Old paid classification evidence provides fallback while website cache is restoring",()=>{
 const value=setup(null).apply([bryanskCard])[0];
 assert.equal(value.category,"Конечные потребители");
 assert.equal(value.organizationType,"Производство напитков");
});
test("First-party beverage manufacturing beats third-party construction terms in site text",()=>{
 const classifier=setup(bryanskProfile);
 const pages=[{pageUrl:"https://bryanskpivo.ru/brand/about",meta:{
  title:"О компании АО Брянскпиво",
  description:"Производитель пива и солода",
  headings:["О производстве","Безалкогольные напитки","Солод"],
  body:"В истории реконструкции упоминались Промстрой, генеральный подряд и строительные организации. Мы производим напитки и солод."}}];
 const found=classifier.inferWebsiteActivity(pages,'АО "Брянскпиво"');
 assert.equal(found.type,"");
});
test("Actual construction contractors keep their industrial-contractor classification",()=>{
 const site={status:"site_profiled",url:"https://stroy.example",siteTitle:"Генподрядные работы",
  siteDescription:"Строительство промышленных объектов",
  siteHeadings:["Услуги генподряда"],siteType:"Промышленный генподрядчик"};
 const value=setup(site).apply([{id:"14",name:"ООО Промстрой",organizationType:"",category:"Подрядчики"}])[0];
 assert.equal(value.organizationType,"Промышленный генподрядчик");
 assert.equal(value.category,"Подрядчики");
});

test("Mentioning a construction contractor in another factory's site does not make that factory a general contractor",()=>{
 const classifier=setup(null);
 const pages=[{pageUrl:"https://industrial.example/about",meta:{
  title:"О компании Производственный завод",
  description:"Производство оборудования и компонентов",
  headings:["Наш завод","Реконструкция"],
  body:"Реконструкцию здания выполнял ООО Промстрой. Основное направление нашего завода — производство приборов."}}];
 const result=classifier.inferWebsiteActivity(pages,"АО Завод измерительной техники");
 assert.ok(result.type!=="Промышленный генподрядчик", "Third-party supplier reference cannot classify an unrelated producer as contractor");
});
test("First-party explicit general-contractor claims are still eligible",()=>{
 const classifier=setup(null);
 const pages=[{pageUrl:"https://construction.example/about",meta:{
  title:"О компании: промышленное строительство и генподряд",
  description:"Компания осуществляет комплексные строительные проекты",
  headings:["Наши услуги"],
  body:"Мы выполняем функции генерального подрядчика, осуществляем генподряд и строим промышленные объекты."}}];
 const result=classifier.inferWebsiteActivity(pages,"ООО Компания Инжиниринг");
 assert.equal(result.type,"Промышленный генподрядчик");
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const types=require("./company-types").types;
const taxonomy=require("./client-taxonomy");
const source=fs.readFileSync(path.join(__dirname,"client-type-inference.js"),"utf8");
function build(site){
 const mod={exports:{}};
 const requireMock=p=>{
  if(p==="./client-taxonomy")return taxonomy;
  if(p==="./website-profiler")return {get:()=>site};
  if(p==="./client-finalization")return {isComplete:()=>false,apply:x=>x};
  if(p==="./corporate-role-evidence")return {classify:()=>null};
  throw Error("Unexpected dependency "+p);
 };
 vm.runInNewContext(source,{module:mod,exports:mod.exports,require:requireMock},{filename:"client-type-inference.js"});
 return mod.exports;
}
const site={
 status:"site_profiled",source:"Домен привязанного контакта",url:"https://tekstro.ru",
 siteTitle:"Главная",siteDescription:"",
 siteHeadings:["Капитальное строительство","Монтажные работы","Теплоизоляционные работы","Антикоррозийная обработка","Благотворительность"],
 siteType:"Непрофильный контрагент"
};
test("CRM 680 TЭКСТРО corrects old false non-profile classification from stored site evidence",()=>{
 const record=build(site).apply([{id:"680",name:"ТЭКСТРО",organizationType:"",siteCandidate:"https://tekstro.ru"}])[0];
 assert.equal(record.id,"680");
 assert.equal(record.organizationType,"Промышленный генподрядчик");
 assert.equal(record.category,"Подрядчики");
 assert.equal(record.siteProfileUrl,"https://tekstro.ru");
 assert.match(record.segmentSource,/строительство|монтаж/);
});
test("Full first-party website prose takes priority over charity and schools",()=>{
 const article="ООО ТЭКСТРО, выполняя функции генерального подрядчика, выполняет капитальное строительство и ремонт объектов нефтехимии и нефтепереработки. Компания участвует в благотворительности, помогает школам.";
 const result=build(null).inferWebsiteActivity([{pageUrl:"https://tekstro.ru/o-kompanii/",meta:{
  title:"О компании ТЭКСТРО",description:article,body:article,headings:["Капитальное строительство"]}}],"ООО ТЭКСТРО");
 assert.equal(result.type,"Промышленный генподрядчик");
});
test("Charity without substantial own industrial service evidence remains unrelated",()=>{
 const fake={status:"site_profiled",url:"https://charity.example",siteHeadings:["Благотворительность","Помощь школе","Монтируем оборудование для мероприятия"],
  siteType:"Непрофильный контрагент"};
 const result=build(fake).apply([{id:"44",name:"Благотворительный фонд",organizationType:"Непрофильный контрагент",category:"Смежные организации"}])[0];
 assert.equal(result.organizationType,"Непрофильный контрагент");
});
test("Factory that merely mentions a third-party general contractor is not the contractor",()=>{
 const article="Реконструкцию цеха выполнял подрядчик ООО Промстрой. Сам завод выпускает напитки и солод.";
 const result=build(null).inferWebsiteActivity([{pageUrl:"https://factory.example/o-kompanii/",meta:{
  title:"Наше производство",description:article,body:article,headings:["История"]}}],"АО Пищевой завод");
 assert.notEqual(result?.type,"Промышленный генподрядчик");
});
test("Legitimate stored typed contractor is not displaced by irrelevant site headlines",()=>{
 const saved={status:"site_profiled",url:"https://contractor.example",siteHeadings:["Капитальный ремонт","Контакты","Обучение персонала"],
  siteType:"Промышленный генподрядчик"};
 const result=build(saved).apply([{id:"45",name:"ООО Промстрой",organizationType:"Промышленный генподрядчик",category:"Подрядчики"}])[0];
 assert.equal(result.organizationType,"Промышленный генподрядчик");
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const types=require("./company-types").types;
const taxonomy=require("./client-taxonomy");
const overview=require("./client-overview");
const inferText=fs.readFileSync(path.join(__dirname,"client-type-inference.js"),"utf8");
const bryanskSite={status:"site_profiled",url:"https://bryanskpivo.ru",
 siteTitle:"Официальный сайт АО Брянскпиво",
 siteDescription:"Производство напитков, пива и солода",
 siteHeadings:["Безалкогольные напитки","Солод","О производстве"],
 siteType:"Промышленный генподрядчик"};
function inference(site){
 const module={exports:{}};
 const requireMock=p=>{
  if(p==="./client-taxonomy")return taxonomy;
  if(p==="./website-profiler")return{get:()=>site};
  if(p==="./client-finalization")return{isComplete:()=>false,apply:c=>c};
  if(p==="./corporate-role-evidence")return{classify:()=>null};
  throw Error("Unexpected dependency "+p);
 };
 vm.runInNewContext(inferText,{module,exports:module.exports,require:requireMock},{filename:"client-type-inference.js"});
 return module.exports;
}
test("The 45-category seed expands into four concrete production sectors",()=>{
 assert.equal(types.length,49);
 for(const name of ["Производство напитков","Производство бытовой химии",
   "Производство табачных изделий","Производство удобрений"])assert.ok(taxonomy.known(name));
});
test("Bryanskpivo gets a real product subtype without new browsing or paid AI",()=>{
 const result=inference(bryanskSite).apply([{
  id:"2872",name:'АО "Брянскпиво"',siteVerified:"https://bryanskpivo.ru",
  aiExplanation:"Производитель напитков и солода",organizationType:"",category:"Не определены"}])[0];
 assert.equal(result.organizationType,"Производство напитков");
 assert.equal(result.category,"Конечные потребители");
 assert.equal(result.siteProfileUrl,"https://bryanskpivo.ru");
});
test("Specific first-party household chemical, tobacco and fertilizer plants receive distinct types",()=>{
 const items=[
  ["Производство бытовой химии","БытХим","Мы производим бытовую химию и чистящие средства."],
  ["Производство табачных изделий","Табачная фабрика","Наше собственное производство выпускает сигареты и табачные изделия."],
  ["Производство удобрений","Агрохим","Мы производим минеральные удобрения и карбамид."]
 ];
 for(const [expected,company,body] of items){
  const result=inference(null).inferWebsiteActivity([{pageUrl:"https://plant.example/o-kompanii",
   meta:{title:company,description:body,body,headings:["О производстве"]}}],company);
  assert.equal(result.type,expected);
 }
});
test("Website dealers without own production are not automatically classed as factories",()=>{
 const result=inference(null).inferWebsiteActivity([{pageUrl:"https://market.example/about",
  meta:{title:"Магазин химических средств",description:"Интернет-магазин, поставщик бытовой химии",
   body:"Наш интернет-магазин продаёт бытовую химию других изготовителей",headings:["Каталог"]}}],"ООО Маркет");
 assert.notEqual(result?.type,"Производство бытовой химии");
});
test("New factual business subtype is registered once and immediately displayed in the existing dashboard",()=>{
 const accepted={newSubtype:"Производство оптических компонентов",newSubtypeQuote:"Мы производим оптические компоненты",
  newSubtypeApproved:true,siteOwnership:"confirmed",companyId:901,website:"https://optika.example",status:"classified"};
 assert.equal(taxonomy.registerFromPilot(accepted),true);
 assert.equal(taxonomy.registerFromPilot(accepted),false);
 assert.ok(taxonomy.known(accepted.newSubtype));
 const output=overview.render({companies:[{id:"901",name:"Оптический завод",
  organizationType:accepted.newSubtype,category:"Конечные потребители"}]},"Обзор",accepted.newSubtype);
 assert.ok(output.includes("Оптический завод"));
 assert.ok(output.includes(encodeURIComponent(accepted.newSubtype)));
});
test("Fabricated subtype with no supporting website quote is rejected",()=>{
 const proposed={newSubtype:"Производство несуществующих товаров",newSubtypeApproved:false,
  newSubtypeQuote:"",siteOwnership:"uncertain",website:"https://unverified.example"};
 assert.equal(taxonomy.registerFromPilot(proposed),false);
 assert.equal(taxonomy.known(proposed.newSubtype),false);
});

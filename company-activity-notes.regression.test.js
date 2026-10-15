"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const notes=require("./company-activity-notes");
const inference=require("./client-type-inference");
test("Descriptive manager note can provisionally classify the actual industrial manufacturer",()=>{
 const parsed=notes.infer("[p]Завод производит горнопроходческие комбайновые комплексы, погрузочные машины.[/p]");
 assert.equal(parsed?.type,"Машиностроительный завод");
 assert.match(parsed.confidence,/Предварительная/);
 const raw={id:"10014",name:"Копейское предприятие",crmActivityHint:parsed};
 const sites=require("./website-profiler"),before=sites.get;
 try{
  sites.get=()=>({status:"site_absent"});
  const result=inference.apply([raw])[0];
  assert.equal(result.organizationType,"Машиностроительный завод");
  assert.match(result.segmentSource,/CRM/);
  assert.match(result.segmentConfidence,/Предварительная/);
 }finally{sites.get=before}
});
test("A real customer purchase or an inquiry for gas analyzers is not evidence of own activity",()=>{
 for(const s of [
  "Хотят Топ-Сенс 310 на метан и кислород для своего цеха",
  "Не занимаются газоанализаторами. Купили для себя. 15.04.",
  "Специалист по газоанализаторам предложил договор",
  "Будут присылать новые заявки на приборы",
  "Наша компания готова сотрудничать, можете выставить счет?"
 ]){
  assert.equal(notes.infer(s),null,s);
 }
});
test("Explicit dealer note may identify an equipment distributor, but a contradictory business-name hint blocks it",()=>{
 const detail=notes.infer("Они занимаются продажей электромеханических оборудований. Запросы на газоанализаторы.");
 assert.equal(detail?.type,"Дистрибьютор / оптовый поставщик");
 const sites=require("./website-profiler"),old=sites.get;
 try{
  sites.get=()=>({status:"site_absent"});
  const case1=inference.apply([{id:"987",name:"Линия",crmActivityHint:detail}])[0];
  assert.equal(case1.organizationType,detail.type);
  const case2=inference.apply([{id:"988",name:"Нефтеперерабатывающий завод",crmActivityHint:detail}])[0];
  assert.equal(case2.organizationType,"");
  assert.match(case2.segmentConfidence,/Конфликт/);
 }finally{sites.get=old}
});

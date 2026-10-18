"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const activity=require("./crm-first-party-activity");
const intake=require("./crm-deal-intake");
const name="ООО Примермонтаж",inn="7737106202";
function profile(description){
 const p=intake.summarizeActivities([{ID:"1001",TYPE_ID:4,DIRECTION:1,PROVIDER_ID:"CRM_EMAIL",DESCRIPTION:description}]);
 return {...p,id:"300",companyId:"25"};
}
test("self-described activity qualifies only when legal name and INN agree",()=>{
 const p=profile("Мы занимаемся монтажом технологического оборудования на промышленных объектах.\nНаименование организации: ООО Примермонтаж; ИНН: 7737106202");
 assert.equal(p.firstPartyActivities.length,1);
 const c={id:"25",name};
 assert.equal(activity.decide(c,[p],{status:"inn_recorded",inn})?.type,"Монтажно-строительная организация");
 assert.equal(activity.decide({...c,name:"ООО Другая"},[p],{status:"inn_recorded",inn}),null);
 assert.equal(activity.decide(c,[p],{status:"inn_conflict",inn:""}),null);
});
test("purchase request and forwards never prove business type",()=>{
 const p=profile("Хотим купить газоанализаторы H2S.\nНаименование организации: ООО Примермонтаж; ИНН: 7737106202");
 assert.equal(p.firstPartyActivities.length,0);
 const forwarded=profile("Требуется КП.\n----- Original Message -----\nМы занимаемся монтажом технологического оборудования на промышленных объектах.\nИНН: 7737106202");
 assert.equal(forwarded.firstPartyActivities.length,0);
});

test("provisional name-based guess yields to corroborated original letter, confirmed type does not",()=>{
 const p=profile("Мы занимаемся монтажом технологического оборудования на промышленных объектах.\nНаименование организации: ООО Примермонтаж; ИНН: 7737106202");
 const proposed={id:"25",name,organizationType:"Интегратор КИПиА",
  proposedType:"Интегратор КИПиА",verification:"Предварительная классификация"};
 assert.equal(activity.decide(proposed,[p],{status:"inn_recorded",inn})?.type,
  "Монтажно-строительная организация");
 assert.equal(activity.decide({...proposed,verificationStatus:"confirmed"},[p],{status:"inn_recorded",inn}),null);
 assert.equal(activity.decide({...proposed,verifiedOrgType:"Интегратор КИПиА"},[p],{status:"inn_recorded",inn}),null);
});

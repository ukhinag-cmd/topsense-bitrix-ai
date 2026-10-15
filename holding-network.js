"use strict";
// Two-layer graph: holding membership != legal-entity identity.
// All relations and contact points here are published on official corporate
// sites. A holding mailbox is never assigned to another member company.
const holdings=[
 {id:"gazstroyprom",name:"Группа «Газстройпром»",url:"https://gsprom.ru/company/structure/",
  members:[
   {name:"ООО «ГСП Ремонт»",role:"Промышленный ремонт и пусконаладка",
    source:"https://gsprom.ru/company/structure/ooo-gsp-remont/",website:"https://www.gsp-r.ru/",
    email:"info@gsp-r.ru",phone:"+7 (495) 221-38-73"},
   {name:"ООО «ГСП-7»",role:"Строительство и капитальный ремонт",
    source:"https://gsprom.ru/company/structure/ooo-gsp-7/",website:"https://gsprom.ru/company/structure/ooo-gsp-7/",
    email:"info@gsp-7.ru",phone:"+7 (812) 383-33-73"},
   {name:"ООО «ГСП-1»",role:"Промышленное строительство и ремонт газопроводов",
    source:"https://gsprom.ru/company/structure/ooo-gsp-1/",website:"https://sgc-1.ru/about/",
    email:"info@gsp1.ru",phone:"+7 (812) 242-72-72"},
   {name:"ООО «ГСП-Комплектация»",role:"Комплектация нефтегазовых объектов оборудованием и МТР",
    source:"https://gsprom.ru/company/structure/ooo-gsp-komplektatsiya/",website:"https://gsprom.ru/company/structure/ooo-gsp-komplektatsiya/",
    email:"in@gsp-k.ru",phone:"+7 (812) 429-08-43"},
   {name:"АО «ГСП Оргэнергогаз»",role:"Промышленный инжиниринг",
    source:"https://gsprom.ru/company/structure/ao-orgenergogaz/",website:"https://gsprom.ru/company/structure/ao-orgenergogaz/",
    email:"oeg@oeg.ru",phone:"+7 (499) 704-70-66"}
  ]},
 {id:"acron-fertilizer-group",name:"Группа «Акрон» — минеральные удобрения",
  url:"https://www.acron.ru/the-geography-of-business/akron/",
  members:[{name:"ПАО «Акрон»",role:"Производство минеральных удобрений",
   website:"https://www.acron.ru/",source:"https://www.acron.ru/the-geography-of-business/akron/",
   email:"info@acron.ru",phone:"+7 (495) 745-77-45"}]},
 {id:"akron-industrial-group",name:"«Акрон Холдинг» — промышленная группа",
  url:"https://www.akron-holding.ru/enterprises/",
  members:[{name:"ГК «Акрон Холдинг»",role:"Промышленный холдинг",
   website:"https://www.akron-holding.ru/",source:"https://www.akron-holding.ru/enterprises/",
   email:"",phone:""}]}
];
function norm(raw){
 const s=String(raw||"").toLocaleLowerCase("ru-RU").replace(/ё/g,"е")
  .replace(/["«»“”]/g,"").replace(/\s*,\s*(?:ооо|ао|пао|оао|зао)\s*$/iu,"")
  .replace(/^\s*(?:ооо|ао|пао|оао|зао|гк)\s+/iu,"")
  .replace(/[^а-яa-z0-9]+/gu,"");
 return s;
}
function decorate(companies){
 return (companies||[]).map(c=>{
  const normalized=norm(c.name);
  const member=holdings.flatMap(h=>h.members.map(m=>({h,m})))
   .find(x=>norm(x.m.name)===normalized);
  return member?{...c,holdingId:member.h.id,holdingName:member.h.name,
   holdingUrl:member.h.url,holdingMembershipSource:member.m.source}:c;
 });
}
function view(companies){
 const cc=decorate(companies);
 return holdings.map(h=>{
  const members=h.members.map(m=>{
   const crm=cc.filter(c=>c.holdingId===h.id&&norm(c.name)===norm(m.name));
   return {...m,holdingId:h.id,crmCardCount:crm.length,
    analyticClientIds:crm.map(c=>String(c.id)),
    companyCrmIds:crm.flatMap(c=>c.crmIdList||[]).map(String),
    availableInAnalytics:crm.length>0,
    relation:"Отдельная организация холдинга; не объединять продажи с другими участниками",
    researchStatus:crm.length?
      "Есть аналитическая карточка; сделки и покупки учитываются отдельно":
      "Кандидат на отдельную карточку; проверить сделки перед предложением продаж"};
  });
  return {id:h.id,name:h.name,url:h.url,members,
   inAnalytics:members.filter(m=>m.availableInAnalytics).length,
   newCandidates:members.filter(m=>!m.availableInAnalytics)};
 });
}
module.exports={holdings,norm,decorate,view};

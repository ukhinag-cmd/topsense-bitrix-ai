"use strict";
// Sales relationship potential from READ-ONLY verified CRM evidence.
// This is a relative score (0..100), NOT a statistical probability of renewal.
// A customer mentioned by the user is tagged separately, and never treated as
// CRM-confirmed paid/shipped unless independently substantiated.
const state={status:"not_started",updatedAt:null,scannedDeals:0,linkedCompanies:0};
let index=new Map();
const known=new Map([
 // CRM records for ООО ГСП Ремонт and its explicitly named branch:
 ["62","ГСП Ремонт"],["2790","ГСП Ремонт"],["2842","ГСП Ремонт"],
 ["3682","ГСП Ремонт"],["3684","ГСП Ремонт"],["3690","ГСП Ремонт"],
 ["3692","ГСП Ремонт"]
]);
const s=x=>String(x??"").trim();
function signals(title){
 const str=s(title);
 const models=[...str.matchAll(/(?:топ[- ]?сенс|ТС|TS)\s*[- ]?\s*(\d{2,4}(?:[A-ZА-Я])?)/giu)]
  .map(x=>x[1].toUpperCase());
 const gasList=["CH4","H2S","CO2","O2","CO","NH3","SO2","NO2","C3H8","PID"];
 const normalized=str.toUpperCase().replace(/₂/g,"2").replace(/₄/g,"4");
 return {models:[...new Set(models)].slice(0,15),
  gases:gasList.filter(g=>new RegExp("(^|[^A-Z0-9])"+g+"([^A-Z0-9]|$)").test(normalized))};
}
function build(deals){
 const next=new Map(),unique=new Set();
 for(const d of deals||[]){
  const dealId=s(d.ID),id=s(d.COMPANY_ID);
  if(!dealId||unique.has(dealId))continue;
  unique.add(dealId);
  // An inferred identity from the title must not be considered a verified
  // company link. Only the Bitrix COMPANY_ID counts as directly linked.
  if(!id||id==="0")continue;
  if(!next.has(id))next.set(id,[]);
  next.get(id).push({id:dealId,title:s(d.TITLE).slice(0,400),
    createdAt:s(d.DATE_CREATE),stage:s(d.STAGE_ID),...signals(d.TITLE)});
 }
 for(const a of next.values())a.sort((x,y)=>Date.parse(x.createdAt||0)-Date.parse(y.createdAt||0));
 index=next;
 Object.assign(state,{status:"ready",updatedAt:new Date().toISOString(),
  scannedDeals:unique.size,linkedCompanies:next.size});
 return stats();
}
function score(company,asOf=new Date()){
 const ids=[...new Set([s(company.id),...((company.crmIdList||[]).map(s))])].filter(Boolean);
 const seen=new Set(),deals=[];
 for(const id of ids)for(const d of index.get(id)||[]){
  if(seen.has(d.id))continue;seen.add(d.id);deals.push(d);
 }
 const models=[...new Set(deals.flatMap(d=>d.models))],gases=[...new Set(deals.flatMap(d=>d.gases))];
 const last=deals.reduce((v,d)=>Date.parse(d.createdAt||0)>Date.parse(v||0)?d.createdAt:v,"");
 const days=last?Math.max(0,(+asOf-Date.parse(last))/86400000):Infinity;
 const buyer=Boolean(company.saleInfo?.paid||company.saleInfo?.shipped||
  String(company.saleInfo?.purchaseStatus||"").startsWith("БЫЛА"));
 const userConfirmed=ids.some(id=>known.has(id));
 const type=s(company.organizationType||company.type||"");
 const relevant=/подряд|ремонт|кипи|газ|хим|нефт|энерг|металл|проект|сервис|бур|промышлен|интеграт/i.test(type+" "+s(company.category));
 const components={
  clientHistory:userConfirmed?32:0,
  verifiedPurchase:buyer?26:0,
  repeatDeals:deals.length>=5?23:deals.length>=3?18:deals.length>=2?14:deals.length===1?7:0,
  recentActivity:days<=365?12:days<=730?7:0,
  diverseNeeds:models.length>=2||gases.length>=3?13:models.length||gases.length?8:0,
  industryFit:relevant?10:0,
  scale:company.staffEvidence?.count>=1000?5:company.staffEvidence?.count>=200?3:0
 };
 const value=Math.min(100,Object.values(components).reduce((a,b)=>a+b,0));
 const level=value>=75?"Очень высокий":value>=55?"Высокий":value>=35?"Средний":value>=15?"Начальный":"Недостаточно данных";
 return {score:value,level,status:state.status,dealCount:deals.length,
  lastDealAt:last,models:models.slice(0,12),gases:gases.slice(0,12),
  buyerVerified:buyer,userConfirmed,userConfirmedSource:userConfirmed?
   "Постоянный клиент — сообщение пользователя (15.10.2026)":"",
  components,basis:"Прямо привязанные CRM-сделки и подтверждённые сигналы; непривязанные сделки не приписаны компании",
  note:deals.length?"Повторные запросы и интерес к приборам подтверждаются сделками":
   "История напрямую привязанных сделок пока не найдена; требуется сверка переписки"};
}
function stats(){return {...state}}
module.exports={build,score,stats,signals};

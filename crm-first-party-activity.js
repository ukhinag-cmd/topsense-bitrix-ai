"use strict";
// First-party business-activity statements from an ORIGINAL inbound letter.
// Inquiries about buying sensors, customer project descriptions, quoted
// forwarded messages, third-party websites and CRM card text are NOT proof.
const taxonomy=require("./client-taxonomy");
const inn=require("./company-requisites").validInn;
const patterns=[
 ["Ремонтный подрядчик ОПО / остановочный ремонт",/капитальн[а-яёa-z]*\s+ремонт[а-яёa-z]*.*(?:нефтеперерабат|нефтехим|газоперерабат|промышленн[а-яёa-z]*\s+установ)|остановочн[а-яёa-z]*\s+ремонт/i],
 ["Интегратор АСУ ТП",/(?:проектирован|внедрен|интеграц|наладк).{0,65}(?:асу\s*тп|scada|плк)/i],
 ["Интегратор КИПиА",/(?:проектирован|внедрен|монтаж|пусконалад).{0,45}кипи?а/i],
 ["Проектная организация / проектный институт",/(?:проектирован|разработк).{0,65}(?:проектн[а-яёa-z]*\s+документац|промышленн[а-яёa-z]*\s+объект|объект[а-яёa-z]*\s+нефтегаз)/i],
 ["Монтажно-строительная организация",/(?:монтаж|строительств).{0,75}(?:промышленн[а-яёa-z]*\s+(?:объект|предприят)|технологическ[а-яёa-z]*\s+трубопровод|технологическ[а-яёa-z]*\s+оборудован)/i],
 ["Производитель газоаналитических приборов",/(?:производ|изготавлив|выпуска).{0,45}(?:газоанализатор|газосигнализатор|газоаналитическ[а-яёa-z]*\s+прибор)/i],
 ["Дилер промышленного оборудования",/(?:официальн[а-яёa-z]*\s+дилер|дистрибьютор).{0,55}(?:промышленн|газоанализ|измерительн[а-яёa-z]*\s+оборудован)/i],
 ["Промышленный сервис / техническая эксплуатация",/(?:техническ[а-яёa-z]*\s+обслуживан|эксплуатац).{0,65}(?:промышленн[а-яёa-z]*\s+оборудован|производственн[а-яёa-z]*\s+объект|технологическ[а-яёa-z]*\s+установ)/i]
];
function discover(description,activityId){
 const full=String(description||"");
 // Reject forwarded or quoted business claims. Inspect only the authored
 // opening; no inference from purchase request or equipment specification.
 const top=full.split(/(?:\n\s*(?:from|от|кому|пересланное сообщение)\s*:|original message|начало пересланного|-{4,})/i)[0]
  .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").slice(0,5500);
 const ids=[...new Set([...top.matchAll(/(?:ИНН|INN)\s*[:№#-]?\s*(\d{10}|\d{12})(?!\d)/gi)].map(m=>inn(m[1])).filter(Boolean))];
 if(ids.length!==1)return [];
 const self=/(?:^|[\s;:])(?:(?:наша\s+(?:компания|организация|фирма))\s+(?:специализируется\s+на|занимается|осуществляет|выполняет|производит|изготавливает|выпускает|является)|мы\s+(?:специализируемся\s+на|занимаемся|осуществляем|выполняем|производим|изготавливаем|выпускаем|являемся))\s+([^.!?\n]{10,240})/giu;
 const matching=[];
 for(const match of top.matchAll(self)){
  const statement=match[0].trim();
  // Requests to buy or maintain TOP-SENSE products are not activity.
  if(/(?:хотим|планируем|нужно|требуется|интересует|закупа|приобрести|купить|ищем\s+поставщика)/i.test(statement))continue;
  for(const [type,regex] of patterns){
   if(regex.test(statement)&&taxonomy.known(type)&&!matching.some(x=>x.type===type))
    matching.push({type,inn:ids[0],activityId:String(activityId||""),source:"explicit_original_inbound_self_description"});
  }
 }
 // Contradictory business claims cannot be auto-validated.
 return matching.length===1?matching:[];
}

function normalName(name){
 return String(name||"").toLowerCase().replace(/ё/g,"е")
  .replace(/(?:^|\s)(?:ооо|пао|оао|ао|зао|нао|ип)(?=\s|$)/g," ")
  .replace(/[^а-яa-z0-9]+/g,"").trim();
}
// No auto-assignment unless the original inbound message identifies the
// SAME legal company with a checksum-valid INN from its own CRM requisites.
function decide(company,profiles,requisite,locked=false){
 if(locked||company?.companyIdentityReviewRequired||
  company?.verificationStatus==="confirmed"||
  taxonomy.known(company?.verifiedOrgType)||
  (taxonomy.known(company?.organizationType)&&
   company?.verification!=="Предварительная классификация"&&
   company?.verification!=="AI — требует проверки"&&
   company?.proposedType!==company?.organizationType)||
  requisite?.status!=="inn_recorded"||
  !inn(requisite?.inn)||!normalName(company?.name))return null;
 const ownName=normalName(company.name),id=String(company.id||"");
 const matches=[];
 for(const p of profiles||[]){
  if(String(p?.companyId)!==id||p?.correspondencePartial||
    !Array.isArray(p?.firstPartyActivities))continue;
  for(const candidate of p.firstPartyActivities){
   if(candidate?.source!=="explicit_original_inbound_self_description"||
    candidate.inn!==requisite.inn||!taxonomy.known(candidate.type))continue;
   const legal=(p.legalNameCandidates||[]).some(x=>
    x.inn===candidate.inn&&String(x.activityId)===String(candidate.activityId)&&
    normalName(x.name)===ownName);
   if(legal)matches.push({type:candidate.type,dealId:String(p.id),
     activityId:String(candidate.activityId),inn:candidate.inn});
  }
 }
 const types=[...new Set(matches.map(x=>x.type))];
 return types.length===1?{...matches[0],type:types[0]}:null;
}
function qualify(c){
 const ledger=require("./classification-ledger");
 const finalization=require("./client-finalization");
 if(ledger.get(c?.id)||finalization.isComplete(c?.id)||
  c?.verificationStatus==="confirmed"||taxonomy.known(c?.verifiedOrgType))return c;
 const requisite=require("./company-requisites").get(c?.id);
 const profiles=[...require("./crm-deal-intake").forCompany(c?.id),
  ...require("./qualification-review-processor").evidenceProfiles(c?.id)];
 const proof=decide(c,profiles,requisite);
 if(!proof)return c;
 return {...c,organizationType:proof.type,type:proof.type,proposedType:"",
  segmentConfidence:"Высокая — исходное входящее письмо с ИНН и юридическим наименованием",
  segmentSource:"Собственная деятельность в письме сделки "+proof.dealId+
   " (активность "+proof.activityId+"), совпадает ИНН из реквизитов",
  verification:"Собственное заявление компании с подтверждённым совпадением ИНН",
  researchStatus:"inbound_self_description_qualified"};
}
module.exports={discover,decide,qualify};


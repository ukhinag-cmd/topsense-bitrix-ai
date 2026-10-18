"use strict";
// First-party business-activity statements from an ORIGINAL inbound letter.
// Inquiries about buying sensors, customer project descriptions, quoted
// forwarded messages, third-party websites and CRM card text are NOT proof.
const taxonomy=require("./client-taxonomy");
const inn=require("./company-requisites").validInn;
const patterns=[
 ["Ремонтный подрядчик ОПО / остановочный ремонт",/капитальн\w*\s+ремонт\w*.*(?:нефтеперерабат|нефтехим|газоперерабат|промышленн\w*\s+установ)|остановочн\w*\s+ремонт/i],
 ["Интегратор АСУ ТП",/(?:проектирован|внедрен|интеграц|наладк).{0,65}(?:асу\s*тп|scada|плк)/i],
 ["Интегратор КИПиА",/(?:проектирован|внедрен|монтаж|пусконалад).{0,45}кипи?а/i],
 ["Проектная организация / проектный институт",/(?:проектирован|разработк).{0,65}(?:проектн\w*\s+документац|промышленн\w*\s+объект|объект\w*\s+нефтегаз)/i],
 ["Монтажно-строительная организация",/(?:монтаж|строительств).{0,75}(?:промышленн\w*\s+(?:объект|предприят)|технологическ\w*\s+трубопровод|технологическ\w*\s+оборудован)/i],
 ["Производитель газоаналитических приборов",/(?:производ|изготавлив|выпуска).{0,45}(?:газоанализатор|газосигнализатор|газоаналитическ\w*\s+прибор)/i],
 ["Дилер промышленного оборудования",/(?:официальн\w*\s+дилер|дистрибьютор).{0,55}(?:промышленн|газоанализ|измерительн\w*\s+оборудован)/i],
 ["Промышленный сервис / техническая эксплуатация",/(?:техническ\w*\s+обслуживан|эксплуатац).{0,65}(?:промышленн\w*\s+оборудован|производственн\w*\s+объект|технологическ\w*\s+установ)/i]
];
function discover(description,activityId){
 const full=String(description||"");
 // Reject forwarded or quoted business claims. Inspect only the authored
 // opening; no inference from purchase request or equipment specification.
 const top=full.split(/(?:\n\s*(?:from|от|кому|пересланное сообщение)\s*:|original message|начало пересланного|-{4,})/i)[0]
  .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").slice(0,5500);
 const ids=[...new Set([...top.matchAll(/(?:ИНН|INN)\s*[:№#-]?\s*(\d{10}|\d{12})(?!\d)/gi)].map(m=>inn(m[1])).filter(Boolean))];
 if(ids.length!==1)return [];
 const self=/\b(?:наша\s+(?:компания|организация|фирма)|мы)\s+(?:специализируемся\s+на|занимаемся|осуществляем|выполняем|производим|изготавливаем|выпускаем|являемся)\s+([^.!?\n]{10,240})/giu;
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
module.exports={discover};

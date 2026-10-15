"use strict";
// Manager notes may describe the enterprise's OWN business. Use as a
// provisional lead only when a positive, explicit activity statement exists.
// Customer enquiries, products being purchased and negated claims are never
// a sufficient basis for a business type.
const valid=require("./client-taxonomy").known;
function normalize(raw){
 return String(raw||"").slice(0,4000)
  .replace(/\[(?:\/)?(?:p|br|b|i|u|list|quote|url)[^\]]*\]/giu," ")
  .replace(/<\/?[^>]+>/g," ").replace(/&(?:quot|nbsp|amp|lt|gt);/gi," ")
  .replace(/ё/g,"е").toLowerCase().replace(/\s+/g," ").trim();
}
const patterns=[
 ["Машиностроительный завод",/(?:^|[.;!?\n])\s*(?:завод|предприятие)\s+(?:производит|выпускает|изготавливает)\s+(?:горнопроходческ|комбайн|машин|станк|насосн|вентиляционн|буров[а-я]*\s+(?:установ|машин)|технологическ[а-я]*\s+оборудован)/iu],
 ["Дистрибьютор / оптовый поставщик",/(?:^|[.;!?\n])\s*(?:они|компания|организация|предприятие)\s+(?:занимаются|занимается)\s+(?:оптовой?\s+)?(?:продажей|поставками)\s+(?:электромеханическ|электротехническ|промышленн|контрольно.?измерительн)\S*\s+оборудован/iu],
 ["Проектная организация / проектный институт",/(?:^|[.;!?\n])\s*(?:компания|организация|предприятие)\s+(?:занимается\s+проектированием|разрабатывает\s+проектную\s+(?:и\s+рабочую\s+)?документацию)/iu],
 ["Монтажно-строительная организация",/(?:^|[.;!?\n])\s*(?:компания|организация|предприятие)\s+(?:выполняет|проводит)\s+(?:строительно.?монтажные|электромонтажные|монтажные)\s+работы/iu],
 ["Поверочная / калибровочная лаборатория",/(?:^|[.;!?\n])\s*(?:компания|организация|лаборатория)\s+(?:занимается|выполняет|проводит)\s+(?:поверкой|калибровкой)\s+(?:приборов|средств\s+измерений|измерительн)/iu]
];
function infer(raw){
 const body=normalize(raw);
 if(!body||body.length<22)return null;
 // A negated statement does not prove a positive professional specialism.
 const unique=new Map();
 for(const [type,pattern] of patterns){
  const found=pattern.exec(body);
  if(!found||!valid(type))continue;
  const surrounding=body.slice(Math.max(0,found.index-28),found.index+found[0].length);
  if(/(?:не|никогда)\s+(?:занима|производ|выполн|осуществл)|(?:не\s+является)/iu.test(surrounding))continue;
  unique.set(type,found[0].trim().slice(0,160));
 }
 if(unique.size!==1)return null;
 const [type,signal]=[...unique][0];
 return {type,source:"Явное описание деятельности самой компании в CRM",
   confidence:"Предварительная — комментарий менеджера, нужна внешняя сверка",
   signal};
}
module.exports={infer,normalize};

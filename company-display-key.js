"use strict";
// Presentation-only grouping; this does not merge legal records or any sales.
const legal=/^(?:ООО|АО|ОАО|ЗАО|ПАО|НАО|ИП|НКО|ГУП|МУП)$/i;
function key(raw){
 let s=String(raw??"").normalize("NFKC").toLocaleUpperCase("ru-RU")
  .replace(/[«»„“”"'‹›]/g," ").replace(/\s+/g," ").trim();
 if(!s)return "";
 s=s.replace(/^(?:КОМПАНИЯ|ФИРМА)\s+/u,"").trim();
 let chunks=s.split(/[\s,;]+/).filter(Boolean);
 while(chunks.length>1&&legal.test(chunks[0]))chunks.shift();
 while(chunks.length>1&&legal.test(chunks[chunks.length-1]))chunks.pop();
 const canon=chunks.join("").toLowerCase().replace(/ё/g,"е")
  .replace(/[^а-яa-z0-9]/g,"");
 return canon.length>=3?canon:"";
}
module.exports={key};

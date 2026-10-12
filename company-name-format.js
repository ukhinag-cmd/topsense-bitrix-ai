"use strict";
// Presentation-only. Never writes a new name into Bitrix24.
// The OPF is included only when it is explicit in the source name.
const FORMS=[
"ФГАОУ","ФГБОУ","ФГБУ","ФГУП","ГБОУ","МБОУ","НПАО","СПАО",
"ФГАУ","ФБУ","ФКП","ГБУ","МБУ","МУП","ГУП",
"ПАО","ОАО","ЗАО","ООО","НАО","АО","АНО","НКО","ОДО","ТОО","КФХ","ИП"
];
const formPattern=FORMS.join("|");
const prefix=new RegExp("^(?:"+formPattern+")(?![А-ЯЁA-Z0-9])\\s*[,.:—\\-]?\\s*","i");
const suffix=new RegExp("\\s*[,.:—\\-]\\s*("+formPattern+")\\s*$","i");
const exact=new RegExp("^("+formPattern+")$","i");
function display(raw){
 const original=String(raw||"").trim();
 if(!original)return {name:"БЕЗ НАЗВАНИЯ",opf:null,source:""};
 let name=original.replace(/[«»“”]/g,'"').replace(/\s+/g," ").trim(),opf=null;
 const first=name.match(prefix);
 if(first){
  const matched=first[0].match(new RegExp("^("+formPattern+")(?![А-ЯЁA-Z0-9])","i"));
  if(matched&&name.slice(first[0].length).trim()){
   opf=matched[1].toUpperCase();
   name=name.slice(first[0].length);
  }
 }
 if(!opf){
  const last=name.match(suffix);
  if(last){
   opf=last[1].toUpperCase();
   name=name.slice(0,-last[0].length);
  }
 }
 name=name.trim().replace(/^[,"'\s]+|[,"'\s]+$/g,"").trim();
 // Do not output a dangling OPF as the entire name.
 if(!name||exact.test(name))return {name:original.toUpperCase(),opf:null,source:""};
 return {name:name.toLocaleUpperCase("ru-RU")+(opf?", "+opf:""),opf,source:opf?"ОПФ в исходном названии CRM":""};
}
module.exports={display};

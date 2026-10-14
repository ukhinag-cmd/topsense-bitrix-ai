"use strict";
// Open-ended category catalogue: the original 45 are a seed, NOT a closed enum.
// New names are admitted only when an actual studied company site contains
// the verbatim supporting statement. Paid AI proposes; this module validates.
// All accepted AI decisions already live in an idempotent private ledger,
// so category registration can be replayed across Render restarts at no cost.
const {types}=require("./company-types");
const existing=new Set(types.map(t=>t.name));
let registered=0,rejected=0;
function tidy(v){return String(v??"").normalize("NFKC").replace(/\s+/g," ").trim()}
function norm(v){return tidy(v).toLowerCase().replace(/ё/g,"е")}
function safeUrl(raw){
 try{const x=new URL(String(raw||""));return ["http:","https:"].includes(x.protocol)&&x.hostname.includes(".")&&!x.username&&!x.password?x.origin:""}
 catch{return ""}
}
function sensible(v){
 const name=tidy(v);
 if(name.length<12||name.length>90||/[\d<>{}[\]|\\]/.test(name)||
  /^(?:другое|прочее|не определен|компания|прочие|разное|неизвест)/i.test(name))return "";
 const words=name.split(" ");
 if(words.length<2||words.length>11)return "";
 // The label must denote a concrete business activity; not a company name,
 // geographic region, customer sector, guessed relationship or sales intent.
 if(!/^(?:Производство|Добыча|Переработка|Эксплуатация|Строительство|Монтаж|Ремонт|Проектирование|Поставка|Техническое обслуживание|Логистические услуги|Инжиниринг|Сервис|Утилизация|Перевозка|Обработка)\s/i.test(name))return "";
 return name;
}
function familyFor(name){
 if(/^(?:Производство|Переработка)\s/i.test(name))return "Отраслевые производства";
 if(/^(?:Строительство|Монтаж|Ремонт|Инжиниринг)\s/i.test(name))return "Подрядчики";
 if(/^Проектирование\s/i.test(name))return "Проектирование";
 if(/^Эксплуатация\s/i.test(name))return "Эксплуатация";
 if(/^Поставка\s/i.test(name))return "Торговля";
 if(/^(?:Добыча)\s/i.test(name))return "Эксплуатация";
 return "Смежные";
}
function accept(result){
 const proposed=sensible(result?.newSubtype||result?.suggestedSubtype);
 if(!proposed)return null;
 const quote=tidy(result?.newSubtypeQuote);
 const url=safeUrl(result?.website||result?.officialWebsite||result?.source);
 if(result?.newSubtypeApproved!==true||result?.siteOwnership!=="confirmed"||
    quote.length<18||quote.length>450||!url)return null;
 return {name:proposed,source:url,quote,originCompanyId:String(result.companyId||"")};
}
function registerFromPilot(result){
 const accepted=accept(result);
 if(!accepted){if(result?.newSubtype)rejected++;return false}
 if(existing.has(accepted.name))return false;
 // Different company IDs may converge onto the same reusable business type.
 const family=familyFor(accepted.name);
 types.push({
  id:"D"+String(types.length+1).padStart(3,"0"),
  family,name:accepted.name,
  description:"Вид деятельности подтверждён корпоративным источником; расширение справочника по фактам",
  directions:family==="Отраслевые производства"||family==="Эксплуатация"?"Конечные потребители":
   family==="Подрядчики"?"Подрядчики":family==="Торговля"?"Партнёрские продажи":
   family==="Проектирование"?"Проектные продажи":"Смежные организации",
  proof:"Цитата из сайта компании, сохранённая в результате классификации",
  note:"Новый автоматически обнаруженный тип; конкретные компании требуют проверки",
  sourceUrl:accepted.source,createdFromCompanyId:accepted.originCompanyId,
  origin:"site-evidence-backed-ai"
 });
 existing.add(accepted.name);registered++;
 return true;
}
function known(name){return types.some(t=>t.name===String(name||""))}
function all(){return types}
function stats(){return {total:types.length,originalTypes:45,dynamicRegistered:registered,rejectedUnproven:rejected}}
module.exports={tidy,norm,sensible,accept,registerFromPilot,known,all,stats,familyFor};

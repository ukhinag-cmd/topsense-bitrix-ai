"use strict";
// Staff numbers must be sourced and time-qualified. 2025 revenue is NEVER
// used as an employee estimate. Corporate group headcount is not subsidiary
// headcount. This module does not perform internet searches or Bitrix writes.
function count(x){
 const s=String(x??"").replace(/[\s\u00a0\u202f]/g,"");
 if(!/^[1-9]\d{0,6}$/.test(s))return null;
 const n=Number(s);return n<=2000000?n:null;
}
function safeUrl(x){
 try{const u=new URL(String(x||""));return ["https:","http:"].includes(u.protocol)&&u.hostname.includes(".")&&!u.username&&!u.password?u.href:""}
 catch{return""}
}
function empty(){return {count:null,year:null,approximate:false,source:"",sourceUrl:"",basis:"Численность сотрудников не подтверждена"}}
function fromCompany(c){
 const n=count(c?.UF_CRM_AI_EMPLOYEE_COUNT||c?.UF_CRM_AI_HEADCOUNT);
 const year=Number(c?.UF_CRM_AI_EMPLOYEE_YEAR||c?.UF_CRM_AI_HEADCOUNT_YEAR||0);
 const source=String(c?.UF_CRM_AI_EMPLOYEE_SOURCE||c?.UF_CRM_AI_HEADCOUNT_SOURCE||"").trim();
 if(n===null||!source||year<2015||year>2026)return empty();
 return {count:n,year,approximate:false,source:source.slice(0,250),
  sourceUrl:safeUrl(source),basis:"Сохранённое значение с источником и годом; требуется юридическая идентификация по ИНН"};
}
function fromPages(pages){
 for(const p of pages||[]){
  const body=String(p?.meta?.body||"").replace(/\s+/g," ").slice(0,30000);
  const re=/(?:штат(?:\s+предприятия|\s+компании|\s+организации)?(?:\s+на\s+сегодняшний\s+день)?\s+насчитывает|численность\s+(?:штата|персонала|сотрудников|работников)\s+(?:составляет|превышает|достигает)|(?:в\s+штате|в\s+компании)\s+(?:работает|трудится)|среднесписочная\s+численность(?:\s+работников)?)\s*(?:около|более|свыше|порядка|примерно|не\s+менее)?\s*(\d{1,3}(?:[ \u00a0]\d{3})*|\d{1,7})\s*(?:человек|чел\.?|сотрудник\w*|специалист\w*|работник\w*)?/gi;
  let m;
  while((m=re.exec(body))!==null){
   const number=count(m[1]);if(number===null)continue;
   const whole=body.slice(Math.max(0,m.index-70),Math.min(body.length,m.index+m[0].length+95));
   const yearMatch=whole.match(/(?:в|за|на\s+конец)\s+(20\d{2})\s*(?:г\.?|году|год)?/i);
   const year=yearMatch?Number(yearMatch[1]):null;
   if(year!==null&&(year<2015||year>2026))continue;
   const approximate=/около|порядка|примерно|более|свыше|не\s+менее/i.test(m[0]);
   const sourceUrl=safeUrl(p?.pageUrl)||safeUrl(p?.url);
   if(!sourceUrl)continue;
   return {count:number,year,approximate,source:"Официальный сайт компании",
    sourceUrl,basis:whole.slice(0,220)};
  }
 }
 return empty();
}
function resolve(company,site){
 // CRM staff with explicit year is stronger if independently sourced.
 const crm=fromCompany(company);
 if(crm.count!==null&&crm.year===2025)return crm;
 const web=site?.staffEvidence||empty();
 if(web.count!==null&&safeUrl(web.sourceUrl))return {...web,sourceUrl:safeUrl(web.sourceUrl)};
 return crm;
}
function forGroup(members){
 const found=(members||[]).map(c=>c.staffEvidence||empty()).filter(x=>x.count!==null);
 if(!found.length)return empty();
 const same=found.every(x=>x.count===found[0].count&&x.year===found[0].year&&x.approximate===found[0].approximate);
 if(!same)return {...empty(),basis:"У предполагаемых дублей расходятся данные о сотрудниках; не объединены"};
 return {...found[0],basis:found[0].basis+" (не суммируется по дублирующим CRM-карточкам)"};
}
module.exports={count,empty,fromCompany,fromPages,resolve,forGroup};

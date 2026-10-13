"use strict";
// Financial statements: 2025 corporate revenue (form 2, row 2110), not customer purchases.
// Public financial data must be tied to an exact legal entity (INN).
// Values stored by previous CRM AI jobs are a source pointer, not independently verified.
const YEAR=2025;
const providers=/ГИР.?БО|ФНС|НАЛОГ\.ГОВ|НАЛОГ\.РУ|CHECKO|ЧЕККО|РУСПРОФАЙЛ|RUSPROFILE|РБК|ФИНАНСОВАЯ ОТЧ[ЕЁ]ТНОСТЬ|БУХГАЛТЕРСКАЯ ОТЧ[ЕЁ]ТНОСТЬ|SABY|СБИС/i;
function parseAmount(input){
 if(typeof input==="number")return Number.isFinite(input)&&input>=0&&input<1e15?input:null;
 const raw=String(input??"").replace(/\u00a0|\u202f/g," ").trim();
 if(!raw||/не\s*извест|нет\s*данных/i.test(raw))return null;
 const clean=raw.replace(/[\s₽р]/g,"").replace(/руб(?:лей|ля|ль)?\.?/gi,"").replace(/,/g,".");
 if(!/^\d{1,15}(?:\.\d{1,2})?$/.test(clean))return null;
 const n=Number(clean);return Number.isFinite(n)&&n>=0&&n<1e15?n:null;
}
function innNumber(input){
 const s=String(input||"").replace(/\D/g,"");return s.length===10||s.length===12?s:"";
}
function sourceLink(text){
 const m=String(text||"").match(/https:\/\/[^\s)"'>]+/i);
 if(!m)return "";
 try{
  const u=new URL(m[0]),host=u.hostname.toLowerCase().replace(/^www\./,"");
  if(u.protocol!=="https:"||!["nalog.gov.ru","bo.nalog.gov.ru","api-bo.nalog.gov.ru","checko.ru","rusprofile.ru","companies.rbc.ru","saby.ru","sbis.ru"].some(x=>host===x||host.endsWith("."+x)))return "";
  return u.toString().slice(0,400);
 }catch{return""}
}
function empty(status="no_data"){return{year:YEAR,amountRUB:null,inn:"",source:"",sourceUrl:"",status,basis:"Проверенной выручки за 2025 год нет"}}
function fromCompany(row){
 const amount=parseAmount(row.UF_CRM_AI_REVENUE);
 const year=Number(row.UF_CRM_AI_REVENUE_YEAR||"");
 const inn=innNumber(row.UF_CRM_AI_INN||row.RQ_INN);
 const source=String(row.UF_CRM_AI_FIN_SOURCE||"").trim().slice(0,350);
 if(year!==YEAR)return {...empty(year?"other_year":"no_data"),inn};
 if(amount===null)return {...empty("not_recorded"),inn,source};
 if(!inn)return {...empty("identity_required"),source,basis:"Нет ИНН — нельзя безопасно привязать выручку к юрлицу"};
 if(!source||!providers.test(source))return {...empty("unverified_source"),inn,source,basis:"Есть сумма, но нет проверяемого финансового источника"};
 return {year:YEAR,amountRUB:amount,inn,source,sourceUrl:sourceLink(source),
  status:"source_recorded",basis:"Выручка 2025 из сохранённого финансового источника; требуется сверка с публичной отчётностью"};
}
function forGroup(members){
 const values=members.map(x=>({id:String(x.id),f:x.finance2025||empty()}));
 const distinctInn=[...new Set(values.map(v=>v.f.inn).filter(Boolean))];
 if(distinctInn.length>1)return {...empty("legal_conflict"),basis:"У дублей разные ИНН. Финансовые данные не объединены"};
 const records=values.filter(v=>v.f.amountRUB!==null&&v.f.year===YEAR);
 if(!records.length)return {...empty("no_data"),inn:distinctInn[0]||""};
 const amounts=[...new Set(records.map(v=>v.f.amountRUB))];
 if(amounts.length!==1)return {...empty("conflicting_values"),inn:distinctInn[0]||"",
  basis:"Карточки одного предполагаемого юрлица содержат разные значения выручки 2025"};
 const f=records[0].f;
 return {...f,sourceCrmIds:records.map(x=>x.id),
  status:records.length===1?"source_recorded":"same_value_multiple_cards",
  basis:"Выручка юрлица за 2025 год, не сумма выручек дублирующих CRM-карточек. Сверка финансового источника обязательна"};
}
module.exports={fromCompany,forGroup,parseAmount,innNumber,empty};

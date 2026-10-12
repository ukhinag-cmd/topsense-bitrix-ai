"use strict";
// Read-only customer registry quality guard. Never deletes a Bitrix24 card.
// Invalid titles are quarantined from analytics and can be inspected separately.
function problem(value){
 const s=String(value??"").trim();
 if(!s)return "Пустое название";
 const normal=s.toLocaleLowerCase("ru-RU").replace(/ё/g,"е").replace(/[«»"'.,:;()[\]{}\/\\\s!?—–_-]+/g," ").trim();
 if(/^(?:без названия|без имени|нет названия|название не указано|неизвестно|не определено|не заполнено|тест|тестовая компания|тестовый контрагент|физ лицо|физическое лицо|контрагент|компания|новая компания|нет данных|ошибка|undefined|unknown|none)$/i.test(normal))return "Название-заглушка";
 if(/^[\d+().\-\s_/\\]+$/.test(s))return "Вместо названия указан номер или набор цифр";
 if(/(?:\b(?:тел|телефон|моб|мобильный|whatsapp|ватсап|viber)\b\s*[:.]?\s*)?(?:\+7|8)\s*[\s(.\-]*\d{3}[\s).\-(]*\d{3}[\s.\-]*\d{2}[\s.\-]*\d{2}(?!\d)/i.test(s))return "В названии указан телефон";
 // Long number + a legal/tax/contact label is not a usable company name as-is.
 if(/(?:\b(?:ИНН|КПП|ОГРН|ОГРНИП|телефон|тел|моб)\s*[:№]*\s*|\+7[\s(.\-]*)\d[\d\s().\-]{8,14}/i.test(s))return "В названии присутствуют реквизиты или контактные данные";
 if(/\d{10,}/.test(s))return "В названии присутствует длинный номер";
 if(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(s))return "В названии указан e-mail";
 if(/(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:ru|su|com|net|org)\b)/i.test(s))return "В названии указан сайт вместо названия";
 if(s.length>230)return "Слишком длинное поле названия";
 const letters=(s.match(/[а-яёa-z]/gi)||[]).length;
 if(letters===0)return "Нет буквенного названия организации";
 // Genuine short brands/acronyms (e.g. «НК», «ТТ», «ИС-16») must remain in the registry.
 if(/^(?:!!!+|\?{2,}|[-=_*.]{3,})$/.test(s))return "Техническая запись вместо названия";
 return "";
}
function split(companies){
 const valid=[],excluded=[];
 for(const company of companies||[]){
  if(!company||!company.id)continue;
  const reason=problem(company.name);
  if(reason)excluded.push({id:String(company.id),name:String(company.name||""),reason,crmUrl:company.crmUrl||""});
  else valid.push(company);
 }
 return {valid,excluded,stats:{valid:valid.length,excluded:excluded.length,raw:valid.length+excluded.length}};
}
module.exports={problem,split};
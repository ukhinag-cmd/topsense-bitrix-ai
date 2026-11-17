'use strict';

// Non-mutating preparation of a daily OKP route batch. No CRM write calls here.
// All automatic writes must be implemented separately after Bitrix field mapping.
const ALIASES = Object.freeze({
  name: ['Название компании','Компания','Наименование','Название','name'],
  inn: ['ИНН','inn'], kpp: ['КПП','kpp'], ogrn: ['ОГРН','ogrn'],
  website: ['Сайт','Официальный сайт','website'], phone: ['Телефон','phone'],
  email: ['E-mail','Email','Почта','email'],
  officeAddress: ['Адрес офиса','Фактический адрес','Адрес','officeAddress'],
  legalAddress: ['Юридический адрес','Юрадрес','legalAddress'],
  region: ['Регион','region'], industry: ['Отрасль','industry'],
  subindustry: ['Подотрасль','subindustry'], clientType: ['Тип клиента','clientType'],
  director: ['Генеральный директор','Ген директор','Гендиректор','director'],
  revenue: ['Выручка','Выручка 2025','revenue'], revenueYear: ['Год выручки','revenueYear'],
  interest: ['Почему интересна','Чем интересна','Потенциал газоанализаторов','interest'],
  buyerRole: ['Кого искать','Ответственное подразделение','buyerRole'],
  sourceUrl: ['Источник','Ссылка на источник','sourceUrl'],
  managerId: ['ID менеджера','Ответственный ID','managerId'],
  route: ['Маршрут','Круг выезда','route']
});

function cell(row, aliases) {
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(row,key) && row[key] != null) {
      const value=String(row[key]).trim();
      if (value) return value.slice(0,2000);
    }
  }
  return '';
}
function normalizeInn(value) {
  const result=String(value||'').replace(/\D/g,'');
  return /^(?:\d{10}|\d{12})$/.test(result) ? result : '';
}
function domain(value) {
  const trimmed=String(value||'').trim();
  if (!trimmed) return '';
  try {
    const url=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`https://${trimmed}`);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port) return '';
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    if(!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)||host.includes('..')) return '';
    return host;
  } catch { return ''; }
}
function normalize(row, line) {
  const result={line};
  for(const [field, aliases] of Object.entries(ALIASES)) result[field]=cell(row,aliases);
  const rawInn=result.inn;
  result.inn=normalizeInn(rawInn);
  result.domain=domain(result.website);
  result.warnings=[];
  if(rawInn&&!result.inn) result.warnings.push('invalid_inn');
  if(result.website&&!result.domain) result.warnings.push('invalid_website');
  if(!result.name) result.warnings.push('missing_name');
  if(!result.inn&&!result.domain) result.warnings.push('identity_not_verified');
  if(!result.officeAddress) result.warnings.push('visit_address_missing');
  if(!result.interest) result.warnings.push('commercial_potential_not_described');
  return result;
}
function existingIndex(companies=[]) {
  const byInn=new Map(),byDomain=new Map();
  for(const row of companies) {
    if(!row||!row.id)continue;
    const inn=normalizeInn(row.inn),host=domain(row.website);
    if(inn){if(!byInn.has(inn))byInn.set(inn,[]);byInn.get(inn).push(row);}
    if(host){if(!byDomain.has(host))byDomain.set(host,[]);byDomain.get(host).push(row);}
  }
  return {byInn,byDomain};
}
function prepareBatch(rows, options={}) {
  if(!Array.isArray(rows)||rows.length>300) throw new Error('Expected an array of at most 300 companies');
  const registry=existingIndex(options.existingCompanies||[]);
  const seen=new Set(),items=[];
  for(let n=0;n<rows.length;n++){
    const record=normalize(rows[n]||{},n+2);
    const matches=record.inn ? (registry.byInn.get(record.inn)||[]) : (registry.byDomain.get(record.domain)||[]);
    const distinct=[...new Set(matches.map(x=>String(x.id)))];
    const key=record.inn?`inn:${record.inn}`:record.domain?`domain:${record.domain}`:'';
    let action='create_company';
    if(record.warnings.includes('missing_name')||record.warnings.includes('identity_not_verified')) action='manual_review';
    else if(key&&seen.has(key))action='duplicate_in_batch';
    else if(distinct.length>1) action='ambiguous_existing_company';
    else if(distinct.length===1) action='update_existing_company';
    if(key)seen.add(key);
    const targetCompanyId=distinct.length===1?distinct[0]:null;
    // A deal requires a separate CRM lookup by company and OKP category.
    // Never propose blind insertion and never mutate an existing commercial deal.
    const dealAction=action==='create_company'||action==='update_existing_company'
      ? 'check_existing_okp_deal_before_create' : 'not_allowed';
    items.push({ ...record, action, targetCompanyId, dealAction });
  }
  const count=action=>items.filter(item=>item.action===action).length;
  return {mode:'dry_run',rowCount:items.length,counts:{
    createCompany:count('create_company'),updateCompany:count('update_existing_company'),
    review:count('manual_review')+count('ambiguous_existing_company'),
    duplicates:count('duplicate_in_batch')
  },items};
}
module.exports={ALIASES,normalizeInn,domain,normalize,prepareBatch};

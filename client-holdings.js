"use strict";
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function page(payload){
 const groups=payload.holdings||[];
 const safe=raw=>{try{const u=new URL(raw);return u.protocol==="https:"?u.href:""}catch{return""}};
 const cards=groups.map(g=>'<section class="panel"><h2>'+esc(g.name)+'</h2>'+
 '<p><a href="'+esc(safe(g.url))+'" target="_blank" rel="noopener noreferrer">Официальная структура холдинга ↗</a>'+
 ' · В аналитике: '+g.inAnalytics+' · К проверке: '+g.newCandidates.length+'</p>'+
 '<div class="tiles">'+g.members.map(m=>'<article class="member"><b>'+esc(m.name)+'</b>'+
 '<span>'+esc(m.role)+'</span><p>'+esc(m.researchStatus)+'</p>'+
 '<div>Публичные контакты именно этой компании: '+(m.email?esc(m.email):'не подтверждены')+
 (m.phone?' · '+esc(m.phone):'')+'</div><p><a href="'+esc(safe(m.source))+
 '" target="_blank" rel="noopener noreferrer">Источник ↗</a>'+
 (m.analyticClientIds?.length?' · CRM/аналитика: '+m.companyCrmIds.map(esc).join(', '):'')+
 '</p></article>').join('')+'</div></section>').join('');
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<title>ТОП-СЕНС — холдинги</title><style>body{font:14px system-ui,sans-serif;background:#f1f6fa;color:#18364b;margin:0}'+
 'header{background:#173d57;color:white;padding:22px max(18px,calc((100% - 1100px)/2))}main{max-width:1100px;margin:auto;padding:20px}'+
 '.panel,.member{border:1px solid #d6e2e9;background:white;border-radius:12px;padding:17px}.panel{margin-bottom:17px}'+
 '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.member b{display:block;font-size:16px}.member span{display:block;color:#567789;margin:7px 0}'+
 'p{line-height:1.55}a{color:#127489}h1,h2{margin:0 0 10px}.notice{background:white;border-radius:12px;padding:15px}</style></head>'+
 '<body><header><h1>Холдинги и предприятия для проработки</h1><div>Один холдинг — много отдельных юридических лиц</div></header>'+
 '<main><p><a href="/contractors">← Центральный дашборд</a> · <a href="/contractors/deal-only">Клиенты из сделок</a></p>'+
 '<p class="notice">Контакты приведены только со страниц соответствующей организации на официальном сайте. Отсутствие карточки CRM не означает отсутствие прошлых сделок. Кандидаты предназначены для сверки и плана продаж; автоматическая рассылка и обзвон не выполняются.</p>'+
 cards+'</main></body></html>';
}
module.exports={page};

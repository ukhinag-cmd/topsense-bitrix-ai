"use strict";
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function page(payload){
 const items=(payload.dealOnlyClients||[]);
 const safe=raw=>{try{const u=new URL(raw);return u.protocol==="https:"?u.href:""}catch{return""}};
 const cards=items.map(c=>'<article class="card"><h2>'+esc(c.name)+'</h2>'+
 '<div class="status">Компания установлена из названий сделок, карточка CRM отсутствует</div>'+
 '<p><strong>Направление:</strong> '+esc(c.category)+' · '+esc(c.organizationType||"Тип требует проверки")+'</p>'+
 (c.relationStatus?'<p><b>'+esc(c.relationStatus)+'</b></p>':'')+
 '<p>'+esc(c.evidenceNote)+'</p>'+
 (c.siteCandidate?'<p>Сайт: <a href="'+esc(safe(c.siteCandidate))+
 '" target="_blank" rel="noopener noreferrer">'+esc(c.siteCandidate)+'</a> · '+esc(c.siteCandidateStatus)+'</p>':'')+
 '<p><strong>Найденные сделки:</strong> '+(c.dealRefs||[]).length+'</p>'+
 '<div class="deals">'+(c.dealRefs||[]).map(d=>'<p><a href="'+esc(safe(d.url))+
 '" target="_blank" rel="noopener noreferrer">Сделка №'+esc(d.id)+' ↗</a> · '+esc(d.title)+
 ' · '+esc(d.relationshipEvidence)+'</p>').join('')+'</div>'+
 '<p class="small">Покупки и юридическая связь подтверждаются отдельно. Сделки с пустым COMPANY_ID не менялись.</p></article>').join('');
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — клиенты из сделок</title>'+
 '<style>body{font:14px system-ui;background:#f2f6fa;color:#17374a;margin:0}header{background:#123c53;padding:25px max(18px,calc((100% - 1060px)/2));color:#fff}main{max-width:1060px;margin:auto;padding:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}.card{background:white;padding:18px;border:1px solid #d9e5eb;border-radius:12px}.status{font-weight:700;color:#126b72}.small{color:#567785;font-size:12px}.deals p{border-top:1px solid #ecf2f5;padding-top:10px}a{color:#10738a}h1{margin:0 0 6px}h2{margin:0 0 12px}</style></head>'+
 '<body><header><h1>Клиенты, найденные по сделкам</h1><div>История заявок важнее ручного заполнения карточек компаний</div></header><main>'+
 '<p><a href="/contractors">← Центральный дашборд</a> · <a href="/contractors/holdings">Холдинги</a></p>'+
 '<p>Эти организации присутствуют в переписке и сделках, но не имеют соответствующей компании в текущей выгрузке CRM. Их аналитические карточки не создают и не меняют компании в Bitrix24.</p>'+
 '<div class="cards">'+(cards||'<p>Кандидаты ещё не прочитаны из сделок.</p>')+'</div></main></body></html>';
}
module.exports={page};

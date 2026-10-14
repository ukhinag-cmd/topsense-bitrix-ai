"use strict";
// Cards, not tables. Accessible only through crm-dashboard's existing auth.
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function html(payload,options={}){
 const d=payload.incomingLeads||{status:"not_started",items:[],total:0,pending:0,linked:0};
 const category=["all","lead","incoming_deal","other_deal"].includes(options.kind)?options.kind:"all";
 const link=["all","linked","pending"].includes(options.link)?options.link:"all";
 const filtered=(d.items||[]).filter(x=>(category==="all"||x.kind===category)&&(link==="all"||(link==="linked"?x.linkStatus==="known_company":x.linkStatus==="pending_identification")));
 const totalPages=Math.max(1,Math.ceil(filtered.length/100)),page=Math.min(totalPages,Math.max(1,parseInt(String(options.page||"1"),10)||1));
 const items=filtered.slice((page-1)*100,page*100);
 const pageUrl=p=>"/contractors/leads?kind="+encodeURIComponent(category)+"&link="+encodeURIComponent(link)+"&page="+p;
 const h=d.history||{};
 const cards=items.map(l=>'<article class="card"><header><strong>'+esc(l.title||"Новый лид")+'</strong><span>'+(l.kind==="lead"?"Лид №":l.kind==="incoming_deal"?"Входящая сделка №":"Другая сделка №")+esc(l.id)+'</span></header>'+
  '<p class="state">'+(l.linkStatus==="known_company"?"Связан с существующей CRM-компанией №"+esc(l.companyId):"На идентификации компании")+'</p>'+
  '<p>Создан: '+esc(l.createdAt||"не указано")+' · Статус: '+esc(l.statusId||"—")+' · CRM ответственный #'+esc(l.ownerId||"—")+'</p>'+
  '<a href="'+esc(l.crmUrl)+'" target="_blank" rel="noopener noreferrer">Открыть лид в Bitrix24 ↗</a></article>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180"><title>ТОП-СЕНС — новые лиды</title>'+
 '<style>body{font:14px system-ui;margin:0;background:#f2f6fa;color:#14364b}header.page{background:#112f48;color:#fff;padding:25px max(18px,calc((100% - 1200px)/2))}h1{margin:3px 0}main{max-width:1200px;margin:auto;padding:20px}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat,.card{background:white;padding:18px;border:1px solid #dce6ea;border-radius:12px}.stat{flex:1;min-width:150px}.stat strong{display:block;font-size:28px}.stat span{color:#627e8b;font-size:12px}.list{margin-top:18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.card header{display:flex;flex-direction:column;gap:5px}.card header span{font-size:12px;color:#66808c}.card p{color:#577384}.card .state{color:#156c7a;font-weight:700}a{color:#157183}.notice{margin:15px 0;color:#506d7e}</style></head>'+
 '<body><header class="page"><h1>Новые лиды · ТОП-СЕНС</h1><p>Входящие заявки на идентификации отдельно от подтверждённых компаний — только чтение CRM</p></header>'+
 '<main><p><a href="/contractors">← 7 дашбордов</a> · <a href="/contractors/list">Основная база компаний</a></p>'+
 '<div class="stats"><div class="stat"><strong>'+Number(d.total||0)+'</strong><span>Новых лидов и входящих сделок</span></div>'+
 '<div class="stat"><strong>'+Number(d.pending||0)+'</strong><span>Ожидают идентификации</span></div>'+
 '<div class="stat"><strong>'+Number(d.linked||0)+'</strong><span>Связаны по CRM компании/контакта</span></div>'+
 '<div class="stat"><strong>'+Number(h.leads||0)+'</strong><span>Лиды с 6 сентября</span></div>'+
 '<div class="stat"><strong>'+Number(h.deals||0)+'</strong><span>Сделки всех воронок с 6 сентября</span></div>'+
 '<div class="stat"><strong>'+Number(h.october||0)+'</strong><span>Записи с 1 октября</span></div></div>'+
 '<p class="notice">Состояние чтения: '+esc(d.status||"not_started")+' · последнее обновление '+esc(d.updatedAt||"—")+
 (d.error?' · '+esc(d.error):"")+'. Показаны последние '+items.length+' из '+Number(d.total||0)+' лидов и сделок с 6 сентября. Совпадение названия или почты не является основанием объединения.</p>'+
 '<p class="notice">Страница '+page+' из '+totalPages+' · <a href="/contractors/leads?kind=all">Все</a> · <a href="/contractors/leads?kind=lead">Лиды</a> · <a href="/contractors/leads?kind=incoming_deal">Входящие сделки</a> · <a href="/contractors/leads?kind=other_deal">Другие сделки</a> · <a href="/contractors/leads?link=pending">Нет компании</a> · <a href="/contractors/leads?link=linked">Связанные</a></p>'+
 '<p class="notice">'+(page>1?'<a href="'+esc(pageUrl(page-1))+'">← Назад</a>':'')+' '+(page<totalPages?'<a href="'+esc(pageUrl(page+1))+'">Следующая →</a>':'')+'</p>'+
 '<div class="list">'+(cards||'<div class="card">Лиды пока не загружены или за период записей не найдено.</div>')+'</div></main></body></html>';
}
module.exports={html};

"use strict";
// Cards, not tables. Accessible only through crm-dashboard's existing auth.
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function html(payload){
 const d=payload.incomingLeads||{status:"not_started",items:[],total:0,pending:0,linked:0};
 const items=(d.items||[]).slice(0,200);
 const cards=items.map(l=>'<article class="card"><header><strong>'+esc(l.title||"Новый лид")+'</strong><span>Лид №'+esc(l.id)+'</span></header>'+
  '<p class="state">'+(l.linkStatus==="known_company"?"Связан с существующей CRM-компанией №"+esc(l.companyId):"На идентификации компании")+'</p>'+
  '<p>Создан: '+esc(l.createdAt||"не указано")+' · Статус: '+esc(l.statusId||"—")+'</p>'+
  '<a href="'+esc(l.crmUrl)+'" target="_blank" rel="noopener noreferrer">Открыть лид в Bitrix24 ↗</a></article>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180"><title>ТОП-СЕНС — новые лиды</title>'+
 '<style>body{font:14px system-ui;margin:0;background:#f2f6fa;color:#14364b}header.page{background:#112f48;color:#fff;padding:25px max(18px,calc((100% - 1200px)/2))}h1{margin:3px 0}main{max-width:1200px;margin:auto;padding:20px}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat,.card{background:white;padding:18px;border:1px solid #dce6ea;border-radius:12px}.stat{flex:1;min-width:150px}.stat strong{display:block;font-size:28px}.stat span{color:#627e8b;font-size:12px}.list{margin-top:18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.card header{display:flex;flex-direction:column;gap:5px}.card header span{font-size:12px;color:#66808c}.card p{color:#577384}.card .state{color:#156c7a;font-weight:700}a{color:#157183}.notice{margin:15px 0;color:#506d7e}</style></head>'+
 '<body><header class="page"><h1>Новые лиды · ТОП-СЕНС</h1><p>Лиды на идентификации отдельно от подтверждённых компаний — только чтение CRM</p></header>'+
 '<main><p><a href="/contractors">← 7 дашбордов</a> · <a href="/contractors/list">Основная база компаний</a></p>'+
 '<div class="stats"><div class="stat"><strong>'+Number(d.total||0)+'</strong><span>Недавних лидов</span></div>'+
 '<div class="stat"><strong>'+Number(d.pending||0)+'</strong><span>Ожидают идентификации</span></div>'+
 '<div class="stat"><strong>'+Number(d.linked||0)+'</strong><span>Связаны с компаниями по CRM ID</span></div></div>'+
 '<p class="notice">Состояние чтения: '+esc(d.status||"not_started")+' · последнее обновление '+esc(d.updatedAt||"—")+
 (d.error?' · '+esc(d.error):"")+'. Показаны последние '+items.length+' лидов за доступный период. Совпадение названия или почты не является основанием объединения.</p>'+
 '<div class="list">'+(cards||'<div class="card">Лиды пока не загружены или за период записей не найдено.</div>')+'</div></main></body></html>';
}
module.exports={html};

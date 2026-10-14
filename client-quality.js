"use strict";
// Read-only status page generated only after crm-dashboard has authenticated the request.
const allTypes=require("./company-types").types;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num=v=>Number(v||0).toLocaleString("ru-RU");
function summary(payload){
 const customers=payload.companies||[];
 const validTypes=new Set(allTypes.map(x=>x.name));
 const typed=customers.filter(c=>validTypes.has(c.organizationType));
 const groupStatuses={};
 for(const c of customers){
  const key=validTypes.has(c.organizationType)?"typed":"untyped";
  const k=key+" / "+String(c.siteStatus||"not_started");
  groupStatuses[k]=(groupStatuses[k]||0)+1;
 }
 const covered=new Set(typed.map(c=>c.organizationType)).size;
 const typeCounts=[...validTypes].map(type=>({type,count:typed.filter(c=>c.organizationType===type).length}));
 const provisionalNameOnly=typed.filter(c=>String(c.segmentSource||"").includes("Название CRM, без подтверждения сайтом")).length;
 const officialWebsite=typed.filter(c=>String(c.segmentConfidence||"").startsWith("Высокая — официальный сайт")).length;
 const audit=payload.salesAudit||{},dup=payload.duplicateStats||{},sites=payload.siteCrawl||{},mail=payload.mailAudit||{};
 const incomplete=typed.length!==customers.length||
  Number(dup.reviewGroupCount||0)>0||
  audit.status!=="complete"||
  Number(sites.queued||0)>0||Number(sites.active||0)>0||
  Number((audit.orphanDeals||{}).unmatched||0)>0;
 return {
  timestamp:new Date().toISOString(),status:payload.status,
  crmCards:Number(payload.crmCardTotal||0),customers:customers.length,typed:typed.length,
  untyped:customers.length-typed.length,provisionalNameOnly,officialWebsite,coveragePercent:customers.length?Math.round(typed.length/customers.length*1000)/10:0,
  taxonomyTotal:validTypes.size,representedTypes:covered,unrepresentedTypes:validTypes.size-covered,typeCounts,
  duplicateGroups:Number(dup.groupedCount||0),duplicateReview:Number(dup.reviewGroupCount||0),
  duplicateIntegrity:dup.duplicateCoverageValidated===true,
  scannedSites:Number(sites.checkedSites||0),restoredProfiles:Number(sites.restoredProfiles||0),
  siteQueue:Number(sites.queued||0),siteActive:Number(sites.active||0),
  siteAbsent:Number((sites.byStatus||{}).site_absent||0),
  siteStore:sites.checkpoint||{},researchCompletion:payload.researchCompletion||{},
  incomingLeads:payload.incomingLeads||{},
  contactsAt:payload.contactsAt||null,mailChecked:Number(mail.checked||0),
  salesStatus:audit.status||"not_started",scannedDeals:Number(audit.scannedDeals||0),
  totalDeals:Number(audit.totalDeals||0),orphanDeals:Number((audit.orphanDeals||{}).orphanDeals||0),
  unlinkedDeals:Number((audit.orphanDeals||{}).unmatched||0),
  recoveryVerified:Number((audit.orphanDeals||{}).totalRecoveredLinks||0),
  aiReconciliation:payload.aiReconciliation||{},groupStatuses,incomplete
 };
}
function html(payload){
 const q=summary(payload);
 const metrics=[
  ["Сводных клиентов",q.customers],["Определён тип",q.typed],["Не определён",q.untyped],
  ["Исходных CRM-карточек",q.crmCards],["Только по названию (предварит.)",q.provisionalNameOnly],["Официальный сайт в CRM-проверке",q.officialWebsite],["Типов в базе",q.representedTypes+" / "+q.taxonomyTotal],
  ["Дублей на ручную проверку",q.duplicateReview],["Сайтов реально проверено",q.scannedSites],
  ["Сайтов восстановлено из хранилища",q.restoredProfiles],["Сайтов в очереди",q.siteQueue],
  ["Без известного адреса сайта",q.siteAbsent],["Компаний проверено по почте",q.mailChecked],
  ["Связей сделок подтверждено",q.recoveryVerified],
  ["Исследования завершены",Number(q.researchCompletion.completed||0)],
  ["Новые лиды на идентификации",Number(q.incomingLeads.pending||0)]
 ];
 const ai=q.aiReconciliation;
 const aiMetrics=[
  ["AI-результатов в хранилище",ai.saved||0],
  ["Подтверждённых результатов",ai.classified||0],
  ["Подтверждённые без типа в итоговой карточке",ai.classifiedMissingInFinal||0],
  ["Предложенный тип не принят справочником",ai.classifiedMissingValidType||0],
  ["Подтверждённый тип заменён",ai.finalTypeOverridden||0],
  ["Результатов на проверке",ai.review||0],
  ["На проверке с предложенным типом",ai.reviewWithProposedType||0],
  ["AI-результат без CRM-карточки",ai.notInCurrentCrm||0]
 ];
 const aiTiles=aiMetrics.map(([label,value])=>'<section class="tile"><strong>'+num(value)+'</strong><span>'+esc(label)+'</span></section>').join("");
 const lines=Object.entries(q.groupStatuses).sort((a,b)=>b[1]-a[1])
  .map(([key,count])=>"<tr><td>"+esc(key)+"</td><td>"+num(count)+"</td></tr>").join("");
 const typeRows=q.typeCounts.map(x=>"<tr><td>"+esc(x.type)+"</td><td>"+num(x.count)+"</td></tr>").join("");
 const tiles=metrics.map(([label,value])=>'<section class="tile"><strong>'+esc(typeof value==="number"?num(value):value)+'</strong><span>'+esc(label)+'</span></section>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — качество клиентской базы</title><style>'+
 'body{margin:0;font:14px system-ui;background:#f0f5f7;color:#193b48}header{background:#103e51;color:white;padding:26px max(20px,calc((100% - 1150px)/2))}header h1{margin:0;font-size:23px}header p{color:#d3e8ed}main{max-width:1150px;margin:auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.tile,.panel{background:white;border:1px solid #d9e5ea;border-radius:12px;padding:16px}.tile strong{display:block;font-size:25px}.tile span{font-size:12px;color:#5a7884}.panel{margin:14px 0}h2{font-size:19px;margin:0 0 10px}.note{color:#627c87}a{color:#147b82}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2ecef}th{background:#edf6f8}.status{font-weight:700}nav{margin-bottom:16px}nav a{margin-right:16px}</style></head><body>'+
 '<header><h1>Контроль качества · ТОП-СЕНС</h1><p>' +num(q.taxonomyTotal)+' типов организаций · без правок Bitrix24 · предварительные признаки не равны проверенным фактам</p></header><main>'+
 '<nav><a href="/contractors">База клиентов</a><a href="/contractors/duplicates">Дубли</a><a href="/contractors/excluded">Исключённые карточки</a><a href="/contractors/leads">Новые лиды</a></nav>'+
 '<div class="panel"><b>Снимок типизации:</b> <span class="status">'+(q.classificationProvisional?"ПРЕДВАРИТЕЛЬНЫЙ — восстановление/обход ещё идёт":"ОБХОД ЗАВЕРШЁН — результат требует проверки")+'</span>. '+(q.restorationPending?"Сохранённые профили ещё загружаются; временное снижение счётчика не означает потерю классификаций. ":"")+'<b>Статус проверки:</b> <span class="status">'+(q.incomplete?"НЕ ЗАВЕРШЕНА":"Нужна финальная независимая сверка")+'</span> · расчёт на '+esc(q.timestamp)+'. Источник: текущий защищённый снимок CRM/аналитики. Не следует считать процент типизации процентом юридически подтверждённых компаний.</div>'+
 '<div class="panel"><h2>Покрытие классификации</h2><strong style="font-size:34px">'+esc(q.coveragePercent)+'%</strong><div style="height:9px;background:#e3edf0;border-radius:8px;overflow:hidden;margin:11px 0"><div style="background:#13778a;height:100%;width:'+Math.max(0,Math.min(100,q.coveragePercent))+'%"></div></div></div>'+
 '<div class="grid">'+tiles+'</div>'+ '<div class="panel"><h2>Сверка сохранённых AI-результатов</h2><p class="note">Подсчёт по исходным CRM ID до виртуального объединения. Статус review не означает подтверждённый тип; никакие AI-запросы здесь не выполняются.</p><div class="grid">'+aiTiles+'</div></div>'+
 '<div class="panel"><h2>Все '+num(q.taxonomyTotal)+' типов</h2><p>Без компаний в текущем срезе: '+num(q.unrepresentedTypes)+' типов. Нулевое значение не означает отсутствие компаний этого типа в CRM, оно означает отсутствие установленного типа.</p><details><summary>Показать разбивку по всем типам</summary><table><thead><tr><th>Тип организации</th><th>Компаний</th></tr></thead><tbody>'+typeRows+'</tbody></table></details></div>'+
 '<div class="panel"><h2>Контроль дубликатов</h2><p>Виртуально сгруппировано '+num(q.duplicateGroups)+' групп; требует ручной сверки '+num(q.duplicateReview)+' групп. Регрессионная целостность источников: '+(q.duplicateIntegrity?"проверена":"не подтверждена")+'. Никакие карточки в CRM не объединялись.</p></div>'+
 '<div class="panel"><h2>Контакты, сделки и источники</h2><p>Аудит сделок: '+esc(q.salesStatus)+'. Прочитано '+num(q.scannedDeals)+' / '+(q.totalDeals?num(q.totalDeals):"не известно")+'. Непривязанных сделок: '+num(q.orphanDeals)+'; из них без найденной связи '+num(q.unlinkedDeals)+'. Подтверждённые восстановленные связи: '+num(q.recoveryVerified)+'. Это не означает завершённый аудит всех сделок.</p>'+
 '<p>Хранилище сайтов: '+(q.siteStore.configured?"подключено по конфигурации":"не подтверждено")+ '; восстановлено при запуске '+num(q.restoredProfiles)+' проверок, ожидают сохранения '+num(q.siteStore.pendingWrites||0)+', ошибок записи '+num(q.siteStore.writeErrors||0)+'. При отсутствии хранилища процент после перезапуска может временно снизиться.</p></div>'+
 '<div class="panel"><h2>Типизация в разрезе доступности сайтов</h2><table><thead><tr><th>Статус</th><th>Компаний</th></tr></thead><tbody>'+lines+'</tbody></table><p class="note">Состояние сайта — наблюдение, а не подтверждение юридической принадлежности домена. Окончательная проверка требует независимых реквизитов и источников.</p></div></main></body></html>';
}
module.exports={summary,html};
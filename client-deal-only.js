"use strict";
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function page(payload,options={}){
 const kind=["all","repeat","reviewed"].includes(options.kind)?options.kind:"all";
 const requested=Math.max(1,Number.parseInt(String(options.page||"1"),10)||1);
 const stats=payload.unlinkedDiscovery||{};
 const all=payload.dealOnlyClients||[];
 const filtered=all.filter(x=>kind==="all"||kind==="repeat"?
  (kind==="all"||x.candidateReview===true&&Number(x.crmDealCount||0)>=2):
  !x.candidateReview);
 const pageSize=36,pageCount=Math.max(1,Math.ceil(filtered.length/pageSize));
 const shown=Math.min(pageCount,requested);
 const records=filtered.slice((shown-1)*pageSize,shown*pageSize);
 const safe=raw=>{try{const u=new URL(raw);return u.protocol==="https:"?u.href:""}catch{return""}};
 const link=(label,uri)=>'<a href="'+esc(safe(uri))+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>';
 const tile=(value,label)=>'<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>';
 const cards=records.map(c=>'<article class="card"><h2>'+esc(c.name)+'</h2>'+
 '<div class="status">'+(c.nameStatus==="legal_name_verified"?
 'Юридическое название подтверждено независимыми реквизитами':
 c.nameStatus==="legal_name_from_incoming_requisites"?
 'Юридическое название найдено в переписке · требует внешней сверки':
 c.nameStatus==="identity_conflict"?
 'Противоречивые реквизиты · требуется проверка':
 'Предварительное название из сделки · требуется проверка')+'</div>'+
 (c.originalName&&c.originalName!==c.name?
 '<p><b>Было в аналитике:</b> '+esc(c.originalName)+' → <b>установлено:</b> '+esc(c.name)+'</p>':'')+
 (c.aliases?.length>1?'<p><b>Синонимы и прежние названия:</b> '+
 c.aliases.filter(x=>x!==c.name).slice(0,6).map(esc).join('; ')+'</p>':'')+
 (c.nameEvidence?.length?'<p><b>Основание названия:</b> '+
 c.nameEvidence.map(e=>esc(e.sourceRef||e.source)).slice(0,3).join('; ')+'</p>':'')+
 '<p><strong>Направление:</strong> '+esc(c.category)+' · '+esc(c.organizationType||"Тип требует проверки")+'</p>'+
 (c.relationStatus?'<p>'+esc(c.relationStatus)+'</p>':'')+
 (c.evidenceNote?'<p>'+esc(c.evidenceNote)+'</p>':'')+
 (c.siteCandidate?'<p>Сайт: '+link(c.siteCandidate,c.siteCandidate)+' · '+esc(c.siteCandidateStatus)+'</p>':'')+
 '<p><strong>Сделок-кандидатов:</strong> '+Number(c.crmDealCount??c.dealRefs?.length??0)+
 ' · покупка и юридическая связь пока не подтверждены</p>'+
 '<p>Углублённо изучено писем и истории: '+Number(c.emailAnalysedDeals||0)+' сделок · '+'<strong>приоритет:</strong> повторные обращения</p>'+
 '<details><summary>Из каких сделок собрана карточка</summary><div class="deals">'+
 (c.dealRefs||[]).map(d=>'<p>'+link('Сделка №'+d.id,d.url)+' · '+esc(d.title)+
 ' · '+esc(d.relationshipEvidence||'Название требует независимой сверки')+
 (d.emailAnalysis?' · проверено входящих писем: '+Number(d.emailAnalysis.incomingEmails||0)+
  ', последующих: '+Number(d.emailAnalysis.subsequentIncomingEmails||0)+
  ', вложений: '+Number(d.emailAnalysis.attachmentCount||0):' · переписка ещё ожидает анализа')+
 '</p>').join('')+
 '</div></details></article>').join('');
 const menu='<nav><a href="/contractors">← Дашборд</a> · <a href="/contractors/holdings">Холдинги</a> · '+
 '<a href="/contractors/deal-only?kind=all">Все кандидаты</a> · '+
 '<a href="/contractors/deal-only?kind=repeat">С повторными сделками</a> · '+
 '<a href="/contractors/deal-only?kind=reviewed">Известные примеры</a></nav>';
 const pageLink=n=>'/contractors/deal-only?kind='+encodeURIComponent(kind)+'&page='+n;
 const pager='<div class="paging">'+(shown>1?'<a href="'+pageLink(shown-1)+'">← Назад</a>':'')+
 '<span>Страница '+shown+' из '+pageCount+'</span>'+
 (shown<pageCount?'<a href="'+pageLink(shown+1)+'">Далее →</a>':'')+'</div>';
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — клиенты из сделок</title>'+
 '<style>body{font:14px system-ui;background:#f2f6fa;color:#17374a;margin:0}header{background:#123c53;padding:25px max(18px,calc((100% - 1150px)/2));color:#fff}'+
 'main{max-width:1150px;margin:auto;padding:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}'+
 '.card,.metric,.note{background:white;padding:18px;border:1px solid #d9e5eb;border-radius:12px}.status{font-weight:700;color:#126b72}'+
 '.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}.metric b{font-size:27px;display:block}.metric span{color:#587388;font-size:12px}'+
 '.deals p{border-top:1px solid #ecf2f5;padding-top:10px}.paging{display:flex;gap:24px;justify-content:center;margin:20px}.paging a{font-weight:700}'+
 'summary{cursor:pointer;color:#087b8d;font-weight:650;margin:9px 0}a{color:#10738a}h1{margin:0 0 6px}h2{margin:0 0 12px;font-size:18px}p{line-height:1.55}</style></head>'+
 '<body><header><h1>Компании, восстановленные из сделок</h1><div>Исследование всей истории Битрикс24, в том числе без компании и контактов</div></header><main>'+
 menu+'<div class="metrics">'+
 tile(stats.totalDeals||'—',"Сделок просмотрено")+
 tile(stats.withoutCompanyId||'—',"Без привязки к компании")+
 tile(stats.crmCardMissingCandidates||'—',"Групп-кандидатов без карточки")+
 tile(stats.possibleExistingClients||'—',"Возможно принадлежат компаниям CRM")+'</div>'+
 '<p class="note">Статус полного сканирования: '+esc(stats.scanCompleteness||"не начато")+
 '. Название в теме сделки — только отправная точка: первое письмо, последующие ответы, реквизиты и документы проверяются отдельно.'+
 ' Не путать число сделок без COMPANY_ID с количеством юридических лиц. Никакие CRM-карточки и сделки не создаются.</p>'+
 pager+'<div class="cards">'+(cards||'<p>Кандидатов по текущему снимку нет или исследование ещё выполняется.</p>')+'</div>'+pager+
 '</main></body></html>';
}
module.exports={page};

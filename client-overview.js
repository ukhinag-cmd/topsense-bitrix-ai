"use strict";
// Seven visual, read-only dashboards: one overview and six commercial sections.
// Rendered behind the existing session gate; no client-side fetch of CRM data.
const types=require("./company-types").types;
const typeMap=new Map(types.map(t=>[t.name,t]));
const sections=["Обзор","Подрядчики","Конечные потребители","Проектные продажи","Партнёрские продажи","Сервис и метрология","Конкуренты"];
const colors=["#2979CF","#1A9C91","#985CD3","#D59B44","#DA7482","#467D9B","#7C8FA3"];
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nr=x=>Number(x||0).toLocaleString("ru-RU");
const pct=(n,d)=>d?Math.round(n*1000/d)/10:0;
function familyToSection(c){
 const t=typeMap.get(c.organizationType);
 if(!t)return sections.includes(c.category)?c.category:"Не определены";
 const f=t.family;
 if(f==="Эксплуатация")return "Конечные потребители";
 if(f==="Подрядчики")return "Подрядчики";
 if(f==="Сервис")return "Сервис и метрология";
 if(f==="Торговля")return "Партнёрские продажи";
 if(f==="Интеграторы"||f==="Проектирование")return "Проектные продажи";
 if(f==="Производители")return c.organizationType==="Производитель газоаналитических приборов"?"Конкуренты":"Проектные продажи";
 return sections.includes(c.category)?c.category:"Не определены";
}
function aggregates(payload,section){
 const all=payload.companies||[];
 const groups=Object.fromEntries(sections.slice(1).map(x=>[x,[]]));
 const other=[];
 for(const c of all){const k=familyToSection(c);if(groups[k])groups[k].push(c);else other.push(c)}
 const selected=section==="Обзор"?all:(groups[section]||[]);
 const typeCounts=new Map(types.map(t=>[t.name,0]));
 const typeRecords=selected.filter(c=>typeMap.has(c.organizationType));
 for(const c of typeRecords)typeCounts.set(c.organizationType,typeCounts.get(c.organizationType)+1);
 const verifiedSite=selected.filter(c=>c.siteStatus==="official_site_verified"||c.siteStatus==="site_profiled").length;
 const provisional=selected.filter(c=>String(c.segmentSource||"").includes("Название CRM, без подтверждения сайтом")).length;
 const withEmail=selected.filter(c=>[...(c.crmEmails||[]),...(c.contactEmails||[])].some(x=>String(x).includes("@"))).length;
 const buyers=selected.filter(c=>String(c.saleInfo?.purchaseStatus||"").startsWith("БЫЛА")).length;
 const with2025=selected.filter(c=>c.finance2025?.year===2025&&Number.isFinite(c.finance2025?.amountRUB)).length;
 const sources=[
  {name:"Официальный сайт / профиль прочитан",value:verifiedSite},
  {name:"Только признаки из названия",value:provisional},
  {name:"Не определён тип",value:selected.length-typeRecords.length}
 ];
 const paid=payload.paidClassification||{};
 return {total:selected.length,typed:typeRecords.length,untyped:selected.length-typeRecords.length,
  typeUsed:new Set(typeRecords.map(c=>c.organizationType)).size,withEmail,buyers,with2025,verifiedSite,provisional,
  typeRows:[...typeCounts].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value),
  groups:Object.entries(groups).map(([name,cards])=>({name,value:cards.length,typed:cards.filter(c=>typeMap.has(c.organizationType)).length})),
  others:other.length,sources,paid};
}
function hero(label,value,detail,color){
 return '<div class="metric"><div class="metric-label">'+esc(label)+'</div><div class="metric-num" style="color:'+color+'">'+esc(value)+'</div><div class="metric-detail">'+esc(detail)+'</div></div>';
}
function bars(items,total,color,limit=12,showZero=false){
 const usable=items.filter(x=>showZero||x.value>0).slice(0,limit);
 const max=Math.max(1,...usable.map(x=>x.value));
 return usable.map(x=>'<div class="bar"><div class="barline"><span>'+esc(x.name)+'</span><b>'+nr(x.value)+'</b></div>'+
 '<div class="rail"><div class="fill" style="width:'+Math.max(0,Math.min(100,100*x.value/max))+'%;background:'+color+'"></div></div>'+
 '<div class="small">'+pct(x.value,total)+'% текущей выборки</div></div>').join("")||'<p class="empty">Подтверждённых назначений пока нет.</p>';
}
function render(payload,requested){
 const section=sections.includes(requested)?requested:"Обзор",b=aggregates(payload,section),all=aggregates(payload,"Обзор");
 const coverage=pct(b.typed,b.total),quality=String(payload.status||"starting");
 const checking=Number(payload.siteCrawl?.checkedSites||0),sitePending=Number(payload.siteCrawl?.queued||0);
 const reviewed=Number(payload.duplicateStats?.reviewGroupCount||0),grouped=Number(payload.duplicateStats?.groupedCount||0);
 const ai=payload.paidClassification||{};
 const barColor=colors[Math.max(0,sections.indexOf(section))];
 const tabs=sections.map((s,i)=>'<a class="tab '+(s===section?"active":"")+'" href="/contractors'+(i?"?section="+encodeURIComponent(s):"")+'">'+esc(s)+'</a>').join("");
 const dataNote=quality==="ready"?"CRM доступна":quality==="stale"?"Данные устарели — CRM обновляется":quality==="error"?"Ошибка CRM — доступен прежний снимок":"Идёт загрузка CRM";
 const sectionsMarkup=section==="Обзор"?
  '<div class="panel"><div class="panelheading"><h2>Коммерческие направления</h2><span>6 дашбордов</span></div>'+
  '<div class="segments">'+b.groups.map((g,i)=>'<a class="segment" href="/contractors?section='+encodeURIComponent(g.name)+'"><span class="dot" style="background:'+colors[(i+1)%colors.length]+'"></span><span class="segment-main"><b>'+esc(g.name)+'</b><small>Назначен тип: '+nr(g.typed)+' / '+nr(g.value)+'</small></span><strong>'+nr(g.value)+'</strong><span class="arrow">↗</span></a>').join("")+'</div>'+
  '<p class="minor">Остальные / неразнесённые: '+nr(b.others)+'. Направления предварительные, если тип не подтверждён независимым источником.</p></div>'
 :'<div class="panel"><div class="panelheading"><h2>Виды организаций внутри направления</h2><span>45 согласованных типов</span></div>'+
  bars(b.typeRows,b.total,barColor,16)+'</div>';
 const typeBlock=section==="Обзор"?'<div class="panel"><div class="panelheading"><h2>Самые распространённые типы</h2><span>из 45 утверждённых</span></div>'+bars(b.typeRows,b.total,"#3186B6",13)+'</div>':
  '<div class="panel"><div class="panelheading"><h2>Происхождение данных</h2><span>Степень достоверности</span></div>'+bars(b.sources,b.total,barColor,8,true)+'</div>';
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta http-equiv="refresh" content="120"><meta name="color-scheme" content="light"><title>ТОП-СЕНС — '+esc(section)+' · клиентская аналитика</title>'+
 '<style>:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#153147;background:#f2f6fa}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}header{background:#112F48;color:#fff;padding:25px max(20px,calc((100vw - 1460px)/2)) 27px}.brand{font-size:12px;font-weight:900;letter-spacing:2.4px;color:#5EC2C6}header h1{margin:7px 0;font-size:clamp(23px,2.3vw,34px);letter-spacing:-.7px}header p{color:#BBD1DC;font-size:13px;line-height:1.7;margin:0}.quick{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.quick a{background:#234860;border:1px solid #386076;padding:9px 13px;border-radius:8px;font-size:12px;color:#D6F0F2}.quick a:hover{background:#337185}main{max-width:1500px;margin:auto;padding:22px}.tabs{display:flex;gap:8px;overflow-x:auto;flex-wrap:wrap;margin-bottom:19px}.tab{padding:12px 14px;font-weight:700;font-size:13px;background:white;border:1px solid #DAE5EC;border-radius:10px;white-space:nowrap}.tab.active{background:#146B80;color:white;border-color:#146B80}.status{padding:12px 16px;background:#E7F1F7;border:1px solid #CBDEE9;border-radius:11px;font-size:12px;color:#3F6679;margin-bottom:16px;line-height:1.7}.status strong{color:#173C53}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel{background:#fff;border:1px solid #E0EAF0;border-radius:15px;box-shadow:0 3px 10px #1c3c5307}.metric{padding:20px;display:flex;flex-direction:column;gap:10px;min-height:135px}.metric-label{font-weight:700;font-size:12px;color:#5B7280}.metric-num{font-size:clamp(27px,3vw,43px);font-weight:800;letter-spacing:-.9px}.metric-detail{font-size:12px;color:#66808B;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:17px}.panel{padding:21px;min-width:0}.panelheading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:21px;flex-wrap:wrap}.panelheading h2{margin:0;font-size:19px;letter-spacing:-.3px}.panelheading span{font-size:12px;color:#8195A2}.segments{display:grid;gap:9px}.segment{display:flex;align-items:center;gap:13px;background:#F4F8FA;border:1px solid #E1EAF0;border-radius:10px;padding:13px}.segment:hover{background:#E7F3F8}.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.segment-main{display:grid;gap:4px;flex:1}.segment-main b{font-size:13px}.segment-main small{font-size:11px;color:#6F8390}.segment strong{font-size:23px}.arrow{color:#77A5B2}.bar{margin:0 0 14px}.barline{display:flex;justify-content:space-between;gap:10px;line-height:1.4;font-size:13px}.barline b{white-space:nowrap;font-size:14px}.rail{height:9px;background:#E9F0F5;border-radius:20px;overflow:hidden;margin:7px 0 3px}.fill{height:100%;border-radius:20px}.small,.minor{font-size:11px;color:#8699A3}.ringWrap{display:flex;justify-content:space-between;align-items:center;gap:20px}.ring{height:175px;width:175px;border-radius:50%;background:conic-gradient(#1D9A9A 0 var(--n),#E7EFF2 var(--n) 100%);display:grid;place-items:center;flex-shrink:0}.ring-inner{height:125px;width:125px;border-radius:50%;background:white;display:flex;align-items:center;justify-content:center;flex-direction:column}.ring-inner strong{font-size:34px}.ring-inner small{font-size:11px;color:#81929C}.ringLegend{flex:1}.ringLegend p{margin:8px 0;font-size:13px}.ringLegend strong{color:#244B61}.ringLegend a,.cta{display:inline-block;margin-top:10px;border:1px solid #b6d9df;color:#136D80;background:#EAF7F7;padding:10px 13px;border-radius:8px;font-size:12px;font-weight:700}.empty{color:#7C94A0}.foot{color:#8297A0;font-size:12px;margin:19px 4px;line-height:1.8}@media(max-width:950px){.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:500px){.stats{gap:8px}.metric{padding:14px}.metric-num{font-size:28px}.ring{height:138px;width:138px}.ring-inner{height:100px;width:100px}.ring-inner strong{font-size:25px}}</style></head><body>'+
 '<header><div class="brand">TOP–SENSE · АНАЛИТИКА CRM</div><h1>'+esc(section==="Обзор"?"База клиентов — 7 дашбордов":section)+'</h1><p>Визуальный контроль клиентской базы, сегментации, продаж и источников данных · защищённый доступ</p>'+
 '<div class="quick"><a href="/contractors/changes">Новые компании и контакты ↗</a><a href="/contractors/quality">Контроль качества ↗</a><a href="/contractors/duplicates">Проверка дублей ↗</a><a href="/contractors/list">Поиск конкретной компании ↗</a></div></header>'+
 '<main><nav class="tabs">'+tabs+'</nav><div class="status"><strong>'+esc(dataNote)+'</strong> · обновление CRM: '+esc(payload.updatedAt||"ещё нет")+' · последний показатель охвата на текущем снимке, а не подтверждение проверки всей базы. Автообновление страницы каждые 2 минуты.</div>'+
 '<div class="stats">'+
 hero("Компании",nr(b.total),section==="Обзор"?"аналитических карточек из "+nr(payload.crmCardTotal||0)+" CRM": "в направлении "+section,"#174863")+
 hero("Тип определён",nr(b.typed),coverage+'% выбранных компаний · включая предварительные',"#168B8F")+
 hero("Не определён тип",nr(b.untyped),"Требуется проверка по источникам","#C7843E")+
 hero("Клиенты с e-mail",nr(b.withEmail),"с контактным адресом CRM","#4B78B9")+
 hero("Подтверждения покупки",nr(b.buyers),"сделки по согласованным стадиям","#247A78")+
 hero("Проверенный сайт/профиль",nr(b.verifiedSite),"не всегда юридическая верификация","#6855B0")+
 hero("Финансовая отчётность 2025",nr(b.with2025),"выручка компаний, не продажи ТОП-СЕНС","#587D87")+
 hero("Типов, встречающихся в базе",b.typeUsed+" / "+types.length,"все 45 типов доступны в справочнике","#947244")+
 '</div><div class="grid">'+
 '<section class="panel"><div class="panelheading"><h2>Покрытие классификации</h2><span>Основная задача проекта</span></div>'+
 '<div class="ringWrap"><div class="ring" style="--n:'+coverage+'%"><div class="ring-inner"><strong>'+coverage+'%</strong><small>охват базы</small></div></div>'+
 '<div class="ringLegend"><p><strong>'+nr(b.typed)+'</strong> компаний получили тип</p><p><strong>'+nr(b.untyped)+'</strong> требуют анализа</p><p><strong>'+nr(b.provisional)+'</strong> тип присвоен только по названию</p><a href="/contractors/quality">Проверить надёжность →</a></div></div></section>'+
 sectionsMarkup+typeBlock+
 '<section class="panel"><div class="panelheading"><h2>Сайты и источники</h2><span>По всей CRM</span></div>'+
 '<div class="stats" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
 tileSmall("Обойдено сайтов",checking)+tileSmall("В очереди",sitePending)+
 tileSmall("Нет указанного сайта",Number(payload.siteCrawl?.byStatus?.site_absent||0))+
 tileSmall("Восстановлено проверок",Number(payload.siteCrawl?.restoredProfiles||0))+'</div>'+
 '<div class="minor" style="margin-top:15px">Обработанным сайтом считается только фактически прочитанный адрес. Поиск сайта по названию — отдельно от подтверждения компании.</div></section>'+
 '<section class="panel"><div class="panelheading"><h2>Результаты платного AI</h2><span>Контроль затрат</span></div>'+
 '<div class="stats" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
 tileSmall("В пилотах / проходах",Number(payload.aiResults||0)+Number(ai.newResults||0))+
 tileSmall("Новые AI-запросы",Number(ai.calls||0))+
 tileSmall("Доп. расходы, оценка",ai.estimatedUsd!=null?"$"+Number(ai.estimatedUsd).toFixed(2):"—",true)+
 tileSmall("Лимит нового прохода",ai.limitUsd!=null?"$"+Number(ai.limitUsd).toFixed(0):"—",true)+'</div>'+
 '<div class="minor" style="margin-top:15px">Затраты по журналу модели — оценка, окончательное списание подтверждается биллингом API. Предыдущие пилоты учитываются отдельно. Неопределённые/неподтверждённые ответы не выдаются за подтверждённую классификацию.</div></section>'+
 '<section class="panel"><div class="panelheading"><h2>Проблемные данные</h2><span>Без изменений в Bitrix24</span></div>'+
 '<div class="stats" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
 tileSmall("Группы виртуальных дублей",grouped)+tileSmall("Проверить дубли",reviewed)+
 tileSmall("Сделки без найденной связи",Number(payload.salesAudit?.orphanDeals?.unmatched||0))+
 tileSmall("Писем/карточек проверено",Number(payload.mailAudit?.checked||0))+'</div>'+
 '<a class="cta" href="/contractors/duplicates">Открыть проверку дублей →</a></section>'+
 '</div><div class="foot">Данные только для просмотра; классификация по названию и алгоритмическая сегментация предварительны. Прямые CRM-карточки не объединяются. Информация о поставках не выводится без подтверждения стадии и документов. Основной интерфейс намеренно построен без таблиц.</div></main></body></html>';
}
function tileSmall(label,value,isText=false){
 return '<div style="padding:14px;border:1px solid #E4ECF0;border-radius:10px;background:#F5F9FB"><div style="color:#68808D;font-size:11px;line-height:1.4">'+esc(label)+'</div><strong style="font-size:23px;display:block;margin-top:6px;color:#1E4B63">'+(isText?esc(value):nr(value))+'</strong></div>';
}
module.exports={render,aggregates,sections};

"use strict";
// Seven visual, read-only dashboards: one overview and six commercial sections.
// Rendered behind the existing session gate; no client-side fetch of CRM data.
const types=require("./company-types").types;
const typeMap={has:name=>types.some(t=>t.name===name),get:name=>types.find(t=>t.name===name)};
const sections=["Обзор","Подрядчики","Конечные потребители","Проектные продажи","Партнёрские продажи","Сервис и метрология","Конкуренты"];
const colors=["#2979CF","#1A9C91","#985CD3","#D59B44","#DA7482","#467D9B","#7C8FA3"];
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nr=x=>Number(x||0).toLocaleString("ru-RU");
const pct=(n,d)=>d?Math.round(n*1000/d)/10:0;
function reviewedWebsiteUrl(raw){
 const value=String(raw||"").trim();
 if(!value||/\s|[<>]/.test(value))return "";
 try{
  const url=new URL(/^https?:\/\//i.test(value)?value:"https://"+value);
  if(!["http:","https:"].includes(url.protocol)||!url.hostname.includes(".")||url.username||url.password)return "";
  return url.href;
 }catch{return ""}
}
// Distinguish a reviewed site from an unverified CRM/domain candidate.
function companyWebsiteDetails(c){
 const strong=new Set(["site_profiled","site_read_no_clear_type","official_site_verified","research_completed"]);
 const profiled=reviewedWebsiteUrl(c?.siteProfileUrl);
 const declared=reviewedWebsiteUrl(c?.siteVerified);
 // Email domain can belong to an entire holding: never offer the shared root
 // as this distinct legal entity's website without independent proof.
 const candidate=reviewedWebsiteUrl(c?.siteCandidate);
 const verified=(strong.has(String(c?.siteStatus||""))&&Boolean(profiled||declared))||
  (c?.verificationStatus==="confirmed"&&Boolean(declared));
 const url=verified?(profiled||declared):(profiled||declared||candidate);
 let domain="";try{domain=new URL(url).hostname.replace(/^www[.]/,"")}catch{}
 return {url,domain,verified:Boolean(url&&verified),candidate:Boolean(url&&!verified)};
}
function familyToSection(c){
 const t=typeMap.get(c.organizationType);
 if(!t)return sections.includes(c.category)?c.category:"Не определены";
 const f=t.family;
 if(f==="Эксплуатация"||f==="Отраслевые производства")return "Конечные потребители";
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
function bars(items,total,color,limit=12,showZero=false,linkedTypes=false){
 const usable=items.filter(x=>showZero||x.value>0).slice(0,limit);
 const max=Math.max(1,...usable.map(x=>x.value));
 return usable.map(x=>'<div class="bar">'+(linkedTypes?'<a class="barlink" href="/contractors?type='+encodeURIComponent(x.name)+'#clients"><span>'+esc(x.name)+'</span><b>'+nr(x.value)+' ↗</b></a>':'<div class="barline"><span>'+esc(x.name)+'</span><b>'+nr(x.value)+'</b></div>')+
 '<div class="rail"><div class="fill" style="width:'+Math.max(0,Math.min(100,100*x.value/max))+'%;background:'+color+'"></div></div>'+
 '<div class="small">'+pct(x.value,total)+'% текущей выборки</div></div>').join("")||'<p class="empty">Подтверждённых назначений пока нет.</p>';
}
function render(payload,requested,requestedType="",requestedPage=1,requestedPurchase=""){
 const section=sections.includes(requested)?requested:"Обзор",b=aggregates(payload,section),all=aggregates(payload,"Обзор");
 const pickedType=typeMap.has(requestedType)?requestedType:"";
 const pickedPurchase=["buyers","shipped","paid","both"].includes(requestedPurchase)?requestedPurchase:"";
 const purchaseMatch=c=>{
  const sale=c.saleInfo||{},bought=String(sale.purchaseStatus||"").startsWith("БЫЛА");
  if(!pickedPurchase)return true;
  if(!bought)return false;
  return pickedPurchase==="buyers"||pickedPurchase==="paid"&&Boolean(sale.paid)||
   pickedPurchase==="shipped"&&Boolean(sale.shipped)||
   pickedPurchase==="both"&&Boolean(sale.paid)&&Boolean(sale.shipped);
 };
 const inSection=(payload.companies||[]).filter(c=>section==="Обзор"||familyToSection(c)===section);
 const selectedClients=(pickedType?inSection.filter(c=>c.organizationType===pickedType):inSection).filter(purchaseMatch)
  .slice().sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"ru")||Number(a.id)-Number(b.id));
 const pageSize=48,page=Math.max(1,Math.min(100,Number(requestedPage)||1));
 // Visually group repeated labels. Legal identities, purchases, finances,
 // contacts and deal links remain separate for each CRM record.
 const nameKey=c=>String(c.name||"").toLowerCase().replace(/ё/g,"е")
  .replace(/^(?:ооо|ао|пао|зао|оао)\s*["«]?\s*/,"")
  .replace(/[^а-яa-z0-9]/g,"");
 const groupedByName=new Map();
 for(const c of selectedClients){
  const key=nameKey(c)||"crm:"+String(c.id);
  if(!groupedByName.has(key))groupedByName.set(key,[]);
  groupedByName.get(key).push(c);
 }
 const groupedCards=[...groupedByName.values()];
 const totalPages=Math.max(1,Math.ceil(groupedCards.length/pageSize)),shownPage=Math.min(page,totalPages);
 const clients=groupedCards.slice((shownPage-1)*pageSize,shownPage*pageSize);
 const queryBase="/contractors?"+(section!=="Обзор"?"section="+encodeURIComponent(section)+"&":"")+
  (pickedType?"type="+encodeURIComponent(pickedType)+"&":"")+
  (pickedPurchase?"purchase="+encodeURIComponent(pickedPurchase)+"&":"");
 const filterBase="/contractors?"+(section!=="Обзор"?"section="+encodeURIComponent(section)+"&":"")+
  (pickedType?"type="+encodeURIComponent(pickedType)+"&":"");
 const buyerButtons='<nav class="buyerFilters" aria-label="Отбор по подтверждённым покупкам">'+
  [["","Все компании"],["buyers","Покупали у нас"],["shipped","Была отгрузка"],["paid","Была оплата"],["both","Отгрузка и оплата"]]
  .map(([k,label])=>'<a class="buyerFilter '+(pickedPurchase===k?"on":"")+'" href="'+filterBase+
   (k?"purchase="+encodeURIComponent(k)+"&":"")+'#clients">'+esc(label)+'</a>').join("")+'</nav>';
 const cards=clients.map(group=>{
  const inner=group.map(c=>{
  const ids=c.crmIdList?.length?c.crmIdList:[c.id];
  const bought=String(c.saleInfo?.purchaseStatus||"").startsWith("БЫЛА");
  const website=companyWebsiteDetails(c),site=website.url;
  const finance=c.finance2025||{},staff=c.staffEvidence||{};
  const revenue=finance.year===2025&&Number.isFinite(finance.amountRUB)?
   Number(finance.amountRUB).toLocaleString("ru-RU",{maximumFractionDigits:0})+" ₽":"нет подтверждённых данных";
  const staffValue=Number.isInteger(staff.count)&&staff.count>0?
   (staff.approximate?"около ":"")+Number(staff.count).toLocaleString("ru-RU")+
   " чел. ("+(staff.year?String(staff.year)+" г.":"год не указан")+")":"нет подтверждённых данных";
  const staffSource=staff.count&&staff.sourceUrl?
   ' <a href="'+esc(staff.sourceUrl)+'" target="_blank" rel="noopener noreferrer">Источник ↗</a>':"";
  const companyTitle=esc(c.name||"Без названия");
  return '<article class="companyCard"><div class="companyTitle">'+
   (site?'<a class="companyWebsite" href="'+esc(site)+'" target="_blank" rel="noopener noreferrer" title="'+(website.verified?"Перейти на изученный сайт":"Сайт-кандидат: принадлежность компании не подтверждена")+'">'+companyTitle+' ↗</a>':companyTitle)+'</div>'+
   '<div class="companyMeta">CRM '+esc(ids.join(", "))+' · '+esc(c.organizationType||c.industryDescription||"Тип требует проверки")+'</div>'+
   (c.corporateGroup?'<div class="companyMeta">Группа: '+esc(c.corporateGroup)+' · отдельное юридическое лицо</div>':"")+
   '<div class="companyMeta">'+(bought?"Подтверждена покупка по стадиям":"Покупка: не подтверждена / идёт проверка")+
   ' · '+(website.verified?"Сайт изучен":website.candidate?"Сайт-кандидат · требует подтверждения":"Сайт не найден")+'</div>'+   (site?'<div class="companyMeta websiteLine">Сайт: <a class="websiteAddress" href="'+esc(site)+'" target="_blank" rel="noopener noreferrer">'+esc(website.domain)+' ↗</a></div>':"")+
   '<div class="companyMeta financialLine">Выручка за 2025 год: '+esc(revenue)+'</div>'+
   '<div class="companyMeta financialLine">Численность сотрудников: '+esc(staffValue)+staffSource+'</div>'+
   '<a href="'+esc(c.crmUrl||"")+'" target="_blank" rel="noopener noreferrer">Открыть в Bitrix24 ↗</a></article>';
  }).join("");
  if(group.length===1)return inner;
  return '<details class="nameDuplicateGroup"><summary>'+esc(group[0].name)+
   ' · '+nr(group.length)+' отдельных CRM-записи <span>проверить юридическую идентичность ▾</span></summary>'+
   '<p class="minor">Свернуты только в отображении. Сделки, покупки, реквизиты и сайты этих карточек не смешиваются.</p>'+
   '<div class="groupMembers">'+inner+'</div></details>';
 }).join("");
 const pages=Array.from({length:totalPages},(_,i)=>i+1)
  .filter(x=>Math.abs(x-shownPage)<=2||x===1||x===totalPages)
  .map(x=>'<a class="pageLink '+(x===shownPage?"current":"")+'" href="'+queryBase+'page='+x+'#clients">'+x+'</a>').join("");
 const clientsBlock='<section class="panel clientPanel" id="clients"><div class="panelheading"><h2>'+
  esc(pickedType?"Компании: "+pickedType:section==="Обзор"?"Компании клиентской базы":"Компании направления «"+section+"»")+
  '</h2><span>'+nr(selectedClients.length)+' CRM-карточек · '+nr(groupedCards.length)+' визуальных групп</span></div>'+
  '<p class="minor">Покупки считаются подтверждёнными только при прохождении согласованных стадий отгрузки/оплаты. Если аудит ещё не завершён, часть покупателей может пока не отображаться.</p>'+
  buyerButtons+
  '<div class="companyGrid">'+(cards||'<div class="empty">По выбранному типу компаний пока не обнаружено.</div>')+'</div>'+
  (totalPages>1?'<nav class="pages">'+pages+'</nav>':"")+'</section>';
 const census=section==="Обзор"?payload.classificationDisplay:null;
 const effectiveTyped=census?.provisional?census.typed:b.typed;
 const effectiveUntyped=census?.provisional?census.untyped:b.untyped;
 const displayTyped=effectiveTyped===null?"—":nr(effectiveTyped);
 const displayUntyped=effectiveUntyped===null?"—":nr(effectiveUntyped);
 const metricBase=census?.provisional&&census.source==="last_complete_virtual_groups_changed"?census.total:b.total;
 const coverage=effectiveTyped===null?null:pct(effectiveTyped,metricBase);
 const coverageLabel=coverage===null?"—":coverage+"%";
 const coverageArc=coverage===null?0:coverage;
 const censusNote=census?.provisional?
  (census.source.startsWith("last_complete")?
   "Последний завершённый снимок ("+census.typed+" / "+census.total+") от "+census.completedAt+". Текущий пересчёт ещё идёт; временное уменьшение не публикуется.":
   "Восстановление сохранённых исследований. Итоговый счётчик появится после завершения прохода."):
  "Текущие показатели рассчитаны по восстановленным данным.";
 const quality=String(payload.status||"starting");
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
 :'<div class="panel"><div class="panelheading"><h2>Виды организаций внутри направления</h2><span>Расширяемый справочник типов</span></div>'+
  bars(b.typeRows,b.total,barColor,16,false,true)+'</div>';
 const typeBlock=section==="Обзор"?'<div class="panel"><div class="panelheading"><h2>Самые распространённые типы</h2><span>из расширяемого справочника</span></div>'+bars(b.typeRows,b.total,"#3186B6",13,false,true)+'</div>':
  '<div class="panel"><div class="panelheading"><h2>Происхождение данных</h2><span>Степень достоверности</span></div>'+bars(b.sources,b.total,barColor,8,true)+'</div>';
 // Every evidence-backed subtype stays discoverable even if currently empty.
 // Server-rendered links do not rely on JavaScript being enabled.
 const allCounts=new Map(types.map(t=>[t.name,0]));
 for(const c of payload.companies||[])if(allCounts.has(c.organizationType))
  allCounts.set(c.organizationType,allCounts.get(c.organizationType)+1);
 const families=[...new Set(types.map(t=>t.family))];
 const subtypeExplorer='<section class="panel typeExplorer" id="subtypes"><div class="panelheading"><h2>Все '+nr(types.length)+' подтипов клиентов</h2><span>Нажмите на любой тип для списка компаний</span></div>'+
  '<div class="typeFamilyGrid">'+families.map(family=>'<div class="typeGroup"><h3>'+esc(family)+'</h3>'+
    types.filter(t=>t.family===family).map(t=>
     '<a class="typeChoice '+(pickedType===t.name?'picked':'')+'" href="/contractors?type='+encodeURIComponent(t.name)+'#clients">'+
     '<span>'+esc(t.name)+'</span><b>'+nr(allCounts.get(t.name))+' ↗</b></a>').join("")+
   '</div>').join("")+'</div>'+
   '<p class="minor">Число рядом с типом показывает реальные назначенные типы в текущей базе. Ноль означает, что подтверждённых назначений нет, а не что ссылка не работает.</p></section>';
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta http-equiv="refresh" content="120"><meta name="color-scheme" content="light"><title>ТОП-СЕНС — '+esc(section)+' · клиентская аналитика</title>'+
 '<style>:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#153147;background:#f2f6fa}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}header{background:#112F48;color:#fff;padding:25px max(20px,calc((100vw - 1460px)/2)) 27px}.brand{font-size:12px;font-weight:900;letter-spacing:2.4px;color:#5EC2C6}header h1{margin:7px 0;font-size:clamp(23px,2.3vw,34px);letter-spacing:-.7px}header p{color:#BBD1DC;font-size:13px;line-height:1.7;margin:0}.quick{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.quick a{background:#234860;border:1px solid #386076;padding:9px 13px;border-radius:8px;font-size:12px;color:#D6F0F2}.quick a:hover{background:#337185}main{max-width:1500px;margin:auto;padding:22px}.tabs{display:flex;gap:8px;overflow-x:auto;flex-wrap:wrap;margin-bottom:19px}.tab{padding:12px 14px;font-weight:700;font-size:13px;background:white;border:1px solid #DAE5EC;border-radius:10px;white-space:nowrap}.tab.active{background:#146B80;color:white;border-color:#146B80}.status{padding:12px 16px;background:#E7F1F7;border:1px solid #CBDEE9;border-radius:11px;font-size:12px;color:#3F6679;margin-bottom:16px;line-height:1.7}.status strong{color:#173C53}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel{background:#fff;border:1px solid #E0EAF0;border-radius:15px;box-shadow:0 3px 10px #1c3c5307}.metric{padding:20px;display:flex;flex-direction:column;gap:10px;min-height:135px}.metric-label{font-weight:700;font-size:12px;color:#5B7280}.metric-num{font-size:clamp(27px,3vw,43px);font-weight:800;letter-spacing:-.9px}.metric-detail{font-size:12px;color:#66808B;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:17px}.panel{padding:21px;min-width:0}.panelheading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:21px;flex-wrap:wrap}.panelheading h2{margin:0;font-size:19px;letter-spacing:-.3px}.panelheading span{font-size:12px;color:#8195A2}.segments{display:grid;gap:9px}.segment{display:flex;align-items:center;gap:13px;background:#F4F8FA;border:1px solid #E1EAF0;border-radius:10px;padding:13px}.segment:hover{background:#E7F3F8}.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.segment-main{display:grid;gap:4px;flex:1}.segment-main b{font-size:13px}.segment-main small{font-size:11px;color:#6F8390}.segment strong{font-size:23px}.arrow{color:#77A5B2}.bar{margin:0 0 14px}.barlink{display:flex;justify-content:space-between;gap:12px;font-weight:650;font-size:13px;line-height:1.4;color:#146b80;text-decoration:none}.barlink:hover{text-decoration:underline}.barline{display:flex;justify-content:space-between;gap:10px;line-height:1.4;font-size:13px}.barline b{white-space:nowrap;font-size:14px}.rail{height:9px;background:#E9F0F5;border-radius:20px;overflow:hidden;margin:7px 0 3px}.fill{height:100%;border-radius:20px}.small,.minor{font-size:11px;color:#8699A3}.ringWrap{display:flex;justify-content:space-between;align-items:center;gap:20px}.ring{height:175px;width:175px;border-radius:50%;background:conic-gradient(#1D9A9A 0 var(--n),#E7EFF2 var(--n) 100%);display:grid;place-items:center;flex-shrink:0}.ring-inner{height:125px;width:125px;border-radius:50%;background:white;display:flex;align-items:center;justify-content:center;flex-direction:column}.ring-inner strong{font-size:34px}.ring-inner small{font-size:11px;color:#81929C}.ringLegend{flex:1}.ringLegend p{margin:8px 0;font-size:13px}.ringLegend strong{color:#244B61}.ringLegend a,.cta{display:inline-block;margin-top:10px;border:1px solid #b6d9df;color:#136D80;background:#EAF7F7;padding:10px 13px;border-radius:8px;font-size:12px;font-weight:700}.empty{color:#7C94A0}.typeExplorer{margin:18px 0}.typeFamilyGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.typeGroup{border:1px solid #dbe9ef;border-radius:10px;background:#f7fafb;padding:13px}.typeGroup h3{margin:0 0 10px;font-size:14px;color:#174b62}.typeChoice{display:flex;justify-content:space-between;align-items:flex-start;gap:11px;padding:9px 7px;border-bottom:1px solid #e1edf1;color:#176b81;font-size:12px;font-weight:700}.typeChoice:hover{background:#e9f5f8;text-decoration:underline}.typeChoice.picked{background:#def4ee;border-left:3px solid #148374;padding-left:8px}.typeChoice b{white-space:nowrap;color:#266477}.buyerFilters{display:flex;gap:8px;flex-wrap:wrap;margin:13px 0 18px}.buyerFilter{border:1px solid #b7d9df;border-radius:9px;background:#f5fafb;color:#166a7c;padding:10px 13px;font-size:12px;font-weight:750}.buyerFilter:hover{background:#e2f3f5}.buyerFilter.on{background:#146b80;color:#fff;border-color:#146b80}.nameDuplicateGroup{border:1px solid #bdd7df;background:#f6fafd;border-radius:12px;padding:13px;min-width:0}.nameDuplicateGroup>summary{cursor:pointer;color:#136a7d;font-weight:750;font-size:14px}.nameDuplicateGroup>summary span{color:#9b6b24;font-size:11px;font-weight:500}.groupMembers{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:14px 0 4px}.clientPanel{margin:18px 0}.companyGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:11px}.companyCard{border:1px solid #dce9ee;background:#f8fbfd;border-radius:10px;padding:15px;overflow-wrap:anywhere}.companyTitle{font-weight:750;font-size:15px}.companyWebsite{color:#116e83;text-decoration:underline;text-decoration-color:#a4ced8;text-underline-offset:3px}.companyWebsite:hover{color:#064c62;text-decoration-color:currentColor}.websiteLine{margin-top:5px}.websiteAddress{color:#116e83;font-weight:700;text-decoration:underline;text-underline-offset:3px}.companyMeta{font-size:12px;color:#657e8e;line-height:1.5;margin-top:7px}.companyCard a{display:inline-block;margin-top:12px;color:#11748a;font-size:12px;font-weight:700}.pages{display:flex;gap:7px;flex-wrap:wrap;margin-top:18px}.pageLink{padding:8px 12px;border:1px solid #cde0e8;border-radius:7px}.pageLink.current{background:#147b82;color:white}.foot{color:#8297A0;font-size:12px;margin:19px 4px;line-height:1.8}@media(max-width:950px){.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:500px){.stats{gap:8px}.metric{padding:14px}.metric-num{font-size:28px}.ring{height:138px;width:138px}.ring-inner{height:100px;width:100px}.ring-inner strong{font-size:25px}}</style></head><body>'+
 '<header><div class="brand">TOP–SENSE · АНАЛИТИКА CRM</div><h1>'+esc(section==="Обзор"?"База клиентов — 7 дашбордов":section)+'</h1><p>Визуальный контроль клиентской базы, сегментации, продаж и источников данных · защищённый доступ</p>'+
 '<div class="quick"><a href="/contractors?purchase=buyers#clients">Покупали у нас ↗</a><a href="/contractors#subtypes">Все подтипы ↗</a><a href="/contractors/quality">Контроль качества ↗</a><a href="/contractors/leads">Новые лиды ↗</a><a href="/contractors/duplicates">Проверка дублей ↗</a><a href="/contractors/list">Поиск конкретной компании ↗</a></div></header>'+
 '<main><nav class="tabs">'+tabs+'</nav><div class="status"><strong>'+esc(dataNote)+'</strong> · обновление CRM: '+esc(payload.updatedAt||"ещё нет")+' · последний показатель охвата на текущем снимке, а не подтверждение проверки всей базы. Автообновление страницы каждые 2 минуты.</div>'+
 '<div class="status">'+esc(censusNote)+'</div><div class="stats">'+
 hero("Компании",nr(b.total),section==="Обзор"?"аналитических карточек из "+nr(payload.crmCardTotal||0)+" CRM": "в направлении "+section,"#174863")+
 hero("Тип определён",displayTyped,coverageLabel+' выбранных компаний · включая предварительные',"#168B8F")+
 hero("Не определён тип",displayUntyped,"Требуется проверка по источникам","#C7843E")+
 hero("Клиенты с e-mail",nr(b.withEmail),"с контактным адресом CRM","#4B78B9")+
 hero("Подтверждения покупки",nr(b.buyers),"сделки по согласованным стадиям","#247A78")+
 hero("Проверенный сайт/профиль",nr(b.verifiedSite),"не всегда юридическая верификация","#6855B0")+
 hero("Выручка 2025: источники",b.with2025?nr(b.with2025):"Нет данных","Пока нет подтверждённых финансовых сведений ФНС","#587D87")+
 hero("Типов, встречающихся в базе",b.typeUsed+" / "+types.length,"все доступные подтипы видны в справочнике","#947244")+
 hero("Исследование завершено",nr(payload.researchCompletion?.completed||0),"Не отправляются на повторную проверку компании","#155f55")+
 hero("Лиды на идентификации",nr(payload.incomingLeads?.pending||0),"Отдельная очередь, не добавляются как подтверждённые компании","#A27129")+
 '</div><div class="grid">'+
 '<section class="panel"><div class="panelheading"><h2>Покрытие классификации</h2><span>Основная задача проекта</span></div>'+
 '<div class="ringWrap"><div class="ring" style="--n:'+coverageArc+'%"><div class="ring-inner"><strong>'+coverageLabel+'</strong><small>охват базы</small></div></div>'+
 '<div class="ringLegend"><p><strong>'+displayTyped+'</strong> компаний получили тип</p><p><strong>'+displayUntyped+'</strong> требуют анализа</p><p><strong>'+nr(b.provisional)+'</strong> тип присвоен только по названию</p><a href="/contractors/quality">Проверить надёжность →</a></div></div></section>'+
 sectionsMarkup+typeBlock+
 '<section class="panel"><div class="panelheading"><h2>Сайты и источники</h2><span>По всей CRM</span></div>'+
 '<div class="stats" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
 tileSmall("Обойдено сайтов",checking)+tileSmall("В очереди",sitePending)+
 tileSmall("Нет указанного сайта",Number(payload.siteCrawl?.byStatus?.site_absent||0))+
 tileSmall("Восстановлено проверок",Number(payload.siteCrawl?.restoredProfiles||0))+tileSmall("Завершено исследований компаний",Number(payload.researchCompletion?.completed||0))+'</div>'+
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
 '</div>'+subtypeExplorer+clientsBlock+'<div class="foot">Данные только для просмотра; классификация по названию и алгоритмическая сегментация предварительны. Прямые CRM-карточки не объединяются. Информация о поставках не выводится без подтверждения стадии и документов. Основной интерфейс намеренно построен без таблиц.</div></main></body></html>';
}
function tileSmall(label,value,isText=false){
 return '<div style="padding:14px;border:1px solid #E4ECF0;border-radius:10px;background:#F5F9FB"><div style="color:#68808D;font-size:11px;line-height:1.4">'+esc(label)+'</div><strong style="font-size:23px;display:block;margin-top:6px;color:#1E4B63">'+(isText?esc(value):nr(value))+'</strong></div>';
}
module.exports={render,aggregates,sections,reviewedWebsiteUrl,companyWebsiteDetails};

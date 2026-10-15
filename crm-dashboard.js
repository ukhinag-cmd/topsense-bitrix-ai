"use strict";
const crypto=require("crypto"),fs=require("fs"),path=require("path");
const state={status:"starting",updatedAt:null,error:null,companies:[],excludedCompanies:[],rawCrmTotal:0,refreshing:false,linkedContacts:new Map(),contactsLoading:false,contactsAt:null,pilot:new Map(),pilotUpdatedAt:null,pilotLoading:false,paidControl:{}};
function analyticSeeds(){
 try{
   const arr=JSON.parse(String(process.env.TOPSENSE_ANALYTIC_SEED_JSON||"[]"));
   return Array.isArray(arr)?new Map(arr.filter(x=>x&&x.id).map(x=>[String(x.id),x])):new Map();
 }catch{return new Map()}
}
const ORG_TYPES=require("./company-types").types;
const sections=["Подрядчики","Конечные потребители","Сервис и метрология","Партнёрские продажи","Проектные продажи","Конкуренты","Смежные организации","Не определены"];
const mailDomains=require("./company-email-domains");
const html=fs.readFileSync(path.join(__dirname,"crm-dashboard.html"),"utf8");
function write(res,status,body,type="application/json; charset=utf-8",headers={}) {
 const value=typeof body==="string"?body:JSON.stringify(body);
 res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY","content-security-policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",...headers});
 res.end(value);
}
function equals(a,b){const x=crypto.createHash("sha256").update(String(a)).digest(),y=crypto.createHash("sha256").update(String(b)).digest();return crypto.timingSafeEqual(x,y)}
function sessionKey(){return String(process.env.TOPSENSE_DASHBOARD_PASSWORD||"")}
function cookieValid(req){
 const key=sessionKey();if(key.length<16)return false;
 const raw=String(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("ts_crm_auth="));
 if(!raw)return false;
 const token=raw.slice("ts_crm_auth=".length),parts=token.split(".");
 if(parts.length!==2||!/^[0-9]+$/.test(parts[0]))return false;
 const ts=Number(parts[0]),age=Date.now()-ts;
 if(!Number.isSafeInteger(ts)||age<0||age>8*3600*1000)return false;
 const sig=crypto.createHmac("sha256",key).update(parts[0]).digest("hex");
 return equals(parts[1],sig);
}
function authorised(req){
 const pass=sessionKey();if(pass.length<16)return false;
 if(cookieValid(req))return true;
 try{
   const raw=req.headers.authorization||"";
   if(!raw.startsWith("Basic "))return false;
   const d=Buffer.from(raw.slice(6),"base64").toString("utf8"),idx=d.indexOf(":");
   return idx>0&&equals(d.slice(0,idx),"topsense")&&equals(d.slice(idx+1),pass);
 }catch{return false}
}
function loginPage(error){
 const note=error?"<p style='color:#b84132'>Проверьте логин и пароль.</p>":"";
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — вход</title><style>
 body{margin:0;min-height:100vh;background:#f3f7fa;font:16px system-ui;color:#16364c;display:grid;place-items:center}
 main{max-width:400px;width:calc(100% - 38px);background:white;border:1px solid #dfeaf0;box-shadow:0 12px 40px #16364c17;border-radius:20px;padding:32px}
 h1{font-size:27px;margin:0 0 9px}p{color:#66808e;font-size:14px;line-height:1.5}
 label{font-size:12px;font-weight:700;display:block;margin-top:17px}
 input{padding:14px;border:1px solid #cddce5;border-radius:10px;width:100%;box-sizing:border-box;margin-top:7px;font:inherit}
 button{background:#135b6c;color:white;border:0;border-radius:10px;padding:14px;width:100%;margin-top:22px;font:700 15px system-ui}
 </style></head><body><main><h1>ТОП-СЕНС</h1><p>Закрытая аналитика клиентской базы</p>${note}
 <form method="POST" action="/intel/login"><label>Логин<input name="username" value="topsense" required></label>
 <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
 <button type="submit">Открыть дашборд</button></form></main></body></html>`;
}
function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]))}
function initialHtml(payload){
 const subset=payload.companies.slice(0,12);

 let text=html;
 // Two independent dimensions: commercial dashboard and detailed organization type.
 // Keep all approved types visible, including those without verified assignments.
 const groups=[...new Set(ORG_TYPES.map(t=>t.family))];
 const groupHtml=groups.map(f=>{
   const items=ORG_TYPES.filter(t=>t.family===f);
   return '<details style="border-top:1px solid #315269;padding:6px 0"><summary style="cursor:pointer;padding:9px;color:#d7e8f0;font-size:12px">'+escapeHtml(f)+' · '+items.length+'</summary>'+
     items.map(t=>'<div style="font-size:11px;color:#a9c5d1;padding:7px 10px 8px 17px;line-height:1.35" title="'+escapeHtml(t.description)+'">'+escapeHtml(t.name)+'</div>').join("")+'</details>';
 }).join("");
 text=text.replace('<nav id="nav"></nav>',
   '<nav id="nav"></nav><div class="subbrand" style="margin-top:24px">Расширяемый справочник типов организаций</div><div style="padding-bottom:20px">'+groupHtml+'</div>');
 text=text.replace('const categories=["Обзор","Подрядчики","Предприятия","Интеграторы и проекты","Дистрибьюторы","Сервис и метрология","Конкуренты","Не определены"];',
   'const categories=["Обзор","Подрядчики","Конечные потребители","Проектные продажи","Партнёрские продажи","Сервис и метрология","Конкуренты","Смежные организации","Не определены"];');
 text=text.replace('Отдельная аналитическая база уже содержит 49 подтверждённых карточек, но пока ещё не синхронизирована с этим веб-реестром. Здесь — прямое чтение Битрикс24 и подтверждения действующего реестра подрядчиков.',
 'Веб-дашборд показывает '+payload.analyticTyped+' проверенных и требующих сверки карточек из аналитики (подтверждено: '+payload.analyticConfirmed+'). Основные данные CRM загружаются непосредственно из Битрикс24.');
 text=text.replace('<div class="notice" id="notice">',
 '<div class="notice" style="background:#e9f6f2;color:#126957;border-color:#b8e7d7">Пилот AI: '+payload.aiResults+
 ' CRM-карточек обработано; '+payload.aiCalls+' запросов к модели, '+payload.aiNoSite+
 ' без пригодного сайта. Подробные организационные типы должны подтверждаться по источникам.</div>'+
 '<div class="notice" id="notice">');
 const cards=subset.map(c=>{
   const verified=Boolean(c.type)&&!String(c.verification||"").startsWith("AI —");
   return '<article class="item"><div class="top"><div class="itemname">'+escapeHtml(c.name)+'</div><span class="num">CRM '+escapeHtml(c.id)+'</span></div>'+
   '<div class="labels"><span class="flag '+(verified?'verified':'')+'">'+(verified?'Подтверждено':'Ожидает проверки')+'</span><span class="flag">'+escapeHtml(c.category)+'</span></div>'+
   '<div class="itemdesc">'+escapeHtml(c.type||c.organizationType||'Классификация по названию — предварительная')+'</div>'+
   (c.relatedCards?.length?
     '<div class="itemdesc"><b>Связанные по названию карточки:</b> '+
      c.relatedCards.map(x=>'<a style="color:#147983;text-decoration:underline" href="'+escapeHtml(x.crmUrl)+'" target="_blank" rel="noopener noreferrer">CRM №'+escapeHtml(x.id)+'</a>').join(", ")+
     '<div style="font-size:11px;color:#7d8e98">'+escapeHtml(c.relatedStatus||"Связь требует проверки")+'</div></div>':"")+
   '<div class="links"><a href="'+escapeHtml(c.crmUrl)+'" target="_blank" rel="noopener noreferrer">Открыть в Битрикс24 ↗</a></div></article>'
 }).join("");
 const metrics=[["total",payload.total],["verified",payload.confirmed],["sites",payload.companies.filter(x=>x.siteCandidate).length],["pending",payload.total-payload.confirmed]];
 for(const [id,val] of metrics){
   text=text.replace('id="'+id+'">—</div>','id="'+id+'">'+Number(val).toLocaleString("ru-RU")+'</div>');
 }
 text=text.replace('id="cards"></div>','id="cards">'+(cards||'<div class="empty">Компании загружаются</div>')+'</div>');
 text=text.replace('id="count">—</span>','id="count">'+payload.total+' компаний</span>');
 return text;
}
function value(x){if(Array.isArray(x))return x.map(value).filter(Boolean).join("; ");if(x&&typeof x==="object")return String(x.VALUE||x.value||"");return String(x||"")}
function domain(x){return mailDomains.extract(x)[0]||""}
function website(x){const raw=value(x).split(/[;,\s]+/)[0].trim();if(!raw)return "";try{const u=new URL(/^https?:\/\//i.test(raw)?raw:"https://"+raw);return ["https:","http:"].includes(u.protocol)?u.origin:""}catch{return ""}}
function category(name){
 const n=String(name||"").toLowerCase();
 if(/газоаналит|анкат|газоизмер|хроматэк|газсигнал/.test(n))return "Конкуренты";
 if(/асу.?тп|автоматизац|интеграт|автоматик|кипиа|кпиа/.test(n))return "Проектные продажи";
 if(/ремонт|строй|монтаж|пусконалад|строитель|промфин|подряд|буров/.test(n))return "Подрядчики";
 if(/метролог|поверк|калибров|лаборатор|испытательн/.test(n))return "Сервис и метрология";
 if(/торг|снаб|дистриб|постав|трейд|комплект/.test(n))return "Партнёрские продажи";
 if(/нефт|газпром|лукойл|роснефт|газперераб|завод|комбинат|хим|металлург|горно|энергетик|цбк/.test(n))return "Конечные потребители";
 if(/проект|инжиниринг|проектир/.test(n))return "Проектные продажи";
 return "Не определены";
}
// Public official-site evidence established from the provider's own legal-details page.
// Two CRM cards share the same organization name; never merge their CRM records.
const REVIEWED_PUBLIC_SITES=new Map([
 ["4",{url:"https://ndt-innovation.ru/",name:"НК-ИННОВАЦИИ ЮГ",primaryType:"Дилер промышленного оборудования",source:"Официальный сайт: /contacts и /information/informacziya/o-kompanii, юридическое наименование и ОГРН"}],
 ["1016",{url:"https://ndt-innovation.ru/",name:"НК-ИННОВАЦИИ ЮГ",primaryType:"Дилер промышленного оборудования",source:"Официальный сайт: /contacts и /information/informacziya/o-kompanii, юридическое наименование и ОГРН"}],
 ["2336",{url:"https://gaz-analitik.ru/",name:"ГАЗ-АНАЛИТИК",primaryType:"Дилер промышленного оборудования",source:"Публичный сайт gaz-analitik.ru: официальный дилер, совпадают телефон +7 495 724-99-35 и адрес корпоративной почты zakaz@gaz-analitik.ru"}],
 ["2334",{url:"https://gazoanalit.ru/",name:"НПП ГАЗОАНАЛИТ",primaryType:"Производитель газоаналитических приборов",source:"Публичный сайт gazoanalit.ru: ООО НПП ГазоАналит, собственное производство и газоаналитические системы, совпадает телефон и корпоративная почта"}],
 ["1134",{url:"https://gazoanalit.ru/",name:"НПП ГАЗОАНАЛИТ",primaryType:"Производитель газоаналитических приборов",source:"Публичный сайт gazoanalit.ru: ООО НПП ГазоАналит, производство систем газового анализа; в CRM указано то же полное юридическое наименование"}],
 ["2790",{url:"https://www.gsp-r.ru/",name:"ГСП РЕМОНТ",
  primaryType:"Ремонтный подрядчик ОПО / остановочный ремонт",
  source:"Официальный сайт gsp-r.ru/contacts/: ООО ГСП Ремонт, ИНН 7737106202, телефон +7 (495) 221-38-73 совпадает с CRM №2790"}],
 ["3682",{url:"https://www.gsp-r.ru/",name:"ГСП РЕМОНТ",
  primaryType:"Ремонтный подрядчик ОПО / остановочный ремонт",
  source:"Официальный сайт gsp-r.ru/contacts/: ООО ГСП Ремонт, ИНН 7737106202, телефон +7 (495) 221-38-73 совпадает с CRM №3682"}]
]);
// Company-specific websites independently tied to a CRM entity (name +
// telephone + legal INN). These are not marked as official site content read
// until the website profiler verifies the actual company behind the page.
const IDENTIFIED_WEBSITE_REFERENCES=new Map([
 ["114",{url:"https://avsv.gazprom-neft.ru/",companyName:"АВТОМАТИКА-СЕРВИС",
  corporateGroup:"ПАО Газпром нефть",corporateGroupUrl:"https://gazprom-neft.ru/",legalInn:"5501068136",
  source:"Отраслевые каталоги производителей и партнёров: ООО Автоматика-Сервис, ИНН 5501068136, телефон +7 (3812) 27-77-27, сайт avsv.gazprom-neft.ru; проверить доступность",
  crmPhoneSuffix:"277727"}]
]);
function referencedWebsite(id,company,phones){
 const ref=IDENTIFIED_WEBSITE_REFERENCES.get(String(id));
 if(!ref||String(company||"").toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"")!==
  ref.companyName.toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,""))return null;
 const numbers=(Array.isArray(phones)?phones:[]).map(x=>String(x?.VALUE||x||"").replace(/\D/g,""));
 if(!numbers.some(x=>x.endsWith(ref.crmPhoneSuffix)))return null;
 return ref;
}
function company(x){const id=String(x.ID||"");const reviewedCandidate=REVIEWED_PUBLIC_SITES.get(id);
 const gspSite=String(id)==="2790"||String(id)==="3682";
 const titleCheck=/^(?:(?:ооо|оао|ао)\s*)?["«»]?гсп[ -]?ремонт["«»]?$/i
  .test(String(x.TITLE||"").trim());
 const phoneCheck=(Array.isArray(x.PHONE)?x.PHONE:[])
  .some(z=>String(z?.VALUE||z||"").replace(/\D/g,"").endsWith("4952213873"));
 const reviewed=gspSite&&(!titleCheck||!phoneCheck)?null:reviewedCandidate;
 const identified=referencedWebsite(id,x.TITLE,x.PHONE);
 const gspIds=new Set(["62","2790","2842","3682","3684","3690","3692"]);
 const gspTitle=/^(?:(?:ооо)\s*)?["«»]?гсп[ -]?ремонт["«»]?$/i.test(String(x.TITLE||"").trim())||
  /^филиал[\s«"а-я]*сервисгазавтоматика[\s»"]*ооо[\s«"]*гсп[ -]?ремонт/i.test(String(x.TITLE||"").trim());
 const gspKnown=gspIds.has(id)&&gspTitle;
 const gspType=gspKnown?"Ремонтный подрядчик ОПО / остановочный ремонт":"";
 return {id,name:String(x.TITLE||""),category:gspKnown?"Подрядчики":category(x.TITLE),
  type:gspType,organizationType:gspType,
  typeSource:gspKnown?"Профиль ООО ГСП Ремонт: официальный сайт; принадлежность каждой карточки и филиала сверяется отдельно":"",
siteCandidate:reviewed?.url||website(x.WEB)||identified?.url||"",siteSource:reviewed?"Официальный сайт, проверенный по юридическим данным":website(x.WEB)?"Сайт из CRM":identified?"Сайт организации, установленный по независимым источникам; содержимое и доступность ещё не проверены":"",verifiedOrgType:reviewed?.primaryType||"",verifiedOrgEvidence:reviewed?.source||"",siteReferenceEvidence:identified?.source||"",
 corporateGroup:identified?.corporateGroup||"",
 relatedWebsites:identified?.corporateGroupUrl?[{url:identified.corporateGroupUrl,relation:"corporate_group",label:"Сайт группы компаний",organization:identified.corporateGroup}]:gspKnown&&!reviewed?[{url:"https://www.gsp-r.ru/",relation:"legal_entity_candidate",label:"Официальный сайт ООО ГСП Ремонт; точная привязка CRM-карточки уточняется",organization:"ООО ГСП Ремонт"}]:[],
 legalInnReference:identified?.legalInn||"",corporateDomain:domain(x.EMAIL),crmEmails:(Array.isArray(x.EMAIL)?x.EMAIL.map(e=>String(e.VALUE||e||"")):[]).filter(Boolean),crmPhones:(Array.isArray(x.PHONE)?x.PHONE.map(e=>String(e.VALUE||e||"")):[]).filter(Boolean),crmCity:String(x.ADDRESS_CITY||""),crmRegion:String(x.ADDRESS_REGION||""),crmAddress:[x.ADDRESS,x.ADDRESS_2].filter(Boolean).join(", ").slice(0,280),finance2025:require("./financial-2025").fromCompany(x),staffEvidence:require("./staff-evidence").fromCompany(x),crmUrl:"https://topsense.bitrix24.ru/crm/company/details/"+encodeURIComponent(id)+"/",modified:String(x.DATE_MODIFY||""),responsibleId:String(x.ASSIGNED_BY_ID||""),delivery:"Не проверено"}}
async function page(start){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Bitrix API not configured");
 const endpoint=new URL("crm.company.list.json",base.endsWith("/")?base:base+"/");
 for(let attempt=0;attempt<2;attempt++){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({order:{ID:"ASC"},filter:{},select:["ID","TITLE","WEB","EMAIL","PHONE","ADDRESS","ADDRESS_2","ADDRESS_CITY","ADDRESS_REGION","UF_CRM_AI_REVENUE","UF_CRM_AI_REVENUE_YEAR","UF_CRM_AI_INN","UF_CRM_AI_FIN_SOURCE","DATE_MODIFY","ASSIGNED_BY_ID"],start}),signal:AbortSignal.timeout(18000)});
   const j=await r.json();
   if(!r.ok||j.error||!Array.isArray(j.result))throw Error(j.error_description||j.error||"Bad CRM response "+r.status);
   return j;
  }catch(e){if(attempt)throw e;await new Promise(resolve=>setTimeout(resolve,750))}
 }
}
async function refresh(){
 if(state.refreshing)return;
 state.refreshing=true;
 try{
  const first=await page(0),size=Math.max(1,first.result.length);
  const total=Number(first.total||size),parts=[first.result];
  if(total>6000)throw Error("CRM count exceeds safe limit");
  if(total>size){
    let starts=[];for(let offset=size;offset<total;offset+=size)starts.push(offset);
    for(let i=0;i<starts.length;i+=4){
     const pages=await Promise.all(starts.slice(i,i+4).map(page));
     pages.forEach(p=>parts.push(p.result));
    }
  }else if(first.next!=null){
    let next=first.next,j=0;while(next!=null&&j++<110){let p=await page(next);parts.push(p.result);next=p.next}
  }
  const map=new Map(parts.flat().filter(x=>x&&x.ID).map(x=>[String(x.ID),company(x)]));
  if(map.size<total)throw Error("Incomplete CRM snapshot "+map.size+"/"+total);
  state.rawCrmTotal=map.size;
  const registry=require("./client-registry-quality").split([...map.values()].filter(c=>c.id!=="2"));
  state.companies=registry.valid.sort((a,b)=>Number(a.id)-Number(b.id));
  state.excludedCompanies=registry.excluded;
  console.log(JSON.stringify({component:"registry-quality",event:"client-names-screened",valid:registry.valid.length,excluded:registry.excluded.length}));
  const finStatus={};for(const c of state.companies){const key=c.finance2025?.status||"no_data";finStatus[key]=(finStatus[key]||0)+1}
  console.log(JSON.stringify({component:"topsense-dashboard",event:"financial-2025-coverage",...finStatus}));
  const duplicateReport=require("./crm-duplicates").consolidate(state.companies);
  const dupStats=duplicateReport.stats;
  const crmPairChecks=[["276","1342"],["974","2024"],["1784","2110"]];
  const pairCoverage=crmPairChecks.map(pair=>{
   const exists=pair.every(id=>state.companies.some(c=>String(c.id)===id));
   const group=duplicateReport.duplicates.find(g=>pair.every(id=>g.members.some(m=>String(m.id)===id)));
   return {idPair:pair.join("/"),inCrm:exists,grouped:!!group};
  });
  console.log(JSON.stringify({component:"crm-duplicates",event:"specific-pair-validation",pairs:pairCoverage}));
  if(pairCoverage.some(p=>p.inCrm&&!p.grouped))
   console.warn(JSON.stringify({component:"crm-duplicates",event:"duplicate-invariant-failed",failedPairs:pairCoverage.filter(p=>p.inCrm&&!p.grouped).map(p=>p.idPair)}));
  console.log(JSON.stringify({component:"crm-duplicates",event:"reporting-group-snapshot",...dupStats}));
  // CRM #2 = ООО «ПКФ ТОП-СЕНС» (our own entity), do not include it in client analytics.
  if(require("./crm-sales-audit").stats().status==="not_started")require("./crm-sales-audit").run(state.companies).catch(()=>{});
  require("./crm-mail-evidence").enqueue(state.companies);
  require("./website-profiler").enqueue(state.companies);
  enqueueLinkedContactSites();
  enqueuePreviousPilotSites();
  if(state.contactsAt)enqueueMissingSiteNameSearch();
  state.status="ready";state.updatedAt=new Date().toISOString();state.error=null;
  console.log(JSON.stringify({component:"topsense-dashboard",event:"refresh-ok",count:state.companies.length,excludedOwnCompanies:1,excludedInvalidTitles:state.excludedCompanies.length}));
  setTimeout(coverageLog,2500);
 }catch(e){state.error=String(e.message||e).slice(0,160);state.status=state.companies.length?"stale":"error";console.warn(JSON.stringify({component:"topsense-dashboard",event:"refresh-error",error:state.error}));}
 finally{state.refreshing=false}
}

function enqueueLinkedContactSites(){
 const suggested=[];
 let multipleDomains=0;
 for(const c of state.companies){
  // Keep independently verified company-specific sites unchanged.
  if(c.verifiedOrgType||c.siteSource==="Официальный сайт, проверенный по юридическим данным"||
     c.siteSource==="Сайт организации, установленный по независимым источникам; содержимое и доступность ещё не проверены")continue;
  const linked=state.linkedContacts.get(c.id);
  if(!linked||!linked.emails.size)continue;
  const ranked=mailDomains.ranked(linked.emails);
  if(!ranked.length)continue;
  if(ranked.length>1)multipleDomains++;
  // Corporate email on the company record is the stronger candidate.
  if(c.corporateDomain)continue;
  // Multiple contact domains are no longer discarded. The strongest candidate
  // is inspected, but the profiler must independently confirm company identity.
  const selected=ranked[0][0];
  suggested.push({...c,siteCandidate:"",corporateDomain:selected,siteSource:"Домен привязанного контакта"});
 }
 const actualQueued=suggested.length?require("./website-profiler").enqueue(suggested)||0:0;
 if(actualQueued)console.log(JSON.stringify({component:"topsense-dashboard",event:"linked-corporate-domain-discovery",
  queuedCandidates:actualQueued,candidatesConsidered:suggested.length,companiesWithMultipleContactDomains:multipleDomains}));
}
function enqueueDealMailSites(){
 const profiler=require("./website-profiler");
 const intake=require("./crm-deal-intake");
 let considered=0,queued=0;
 for(const c of state.companies){
  if(queued>=60)break;
  // Previously verified specific legal-entity sites remain authoritative.
  if(c.verifiedOrgType||c.siteCandidate||c.corporateDomain)continue;
  const profile=profiler.get(c.id);
  if(!["site_absent","site_pending","site_unavailable"].includes(profile.status))continue;
  const first=intake.forCompany(c.id).find(d=>d.incomingEmails>0&&d.corporateDomains.length);
  if(!first)continue;
  considered++;
  for(const candidate of first.corporateDomains.slice(0,3)){
   const accepted=profiler.enqueue([{...c,siteCandidate:"",
    corporateDomain:candidate,siteSource:"Домен из входящей сделки"}])||0;
   if(accepted){queued+=accepted;break}
  }
 }
 if(queued)console.log(JSON.stringify({component:"topsense-dashboard",
  event:"deal-email-website-candidates-queued",count:queued,considered}));
 return queued;
}
function resumeUnresolvedCompanySites(){
 if(!state.companies.length||!state.contactsAt)return;
 const profiler=require("./website-profiler");
 const stats=profiler.stats();
 if(!stats.restorationComplete||stats.queued||stats.active)return;
 // Deal e-mails are the first lead source; CRM company data is fallback.
 if(enqueueDealMailSites())return;
 const unresolved=new Set(["site_absent","site_unavailable",
  "site_identity_unclear","site_read_no_clear_type","site_read_ambiguous_type"]);
 const verifiedSources=new Set([
  "Официальный сайт, проверенный по юридическим данным",
  "Сайт организации, установленный по независимым источникам; содержимое и доступность ещё не проверены",
  "Поиск по названию — подтверждено независимыми реквизитами"]);
 let considered=0,withCorporateMail=0,alternateAvailable=0,actuallyQueued=0;
 const priority=["site_absent","site_unavailable","site_identity_unclear",
  "site_read_no_clear_type","site_read_ambiguous_type"];
 const cases=[];
 for(const c of state.companies){
  if(c.verifiedOrgType||verifiedSources.has(c.siteSource))continue;
  const status=profiler.get(c.id).status;
  if(!unresolved.has(status))continue;
  considered++;
  const linked=state.linkedContacts.get(c.id);
  const emailDomains=mailDomains.ranked([
   ...(c.crmEmails||[]),...(linked?.emails||[]) ]).map(x=>x[0]);
  if(!emailDomains.length)continue;
  withCorporateMail++;
  const activeDomain=String(c.corporateDomain||"").toLowerCase().replace(/^www\./,"");
  // A corporate domain might resolve to a shared holding. The alternative
  // is a candidate only, never proof of the CRM legal entity.
  const currentUrl=String(profiler.get(c.id).url||c.siteCandidate||"");
  let currentHost="";
  try{currentHost=new URL(currentUrl).hostname.toLowerCase().replace(/^www\./,"")}catch{}
  const candidates=emailDomains.filter(d=>d!==activeDomain&&d!==currentHost);
  if(!candidates.length)continue;
  alternateAvailable++;
  cases.push({c,status,candidates});
 }
 cases.sort((a,b)=>priority.indexOf(a.status)-priority.indexOf(b.status));
 for(const {c,candidates} of cases){
  if(actuallyQueued>=80)break;
  for(const domain of candidates.slice(0,3)){
   const count=profiler.enqueue([{...c,siteCandidate:"",corporateDomain:domain,
    siteSource:"Альтернативный домен привязанного контакта"}])||0;
   if(count){actuallyQueued+=count;break}
  }
 }
 if(actuallyQueued){
  console.log(JSON.stringify({component:"topsense-dashboard",event:"alternate-contact-sites-queued",
   count:actuallyQueued,considered,withCorporateMail,alternateAvailable}));
 }else{
  const retried=profiler.retryTransient(state.companies);
  if(retried){
   console.log(JSON.stringify({component:"topsense-dashboard",
    event:"transient-site-retry-batch",count:retried}));
  }else{
   const requisites=require("./company-requisites");
   const nameSearch=require("./name-site-search");
   let innQueued=0,innEligible=0;
   if(requisites.stats().status==="ready"&&nameSearch.stats().remaining===0){
    const candidates=[];
    for(const c of state.companies){
     if(c.siteCandidate||c.corporateDomain||c.verifiedOrgType)continue;
     const legal=requisites.get(c.id);
     if(legal.status!=="inn_recorded")continue;
     const linked=state.linkedContacts.get(c.id);
     candidates.push({...c,crmInn:legal.inn,
      contactEmails:linked?[...linked.emails]:[],
      suppliedSiteCandidate:require("./manual-website-candidates").get(c.id)?.url||""});
    }
    innEligible=candidates.length;
    innQueued=nameSearch.enqueueByInn(candidates);
   }
   if(innQueued)console.log(JSON.stringify({component:"topsense-dashboard",
    event:"inn-site-discovery-started",queued:innQueued,eligible:innEligible}));
   else if(!state.lastResearchExhaustionLoggedAt||
    Date.now()-state.lastResearchExhaustionLoggedAt>30*60*1000){
    state.lastResearchExhaustionLoggedAt=Date.now();
    console.log(JSON.stringify({component:"topsense-dashboard",
     event:"research-queue-exhausted",considered,withCorporateMail,
     alternateAvailable,innEligible,
     next:"new independent source or CRM evidence required"}));
   }
  }
 }
}
function enqueueMissingSiteNameSearch(){
 const requisites=require("./company-requisites");
 // Wait for the read-only legal-requisites snapshot. Without it, name-based
 // discovery cannot corroborate search results by INN and wastes a full pass.
 if(requisites.stats().status!=="ready")return;
 const missing=[];
 for(const c of state.companies){
  if(c.siteCandidate||c.corporateDomain||c.verifiedOrgType)continue;
  const linked=state.linkedContacts.get(c.id);
  const legal=requisites.get(c.id);
  missing.push({...c,crmInn:legal.status==="inn_recorded"?legal.inn:"",
   contactEmails:linked?[...linked.emails]:[],
   suppliedSiteCandidate:require("./manual-website-candidates").get(c.id)?.url||""});
 }
 require("./name-site-search").enqueue(missing);
}
function enqueuePreviousPilotSites(){
 const suggestions=[];
 for(const c of state.companies){
  if(c.siteCandidate||c.corporateDomain)continue;
  const ai=state.pilot.get(c.id);
  // A reviewed AI result is a SITE LEAD, not a verified company identity/type.
  // Revisit its public website for free even when ownership was uncertain.
  if(!ai||!["classified","review"].includes(ai.status))continue;
  const raw=typeof ai.siteCandidate==="object"?(ai.siteCandidate?.url||""):(ai.siteCandidate||ai.website||"");
  const url=website(raw);
  if(!url)continue;
  suggestions.push({...c,siteCandidate:url,siteSource:"Кандидат из прежнего AI-пилота"});
 }
 if(suggestions.length){
  const newQueued=require("./website-profiler").enqueue(suggestions)||0;
  if(newQueued)console.log(JSON.stringify({component:"topsense-dashboard",
   event:"paid-site-leads-queued",candidates:suggestions.length,newQueued}));
 }
}
// Fetch linked CRM contacts read-only. No contacts are sent to public source control.
async function loadLinkedContacts(){
 if(state.contactsLoading||!process.env.BITRIX_WEBHOOK_BASE)return;
 state.contactsLoading=true;
 try{
  const endpoint=new URL("crm.contact.list.json",String(process.env.BITRIX_WEBHOOK_BASE).replace(/\/?$/,"/"));
  async function chunk(start){
   const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({order:{ID:"ASC"},filter:{},select:["ID","NAME","LAST_NAME","COMPANY_ID","EMAIL"],start}),signal:AbortSignal.timeout(18000)});
   const p=await r.json();if(!r.ok||p.error||!Array.isArray(p.result))throw Error(p.error||"CRM contacts read error");return p;
  }
  const first=await chunk(0),all=[...first.result],total=Number(first.total||0),size=Math.max(1,first.result.length);
  if(total>80000)throw Error("Contacts safety limit");
  if(total>size){
   const starts=[];for(let i=size;i<total;i+=size)starts.push(i);
   for(let j=0;j<starts.length;j+=5){
    const group=await Promise.all(starts.slice(j,j+5).map(chunk));
    group.forEach(g=>all.push(...g.result));
   }
  }
  const by=new Map();
  for(const c of all){
   const id=String(c.COMPANY_ID||"");if(!id||id==="0")continue;
   if(!by.has(id))by.set(id,{emails:new Set(),names:[]});
   const target=by.get(id);
   for(const e of Array.isArray(c.EMAIL)?c.EMAIL:[]){const addr=String(e.VALUE||"").trim().toLowerCase();if(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr))target.emails.add(addr)}
   if(target.names.length<20){const name=[c.NAME,c.LAST_NAME].filter(Boolean).join(" ").trim();if(name)target.names.push(name)}
  }
  // Orphan CRM contacts are NOT assigned to a company automatically. Their
  // corporate domains may only act as candidate website clues if the company
  // name occurs in the contact label and multiple contacts agree on the domain.
  function compact(value){
   return String(value||"").toLowerCase().replace(/ё/g,"е")
    .replace(/^(?:ооо|ао|пао|оао|зао|нко|ип)[\\s\\W]+/i,"")
    .replace(/[^а-яa-z0-9]/g,"");
  }
  const eligible=state.companies.filter(c=>!c.siteCandidate&&!c.corporateDomain)
   .map(c=>({company:c,key:compact(c.name)})).filter(c=>c.key.length>=11);
  const proposals=new Map(),orphanContacts=all.filter(c=>!c.COMPANY_ID||String(c.COMPANY_ID)==="0");
  for(const person of orphanContacts){
   const label=compact([person.NAME,person.LAST_NAME].filter(Boolean).join(" "));
   if(label.length<11)continue;
   const validDomains=[...new Set((Array.isArray(person.EMAIL)?person.EMAIL:[])
    .map(e=>domain(e.VALUE||"")).filter(Boolean))];
   if(validDomains.length!==1)continue;
   for(const cand of eligible){
    if(!label.includes(cand.key))continue;
    if(!proposals.has(cand.company.id))proposals.set(cand.company.id,new Map());
    const counts=proposals.get(cand.company.id);
    counts.set(validDomains[0],(counts.get(validDomains[0])||0)+1);
   }
  }
  const websiteCandidates=[];
  for(const cand of eligible){
   const options=proposals.get(cand.company.id);
   if(!options||options.size!==1)continue;
   const [corporateDomain,observations]=[...options.entries()][0];
   if(observations<2)continue;
   websiteCandidates.push({...cand.company,corporateDomain,
    siteSource:"Непривязанные CRM-контакты: совпали название и корпоративный домен"});
  }
  if(websiteCandidates.length)require("./website-profiler").enqueue(websiteCandidates);
  console.log(JSON.stringify({component:"client-segments",event:"unlinked-contact-domain-candidates",
   unlinkedContacts:orphanContacts.length,siteCandidates:websiteCandidates.length}));
  state.linkedContacts=by;state.contactsAt=new Date().toISOString();
  enqueueMissingSiteNameSearch();
  enqueueLinkedContactSites();
  console.log(JSON.stringify({component:"client-segments",event:"linked-contacts-loaded",contacts:all.length,companies:by.size}));
 }catch(e){console.warn(JSON.stringify({component:"client-segments",event:"linked-contacts-error",error:String(e.message||e).slice(0,150)}))}
 finally{state.contactsLoading=false}
}
// Pull the authorized, private model-classification checkpoint from the existing store.
// This creates no OpenAI calls and never writes to the CRM.
async function loadPilot(){
 if(state.pilotLoading)return;
 const endpoint=String(process.env.GOOGLE_SHEET_STORE_URL||"");
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"");
 if(!endpoint||!secret)return;
 state.pilotLoading=true;
 try{
  const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify({action:"load",secret}),signal:AbortSignal.timeout(18000)});
  const d=await r.json();
  if(!r.ok||d.ok===false)throw Error("private AI store read error");
  const entries=Array.isArray(d.rows)?d.rows:[];
  const censusRow=entries.find(x=>x?.key==="meta:topsense-classification-census:v1");
  console.log(JSON.stringify({component:"topsense-dashboard",event:"private-store-load-coverage",
   returnedRows:entries.length,
   hasClassificationCensus:Boolean(censusRow),
   censusPayloadType:typeof censusRow?.payload,
   censusValid:require("./classification-census").valid(censusRow?.payload),
   censusPayloadFields:censusRow?.payload&&typeof censusRow.payload==="object"?Object.keys(censusRow.payload).sort():[],
   oldTypeLedgerRows:entries.filter(x=>String(x?.key||"").startsWith("classification:type:v1:")).length,
   readableTypeLedgerRows:entries.filter(x=>String(x?.key||"").startsWith("site-profile:v1:900000000000")).length,
   siteProfileRows:entries.filter(x=>/^site-profile:v1:[0-9]+$/.test(String(x?.key||""))).length}));
  // Restore confirmed types before replaying completion locks for those types.
  const x=new Map(),versions=new Map();
  for(const e of entries){
    const match=String(e.key||"").match(/^pilot:v([1234]):result:([0-9]+)$/);
    if(!match)continue;
    const item=e.payload||{},id=String(item.companyId||"");
    if(id!==match[2]||item.recordType!=="topsense-pilot-result")continue;
    const version=Number(match[1]);
    if((versions.get(id)||0)>version)continue;
    versions.set(id,version);x.set(id,item);
  }
  const v4=entries.filter(e=>/^pilot:v4:result:/.test(String(e.key||""))).map(e=>e.payload||{});
  const taxonomy=require("./client-taxonomy");
  let addedTypes=0;
  for(const row of v4)if(taxonomy.registerFromPilot(row))addedTypes++;
  if(addedTypes)console.log(JSON.stringify({component:"client-taxonomy",
   event:"new-subtypes-restored",count:addedTypes,total:taxonomy.stats().total}));
  require("./client-finalization").ingest(entries);
  require("./classification-census").ingest(entries);
  require("./classification-ledger").ingest(entries);
  require("./deal-only-name-ledger").ingest(entries);
  require("./purchase-checkpoint").ingest(entries);
  const summary=entries.find(e=>e.key==="pilot:v4:summary")?.payload||{};
  const oldResults=new Set(entries.filter(e=>/^pilot:v[123]:result:/.test(String(e.key||""))).map(e=>String(e.payload?.companyId||"")).filter(Boolean));
  state.paidControl={
   newResults:v4.filter(p=>p.status==="classified"||p.status==="review").length,
   calls:v4.filter(p=>p.tokenUsage).length,
   estimatedUsd:v4.reduce((a,p)=>a+(Number(p.estimatedCostUsd)||0),0),
   limitUsd: Number(summary.approvedLimitUsd)||Number(process.env.TOPSENSE_PAID_CLASSIFICATION_BUDGET_USD)||0,
   previousProcessed:oldResults.size,
   lastRun:summary.updatedAt||null,
   status:summary.status||"not_started"
  };
  state.pilot=x;state.pilotUpdatedAt=new Date().toISOString();
  enqueuePreviousPilotSites();
  console.log(JSON.stringify({component:"topsense-dashboard",event:"ai-results-loaded",count:x.size}));
 }catch(error){
  console.warn(JSON.stringify({component:"topsense-dashboard",event:"ai-results-unavailable",error:String(error.message).slice(0,100)}));
 }finally{state.pilotLoading=false}
}
function commercialFromOrgType(t){
 const x=ORG_TYPES.find(z=>z.name===t);if(!x)return "";
 if(x.family==="Интеграторы"||x.family==="Проектирование")return "Проектные продажи";
 if(x.family==="Подрядчики")return "Подрядчики";
 if(x.family==="Торговля")return "Партнёрские продажи";
 if(x.family==="Сервис")return "Сервис и метрология";
 if(x.family==="Эксплуатация"||x.family==="Отраслевые производства")return "Конечные потребители";
 if(x.family==="Смежные")return "Смежные организации";
 if(x.family==="Производители")return t.includes("газоаналитических")?"Конкуренты":"Проектные продажи";
 return "";
}
function data(known){
 const registry=new Map();
 for(const x of (typeof known==="function"?known():[])){
  if(x&&x.companyId&&["confirmed","rejected"].includes(x.verificationStatus))registry.set(String(x.companyId),x);
 }
 const seeds=analyticSeeds();
 const records=state.companies.map(base=>{ const linked=state.linkedContacts.get(base.id);const c={...base,contactEmails:linked?[...linked.emails]:[],contactNames:linked?linked.names:[],mailEvidence:require("./crm-mail-evidence").get(base.id),saleInfo:require("./crm-sales-audit").get(base.id),nameSearch:require("./name-site-search").get(base.id),dealEvidence:require("./crm-deal-intake").forCompany(base.id)};
  const r=registry.get(c.id);
  const ai=state.pilot.get(c.id);
  const seed=seeds.get(c.id);
  if(seed){
    const checked=seed.status==="confirmed";
    const sub=String(seed.type||"").slice(0,190);
    const dir=String(seed.direction||"");
    return {...c,
      category:sections.includes(dir)?dir:c.category,
      type:checked?sub:"",
      organizationType:sub,
      proposedType:!checked?sub:"",
      verification:checked?"Подтверждено официальным сайтом":"На сверке подразделения / реквизитов",
      siteVerified:checked?String(seed.site||""):"",
      parent: String(seed.parent||""),
      typeSource:"аналитический реестр ТОП-СЕНС",
      aiStatus:ai?String(ai.status||""):"",
      delivery:"Не подтверждена",
      strategy:ai?String(ai.proposedStrategy||"").slice(0,200):""
    };
  }
  if(!r){
    if(!ai)return c;
    const orgType=String(ai.primaryType||"");
    const validType=require("./client-taxonomy").known(orgType)&&ai.status==="classified";
    return {...c,
      category:validType?commercialFromOrgType(orgType)||c.category:c.category,
      type:validType?orgType:"",
      organizationType:validType?orgType:"",
      aiExplanation:String(ai.clientType||"").slice(0,180),
      siteVerified:ai.status==="classified"?String(ai.website||""):"",
      verification:ai.status==="classified"?"AI — требует проверки":String(ai.status||"").slice(0,50),
      aiStatus:String(ai.status||""),
      strategy:String(ai.proposedStrategy||"").slice(0,240),
      evidence:ai.source?[String(ai.source)]:[],
      delivery:"Не подтверждена"
    };
  }
  const type=String(r.contractorType||"").slice(0,160);
  let group=c.category;
  if(r.verificationStatus==="confirmed")group="Подрядчики";
  else if(/завод|комбинат|потребител|эксплуатир|теплоснабж/i.test(type))group="Конечные потребители";
  return {...c,category:group,type,organizationType:type,verificationStatus:r.verificationStatus,siteVerified:String(r.website||""),strategy:String(r.strategicReason||"").slice(0,260),verification:"Проверено по реестру подрядчиков"};
 });
 const finalization=require("./client-finalization");
 const requisites=require("./company-requisites"),finances=require("./financial-2025");
 const ledger=require("./classification-ledger");
 const typedRecords=require("./client-type-inference").apply(records)
  .map(c=>ledger.apply(c))
  .map(c=>finalization.apply({...c,
   finance2025:finances.withRequisite(c.finance2025,requisites.get(c.id)),
   staffEvidence:require("./staff-evidence").resolve(c,require("./website-profiler").get(c.id))
  }));
 // Persist per source CRM company ID; never use a volatile virtual duplicate
 // group as a durable identity. Ignore transient pre-restoration observations.
 if(state.pilotUpdatedAt&&require("./website-profiler").stats().restorationComplete)
  ledger.offerMany(typedRecords);
 const virtual=require("./crm-duplicates").consolidate(typedRecords);
 const baseAnalyticCompanies=virtual.companies.map(c=>({...c,
  name:require("./company-name-format").display(c.name).name,
  relationshipPotential:require("./client-relationship-potential").score(c)}));
 const dealOnlyClients=require("./deal-only-client-registry").view(baseAnalyticCompanies);
 const allAnalyticCompanies=require("./holding-network").decorate([...baseAnalyticCompanies,...dealOnlyClients]);
 const holdingGroups=require("./holding-network").view(allAnalyticCompanies);
 // A virtual duplicate is never treated as independently proven identity.
 const duplicateIds=new Set([...virtual.duplicates,...virtual.review]
  .flatMap(group=>(group.members||group.mergedCrmCards||[]).map(m=>String(m.id))));
 const salesStatus=require("./crm-sales-audit").stats().status;
 for(const c of typedRecords){
  if(finalization.isComplete(c.id))continue;
  finalization.queue(c,{contactsAt:state.contactsAt,salesStatus,duplicateIds});
 }

 // Read-only reconciliation: explain why a saved AI result did not reach the final card.
 const byCrmId=new Map(typedRecords.map(c=>[String(c.id),c]));
 const aiReconciliation={saved:state.pilot.size,notInCurrentCrm:0,classified:0,review:0,
  otherStatus:0,classifiedWithKnownType:0,classifiedMissingValidType:0,
  classifiedTypedInFinal:0,classifiedMissingInFinal:0,reviewWithProposedType:0,
  reviewWithoutProposedType:0,reviewWithContactDomain:0,reviewWithCompanyDomain:0,
  reviewWithWebsiteCandidate:0,finalTypeOverridden:0};
 for(const [id,ai] of state.pilot){
  const c=byCrmId.get(String(id));
  if(!c){aiReconciliation.notInCurrentCrm++;continue}
  if(ai.status==="classified"){
   aiReconciliation.classified++;
   const validAiType=require("./client-taxonomy").known(String(ai.primaryType||""));
   if(validAiType)aiReconciliation.classifiedWithKnownType++;
   else aiReconciliation.classifiedMissingValidType++;
   if(require("./client-taxonomy").known(String(c.organizationType||"")))aiReconciliation.classifiedTypedInFinal++;
   else aiReconciliation.classifiedMissingInFinal++;
   if(validAiType&&require("./client-taxonomy").known(String(c.organizationType||""))&&c.organizationType!==ai.primaryType)
    aiReconciliation.finalTypeOverridden++;
  }else if(ai.status==="review"){
   aiReconciliation.review++;
   const linked=state.linkedContacts.get(String(id));
   if(linked&&[...linked.emails].some(email=>Boolean(domain(email))))aiReconciliation.reviewWithContactDomain++;
   if(c.corporateDomain)aiReconciliation.reviewWithCompanyDomain++;
   if(c.siteCandidate||c.siteVerified||c.siteProfileUrl)aiReconciliation.reviewWithWebsiteCandidate++;
   if(ai.primaryType&&ai.primaryType!=="Не определён")aiReconciliation.reviewWithProposedType++;
   else aiReconciliation.reviewWithoutProposedType++;
  }else aiReconciliation.otherStatus++;
 }
 const counts=Object.fromEntries(sections.map(v=>[v,0]));
 virtual.companies.forEach(c=>counts[c.category]=(counts[c.category]||0)+1);
 const format=require("./company-name-format").display;
 const siteStatus=require("./website-profiler").stats();
 const completedCount=finalization.stats().completed;
 const classificationCensusReady=state.status==="ready"&&Boolean(state.pilotUpdatedAt)&&Boolean(state.contactsAt)&&
  siteStatus.restorationComplete===true&&siteStatus.queued===0&&siteStatus.active===0&&
  siteStatus.processed+completedCount>=state.companies.length-5;
 const currentTyped=virtual.companies.filter(c=>require("./client-taxonomy").known(c.organizationType)).length;
 const classificationDisplay=require("./classification-census").display(virtual.stats.customerCardCount,currentTyped,classificationCensusReady,state.companies.length);
 return {ok:true,status:state.status,error:state.error,updatedAt:state.updatedAt,
  classificationDisplay,classificationCensusReady,classificationCensusStore:require("./classification-census").stats(),
  classificationLedger:ledger.stats(),
  total:allAnalyticCompanies.length,
  dealOnlyClientCount:dealOnlyClients.length,
  dealOnlyClients,holdings:holdingGroups,
  dealOnlyRegistry:require("./deal-only-client-registry").stats(),
  dealOnlyNames:require("./deal-only-name-ledger").stats(),
  unlinkedDiscovery:require("./crm-unlinked-discovery").stats(),
  crmCardTotal:virtual.stats.rawCompanyCount,
  excludedCompanyCount:state.excludedCompanies.length,
  excludedCompanies:state.excludedCompanies.map(c=>({...c,name:format(c.name).name})),
  sourceCrmCount:state.rawCrmTotal,
  virtualCustomerTotal:virtual.stats.customerCardCount,
  financial2025Coverage:virtual.companies.reduce((a,c)=>{const k=c.finance2025?.status||"no_data";a[k]=(a[k]||0)+1;return a},{}),
  staffCoverage:virtual.companies.reduce((a,c)=>{const e=c.staffEvidence||{},key=e.count>0?(e.year===2025?"verified_2025":"other_or_unspecified_year"):"no_data";a[key]=(a[key]||0)+1;return a},{}),
  requisites:requisites.stats(),
  confirmed:virtual.companies.filter(x=>x.type&&!String(x.verification||"").startsWith("AI —")).length,
  relatedGroups:virtual.stats.groupedCount,
  duplicateStats:virtual.stats,
  duplicateGroups:virtual.duplicates,
  duplicateReview:virtual.review,
  analyticTyped:seeds.size,analyticConfirmed:[...seeds.values()].filter(x=>x.status==="confirmed").length,
  aiResults:state.pilot.size,aiCalls:[...state.pilot.values()].filter(x=>x.tokenUsage).length,
  aiNoSite:[...state.pilot.values()].filter(x=>x.status==="site_unverified").length,
  aiLastChecked:state.pilotUpdatedAt,paidClassification:state.paidControl,contactsAt:state.contactsAt,counts,organizationTypes:ORG_TYPES,
  organizationTypeCount:ORG_TYPES.length,taxonomy:require("./client-taxonomy").stats(),
  siteCrawl:siteStatus,
  researchCompletion:finalization.stats(),
  incomingLeads:require("./crm-lead-inbox").view(virtual.companies),
  mailAudit:require("./crm-mail-evidence").stats(),
  salesAudit:require("./crm-sales-audit").stats(),
  relationshipPotential:require("./client-relationship-potential").stats(),
  nameSiteSearch:require("./name-site-search").stats(),
  dealIntake:require("./crm-deal-intake").stats(),
  companies:allAnalyticCompanies
 };
}
function route(req,res,pathname,known){
 if(!/^\/(contractors|dashboard|intel|company-intel)(\/|$)/.test(pathname))return false;
 if(pathname==="/intel/login"&&req.method==="POST"){
   let body="",length=0;
   req.on("data",chunk=>{
     length+=chunk.length;
     if(length>4096){req.destroy();return}
     body+=chunk.toString("utf8");
   });
   req.on("end",()=>{
     const p=new URLSearchParams(body),username=p.get("username")||"",password=p.get("password")||"";
     const key=sessionKey();
     if(key.length>=16&&equals(username,"topsense")&&equals(password,key)){
       const ts=String(Date.now()),sig=crypto.createHmac("sha256",key).update(ts).digest("hex");
       res.writeHead(303,{"location":"/contractors","set-cookie":"ts_crm_auth="+ts+"."+sig+"; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax","cache-control":"no-store"});
       res.end();return;
     }
     write(res,401,loginPage(true),"text/html; charset=utf-8");
   });
   return true;
 }
 if(!authorised(req)){
   if(req.method==="GET"&&!pathname.endsWith("/api")&&!pathname.endsWith("/status")){
     write(res,200,loginPage(false),"text/html; charset=utf-8");return true;
   }
   write(res,401,{error:"Авторизация необходима"});return true;
 }
 if(req.method!=="GET"){write(res,405,{error:"Read-only"});return true}
 if(!state.refreshing&&(!state.updatedAt||Date.now()-Date.parse(state.updatedAt)>30*60*1000))refresh().catch(()=>{});
 if(!state.pilotLoading&&(!state.pilotUpdatedAt||Date.now()-Date.parse(state.pilotUpdatedAt)>65*1000))loadPilot().catch(()=>{});
 if(!state.contactsLoading&&(!state.contactsAt||Date.now()-Date.parse(state.contactsAt)>60*60*1000))loadLinkedContacts().catch(()=>{});
 if(["/intel/api","/dashboard/status","/contractors/status","/dashboard/contractors/status"].includes(pathname)){write(res,200,data(known));return true}
 if(pathname==="/contractors/holdings"){write(res,200,require("./client-holdings").page(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/deal-only"){const qs=new URL(req.url,"http://localhost").searchParams;write(res,200,require("./client-deal-only").page(data(known),{page:qs.get("page"),kind:qs.get("kind")}),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/leads"){const qs=new URL(req.url,"http://localhost").searchParams;write(res,200,require("./client-leads").html(data(known),{page:qs.get("page"),kind:qs.get("kind"),link:qs.get("link")}),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/quality"){write(res,200,require("./client-quality").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/excluded"){write(res,200,require("./client-excluded").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/duplicates.csv"){write(res,200,require("./client-duplicates").csv(data(known)),"text/csv; charset=utf-8",{"content-disposition":"attachment; filename=TOPSENSE_CRM_duplicates.csv"});return true}
 if(pathname==="/contractors/duplicates"){write(res,200,require("./client-duplicates").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/list"){write(res,200,require("./client-segments").html(data(known)),"text/html; charset=utf-8");return true}
 if(["/contractors","/dashboard","/dashboard/contractors","/company-intel","/intel"].includes(pathname)){
  const query=new URL(req.url,"http://localhost").searchParams;
  const section=query.get("section")||"Обзор",type=query.get("type")||"",page=query.get("page")||"1",purchase=query.get("purchase")||"";
  write(res,200,require("./client-overview").render(data(known),section,type,page,purchase),"text/html; charset=utf-8");return true;
 }
 write(res,404,{error:"Not found"});return true;
}
// Log only aggregate classification coverage; never log customer names, URLs or email.
// An empty crawl queue does not prove every company has a subtype.
function coverageLog(){
 if(!state.companies.length)return;
 try{
  const snap=data(()=>[]);
  const companyList=snap.companies||[];
  const typed=companyList.filter(x=>require("./client-taxonomy").known(x.organizationType));
  require("./classification-census").consider(companyList.length,typed.length,state.companies.length,snap.classificationCensusReady);
  const distinctTypes=new Set(typed.map(x=>x.organizationType));
  // Aggregate diagnostics: a missing type is not the same as a missing site.
  const untypedCompanies=companyList.filter(x=>!require("./client-taxonomy").known(x.organizationType));
  const domainCoverage={untyped:untypedCompanies.length,withCompanyMail:0,
   withContactMail:0,withAnyCorporateMail:0,siteAbsentWithCorporateMail:0,
   unavailableSiteWithCorporateMail:0};
  for(const c of untypedCompanies){
   const companyHas=mailDomains.extract(c.crmEmails||[]).length>0;
   const contactHas=mailDomains.extract(c.contactEmails||[]).length>0;
   if(companyHas)domainCoverage.withCompanyMail++;
   if(contactHas)domainCoverage.withContactMail++;
   if(!companyHas&&!contactHas)continue;
   domainCoverage.withAnyCorporateMail++;
   if(c.siteStatus==="site_absent")domainCoverage.siteAbsentWithCorporateMail++;
   if(c.siteStatus==="site_unavailable")domainCoverage.unavailableSiteWithCorporateMail++;
  }
  const sourceCounts={};
  for(const c of typed){
   const source=String(c.segmentSource||"Other").slice(0,90);
   sourceCounts[source]=(sourceCounts[source]||0)+1;
  }
  const sampleCases=[[276,1342],[974,2024],[1784,2110]];
  const sampleMatches=sampleCases.map((pair,index)=>({
   check:index+1,
   grouped:companyList.some(c=>pair.every(id=>(c.crmIdList||[c.id]).map(Number).includes(id))),
   review:(snap.duplicateReview||[]).some(g=>pair.every(id=>g.members.some(m=>Number(m.id)===id)))
  }));
  console.log(JSON.stringify({component:"crm-duplicates",event:"regression-integrity",checks:sampleMatches,stats:snap.duplicateStats}));
  console.log(JSON.stringify({component:"topsense-dashboard",event:"classification-coverage",
   customers:companyList.length,crmCards:state.companies.length,
   typed:typed.length,untyped:companyList.length-typed.length,coveredTypes:distinctTypes.size,
   censusReady:snap.classificationCensusReady,censusDisplay:snap.classificationDisplay,
   ledger:snap.classificationLedger,
   siteCrawl:require("./website-profiler").stats(),
   nameSearch:require("./name-site-search").stats(),
   domainCoverage,classificationSources:sourceCounts}));
 }catch(e){console.warn(JSON.stringify({component:"topsense-dashboard",event:"coverage-unavailable",reason:String(e.message||e).slice(0,100)}))}
}
setTimeout(coverageLog,76000);
setInterval(coverageLog,240000);
// Preload the read-only snapshot when the dashboard module is first requested.
setTimeout(() => refresh().catch(() => {}), 1100);
setTimeout(() => loadPilot().catch(() => {}), 1500);
setTimeout(() => loadLinkedContacts().catch(() => {}), 2500);
setTimeout(() => require("./crm-lead-inbox").refresh().catch(()=>{}), 800);
setTimeout(() => require("./company-requisites").refresh().then(()=>enqueueMissingSiteNameSearch()).catch(()=>{}), 28000);
// Keep the CRM company/contact snapshot fresh without repeating paid AI research.
// Site profiler fingerprints prevent unchanged completed site evidence being crawled again.
setInterval(() => {
 refresh().catch(()=>{});
 loadLinkedContacts().catch(()=>{});
}, 2*60*60*1000);
// Explore an alternate linked-contact domain only after a primary site failed.
// Bounded retries are conditional on temporary transport failures and cooldown.
setTimeout(resumeUnresolvedCompanySites,10*60*1000);
setInterval(resumeUnresolvedCompanySites,5*60*1000);
setInterval(() => require("./crm-lead-inbox").refresh().catch(()=>{}), 10*60*1000);
setInterval(() => require("./company-requisites").refresh().then(()=>enqueueMissingSiteNameSearch()).catch(()=>{}), 24*60*60*1000);
module.exports={route,refresh,data};

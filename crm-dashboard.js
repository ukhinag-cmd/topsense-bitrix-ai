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
const freeDomains=new Set(["mail.ru","bk.ru","list.ru","inbox.ru","gmail.com","yandex.ru","ya.ru","yahoo.com","rambler.ru","outlook.com","hotmail.com","icloud.com","topsense.su","detector-gaza.ru"]);
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
   '<nav id="nav"></nav><div class="subbrand" style="margin-top:24px">45 типов организаций · полный справочник</div><div style="padding-bottom:20px">'+groupHtml+'</div>');
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
function domain(x){const m=value(x).match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);const d=m?m[1].toLowerCase():"";return d&&!freeDomains.has(d)?d:""}
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
 ["1134",{url:"https://gazoanalit.ru/",name:"НПП ГАЗОАНАЛИТ",primaryType:"Производитель газоаналитических приборов",source:"Публичный сайт gazoanalit.ru: ООО НПП ГазоАналит, производство систем газового анализа; в CRM указано то же полное юридическое наименование"}]
]);
function company(x){const id=String(x.ID||"");const reviewed=REVIEWED_PUBLIC_SITES.get(id);return {id,name:String(x.TITLE||""),category:category(x.TITLE),siteCandidate:reviewed?.url||website(x.WEB),siteSource:reviewed?"Официальный сайт, проверенный по юридическим данным":(website(x.WEB)?"Сайт из CRM":""),verifiedOrgType:reviewed?.primaryType||"",verifiedOrgEvidence:reviewed?.source||"",corporateDomain:domain(x.EMAIL),crmEmails:(Array.isArray(x.EMAIL)?x.EMAIL.map(e=>String(e.VALUE||e||"")):[]).filter(Boolean),crmPhones:(Array.isArray(x.PHONE)?x.PHONE.map(e=>String(e.VALUE||e||"")):[]).filter(Boolean),crmCity:String(x.ADDRESS_CITY||""),crmRegion:String(x.ADDRESS_REGION||""),finance2025:require("./financial-2025").fromCompany(x),crmUrl:"https://topsense.bitrix24.ru/crm/company/details/"+encodeURIComponent(id)+"/",modified:String(x.DATE_MODIFY||""),responsibleId:String(x.ASSIGNED_BY_ID||""),delivery:"Не проверено"}}
async function page(start){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Bitrix API not configured");
 const endpoint=new URL("crm.company.list.json",base.endsWith("/")?base:base+"/");
 for(let attempt=0;attempt<2;attempt++){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({order:{ID:"ASC"},filter:{},select:["ID","TITLE","WEB","EMAIL","PHONE","ADDRESS_CITY","ADDRESS_REGION","UF_CRM_AI_REVENUE","UF_CRM_AI_REVENUE_YEAR","UF_CRM_AI_INN","UF_CRM_AI_FIN_SOURCE","DATE_MODIFY","ASSIGNED_BY_ID"],start}),signal:AbortSignal.timeout(18000)});
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
 for(const c of state.companies){
  if(c.siteCandidate||c.corporateDomain)continue;
  const linked=state.linkedContacts.get(c.id);
  if(!linked||!linked.emails.size)continue;
  const domains=[...new Set([...linked.emails].map(domain).filter(Boolean))];
  if(domains.length!==1)continue;
  suggested.push({...c,corporateDomain:domains[0],siteSource:"Домен привязанного контакта"});
 }
 if(suggested.length)require("./website-profiler").enqueue(suggested);
}
function enqueueMissingSiteNameSearch(){
 const missing=[];
 for(const c of state.companies){
  if(c.siteCandidate||c.corporateDomain||c.verifiedOrgType)continue;
  const linked=state.linkedContacts.get(c.id);
  missing.push({...c,contactEmails:linked?[...linked.emails]:[]});
 }
 require("./name-site-search").enqueue(missing);
}
function enqueuePreviousPilotSites(){
 const suggestions=[];
 for(const c of state.companies){
  if(c.siteCandidate||c.corporateDomain)continue;
  const ai=state.pilot.get(c.id);
  if(!ai||ai.status!=="classified"||!["verified","confirmed","official","owned"].includes(String(ai.siteOwnership||"").toLowerCase()))continue;
  const raw=typeof ai.siteCandidate==="object"?(ai.siteCandidate?.url||""):(ai.siteCandidate||ai.website||"");
  const url=website(raw);
  if(!url)continue;
  suggestions.push({...c,siteCandidate:url,siteSource:"Кандидат из прежнего AI-пилота"});
 }
 if(suggestions.length)require("./website-profiler").enqueue(suggestions);
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
  const x=new Map();
  for(const e of entries){
    if(!/^pilot:v[1234]:result:/.test(String(e.key||"")))continue;
    const item=e.payload||{};
    if(item.companyId&&item.recordType==="topsense-pilot-result")x.set(String(item.companyId),item);
  }
  const v4=entries.filter(e=>/^pilot:v4:result:/.test(String(e.key||""))).map(e=>e.payload||{});
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
 if(x.family==="Эксплуатация")return "Конечные потребители";
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
 const records=state.companies.map(base=>{ const linked=state.linkedContacts.get(base.id);const c={...base,contactEmails:linked?[...linked.emails]:[],contactNames:linked?linked.names:[],mailEvidence:require("./crm-mail-evidence").get(base.id),saleInfo:require("./crm-sales-audit").get(base.id),nameSearch:require("./name-site-search").get(base.id)};
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
    const validType=ORG_TYPES.some(x=>x.name===orgType)&&ai.status==="classified";
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
 const typedRecords=require("./client-type-inference").apply(records);
 const virtual=require("./crm-duplicates").consolidate(typedRecords);

 const counts=Object.fromEntries(sections.map(v=>[v,0]));
 virtual.companies.forEach(c=>counts[c.category]=(counts[c.category]||0)+1);
 const format=require("./company-name-format").display;
 return {ok:true,status:state.status,error:state.error,updatedAt:state.updatedAt,
  total:virtual.stats.customerCardCount,
  crmCardTotal:virtual.stats.rawCompanyCount,
  excludedCompanyCount:state.excludedCompanies.length,
  excludedCompanies:state.excludedCompanies.map(c=>({...c,name:format(c.name).name})),
  sourceCrmCount:state.rawCrmTotal,
  virtualCustomerTotal:virtual.stats.customerCardCount,
  financial2025Coverage:virtual.companies.reduce((a,c)=>{const k=c.finance2025?.status||"no_data";a[k]=(a[k]||0)+1;return a},{}),
  confirmed:virtual.companies.filter(x=>x.type&&!String(x.verification||"").startsWith("AI —")).length,
  relatedGroups:virtual.stats.groupedCount,
  duplicateStats:virtual.stats,
  duplicateGroups:virtual.duplicates,
  duplicateReview:virtual.review,
  analyticTyped:seeds.size,analyticConfirmed:[...seeds.values()].filter(x=>x.status==="confirmed").length,
  aiResults:state.pilot.size,aiCalls:[...state.pilot.values()].filter(x=>x.tokenUsage).length,
  aiNoSite:[...state.pilot.values()].filter(x=>x.status==="site_unverified").length,
  aiLastChecked:state.pilotUpdatedAt,paidClassification:state.paidControl,contactsAt:state.contactsAt,counts,organizationTypes:ORG_TYPES,
  organizationTypeCount:ORG_TYPES.length,
  siteCrawl:require("./website-profiler").stats(),
  mailAudit:require("./crm-mail-evidence").stats(),
  salesAudit:require("./crm-sales-audit").stats(),
  nameSiteSearch:require("./name-site-search").stats(),
  companies:virtual.companies.map(c=>({...c,name:format(c.name).name}))
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
 if(pathname==="/contractors/quality"){write(res,200,require("./client-quality").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/excluded"){write(res,200,require("./client-excluded").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/duplicates.csv"){write(res,200,require("./client-duplicates").csv(data(known)),"text/csv; charset=utf-8",{"content-disposition":"attachment; filename=TOPSENSE_CRM_duplicates.csv"});return true}
 if(pathname==="/contractors/duplicates"){write(res,200,require("./client-duplicates").html(data(known)),"text/html; charset=utf-8");return true}
 if(pathname==="/contractors/list"){write(res,200,require("./client-segments").html(data(known)),"text/html; charset=utf-8");return true}
 if(["/contractors","/dashboard","/dashboard/contractors","/company-intel","/intel"].includes(pathname)){
  const section=new URL(req.url,"http://localhost").searchParams.get("section")||"Обзор";
  write(res,200,require("./client-overview").render(data(known),section),"text/html; charset=utf-8");return true;
 }
 write(res,404,{error:"Not found"});return true;
}
// Log only aggregate classification coverage; never log customer names, URLs or email.
// A crawler queue being empty does not mean all 45 client types were assigned.
function coverageLog(){
 if(!state.companies.length)return;
 try{
  const snap=data(()=>[]);
  const companyList=snap.companies||[];
  const typed=companyList.filter(x=>ORG_TYPES.some(t=>t.name===x.organizationType));
  const distinctTypes=new Set(typed.map(x=>x.organizationType));
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
   siteCrawl:require("./website-profiler").stats(),
   nameSearch:require("./name-site-search").stats(),
   classificationSources:sourceCounts}));
 }catch(e){console.warn(JSON.stringify({component:"topsense-dashboard",event:"coverage-unavailable",reason:String(e.message||e).slice(0,100)}))}
}
setTimeout(coverageLog,76000);
setInterval(coverageLog,240000);
// Preload the read-only snapshot when the dashboard module is first requested.
setTimeout(() => refresh().catch(() => {}), 1100);
setTimeout(() => loadPilot().catch(() => {}), 1500);
setTimeout(() => loadLinkedContacts().catch(() => {}), 2500);
module.exports={route,refresh,data};

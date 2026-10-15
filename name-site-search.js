"use strict";
// Read-only website discovery for company records with no website/domain.
// A search result is NOT identity proof. Only name + independent phone/city
// corroboration is allowed to promote a URL to an official website.
const queue=[],pending=new Set(),profiles=new Map(),innTried=new Set();
const completion=require("./client-finalization");
let busy=false,attempted=0,confirmed=0,review=0,unavailable=0,innAttempted=0,innConfirmed=0;
const skipDomains=new Set(["bing.com","google.com","yandex.ru","2gis.ru","rusprofile.ru","checko.ru","sbis.ru","saby.ru","companies.rbc.ru","list-org.com","orgpage.ru","avito.ru","hh.ru","vk.com","youtube.com","facebook.com","instagram.com","spravker.ru","spark-interfax.ru"]);
const sleep=n=>new Promise(r=>setTimeout(r,n));
const normalized=s=>String(s||"").toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"");
function cleanName(raw){
 return String(raw||"").trim().replace(/^(?:\s*["«»']*)?(?:ООО|ОАО|ПАО|АО|ЗАО|НАО|ИП)\s*["«»']?\s*/i,"")
 .replace(/\s*[,.\-]?\s*(?:ООО|ОАО|ПАО|АО|ЗАО|НАО|ИП)$/i,"").replace(/["«»]/g,"").trim();
}
function eligible(c){
 const name=normalized(cleanName(c.name));
 const uninformative=/^(?:безназвания|неизвестно|безимени|неопределено|физлицо|частноелицо|тестоваякомпания|нетназвания)$/.test(name);
 const inn=String(c.crmInn||"").replace(/\D/g,"");
 const phone=(c.crmPhones||[]).some(p=>String(p||"").replace(/\D/g,"").length>=10);
 // Short identifiers (e.g. "ИС-16") are admissible when CRM has independent
 // identifiers for website verification. A short name alone is insufficient.
 if(uninformative||name.length<4||(name.length<9&&!/^(?:\d{10}|\d{12})$/.test(inn)&&!phone))return false;
 if(!c.dealOnlyResearch&&(c.siteCandidate||c.corporateDomain||c.verifiedOrgType))return false;
 const free=/^(?:gmail\.com|mail\.ru|list\.ru|bk\.ru|yandex\.ru|ya\.ru|outlook\.com|rambler\.ru|hotmail\.com|icloud\.com|topsense\.su|detector-gaza\.ru)$/i;
 if(c.dealOnlyResearch)return true;
 return ![...(c.crmEmails||[]),...(c.contactEmails||[])].some(e=>{
  const d=String(e||"").split("@");return d.length>1&&d[d.length-1].includes(".")&&!free.test(d[d.length-1]);
 });
}
function legalOrPhoneMatch(c,site){
 const all=Array.isArray(site)?site:[site];
 const content=String(all.flatMap(p=>[p.meta.title,p.meta.description,...(p.meta.headings||[]),p.meta.body||"",p.meta.identityText||""]).join(" ")).toLowerCase().replace(/ё/g,"е");
 const digits=s=>String(s||"").replace(/\D/g,"");
 const originalPhones=(c.crmPhones||[]).map(digits).filter(x=>x.length>=10).map(x=>x.slice(-10));
 const shownPhones=[...content.matchAll(/(?:\+7|7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/g)].map(x=>digits(x[0]).slice(-10));
 const phone=originalPhones.length>0&&originalPhones.some(x=>shownPhones.includes(x));
 const city=String(c.crmCity||"").trim().toLowerCase();
 const region=String(c.crmRegion||"").trim().toLowerCase();
 const location=(city.length>=5&&content.includes(city))||(region.length>=6&&content.includes(region));
 const legal=String(c.crmInn||"").replace(/\D/g,"");
 const legalMatch=legal.length>=10&&content.includes(legal);
 const websiteEmails=new Set([...content.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(m=>m[0]));
 const crmEmails=[...(c.crmEmails||[]),...(c.contactEmails||[])]
  .map(e=>String(e||"").toLowerCase().trim()).filter(e=>e.includes("@"));
 // Exact matching of a free/public mailbox is useful evidence even though
 // its DOMAIN is not a company identifier.
 const email=crmEmails.some(e=>websiteEmails.has(e));
 const normalizedAddress=String(c.crmAddress||"").toLowerCase().replace(/ё/g,"е")
  .replace(/[^а-яa-z0-9]+/g," ").trim().replace(/\s+/g," ");
 const normalizedPage=content.replace(/[^а-яa-z0-9]+/g," ").replace(/\s+/g," ");
 const address=normalizedAddress.length>=13&&normalizedPage.includes(normalizedAddress);
 const matched=phone||legalMatch||email||address;
 const proof=[legalMatch?"ИНН":"",phone?"телефон":"",email?"e-mail":"",address?"адрес":""]
  .filter(Boolean).join(", ");
 return {matched,phoneMatch:phone,innMatch:legalMatch,emailMatch:email,
  addressMatch:address,proof:proof?"Совпали: "+proof:"Нет независимых совпадений",
  locationCorroboration:location};
}
function domainAllowed(raw){
 try{
  const u=new URL(raw);
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.port)return null;
  const host=u.hostname.toLowerCase().replace(/^www\./,"");
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)||skipDomains.has(host)||[...skipDomains].some(d=>host.endsWith("."+d)))return null;
  return u.origin;
 }catch{return null}
}
function xml(x){return String(x||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)||32))}
async function search(name,inn=""){
 const u=new URL("https://www.bing.com/search");
 u.searchParams.set("format","rss");
 // Secondary search uses a public legal identifier rather than another
 // name-only query. URL ownership is independently checked before acceptance.
 u.searchParams.set("q",inn?('"'+name+'" "'+inn+'" официальный сайт'):('"'+name+'" официальный сайт'));
 u.searchParams.set("setlang","ru");
 const r=await fetch(u,{method:"GET",redirect:"manual",headers:{"accept":"application/rss+xml,application/xml","user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(14000)});
 if(!r.ok)throw Error("Search HTTP "+r.status);
 const text=(await r.text()).slice(0,175000);
 if(!/<item>/i.test(text)&&!/<rss/i.test(text))throw Error("RSS search unavailable");
 const unique=new Set(),items=[];
 for(const m of text.matchAll(/<item>([\s\S]*?)<\/item>/gi)){
  const row=m[1],raw=xml((row.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]||"").trim(),url=domainAllowed(raw);
  if(!url||unique.has(url))continue;
  unique.add(url);
  items.push({url,title:xml((row.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||"").replace(/<[^>]*>/g," ").slice(0,140)});
  if(items.length>=6)break;
 }
 return items;
}
function legalNameOnOwnSite(c,pages){
 const printed=require("./company-name-format").display(c.name);
 const form=String(printed.opf||"").toUpperCase();
 if(!["ООО","АО","ПАО","ОАО","ЗАО","НАО"].includes(form))return false;
 const full=cleanName(c.name).trim().replace(/ё/gi,"е");
 if(normalized(full).length<12)return false;
 const escaped=full.replace(/[-\/\\^$*+?.()|[\]{}]/g,"\\$&")
  .replace(/[\s\-–—]+/g,"[\\s\\-–—]+");
 const re=new RegExp("(?:^|[^а-яa-z])"+form+"\\s*[«\\\"“]?\\s*"+escaped+"(?=$|[^а-яa-z0-9])","iu");
 return (pages||[]).some(p=>{
  // Titles and the organization's own headings are stronger than a listing
  // of customers or partners elsewhere on the site.
  const self=[p.meta?.title,...(p.meta?.headings||[])]
   .filter(Boolean).join(" ").replace(/ё/gi,"е");
  if(re.test(self))return true;
  // On the site's contact / requisites page, require a legal-details cue.
  const ownText=String(p.meta?.identityText||"").slice(0,7000).replace(/ё/gi,"е");
  const m=re.exec(ownText);
  if(!m)return false;
  const context=ownText.slice(Math.max(0,m.index-140),m.index+m[0].length+130);
  const onIdentityPage=/(?:контакт|contact|rekvizit|requisite|реквизит|юридич|o-kompanii|about)/iu
   .test(String(p.pageUrl||""));
  return onIdentityPage&&/(?:реквизит|юридич|правообладат|полное\s+наименовани|©)/iu.test(context);
 });
}
async function inspect(c,hit){
 const fetchSite=require("./website-profiler").fetchPage;
 const site=await require("./website-profiler").fetchCorporateHome(hit.url);
 const pages=[site];
 const relevant=(site.links||[]).filter(u=>["contact","kontakty","реквизит","rekvizit","requisit","about","o-kompanii","контакт"].some(k=>u.toLowerCase().includes(k))).slice(0,3);
 for(const url of relevant){
  try{const p=await fetchSite(url);if(p.url===site.url)pages.push(p)}catch{}
 }
 const name=normalized(cleanName(c.name));
 const siteText=pages.flatMap(p=>[p.meta.title,p.meta.description,...(p.meta.headings||[]),p.meta.body||"",p.meta.identityText||""]).join(" ");
 const siteNormalized=normalized(siteText);
 const proof=legalOrPhoneMatch(c,pages);
 // The legal INN is a unique identifier. For short abbreviations also allow
 // a precise phone match together with the company name on the site.
 const nameMatch=name.length>=4&&siteNormalized.includes(name);
 if(!nameMatch&&!proof.innMatch)
  return {url:site.url,title:hit.title,status:"other_company",
   note:"Не совпали название и ИНН; телефон без названия недостаточен"};
 const preliminary=Boolean(nameMatch&&!proof.matched&&legalNameOnOwnSite(c,pages));
 return {url:site.url,title:hit.title,status:proof.matched?"confirmed":
   preliminary?"candidate_company_site":"needs_review",
  note:proof.matched?proof.proof:preliminary?
   "На сайте указаны совпадающие полное название и ОПФ. Принадлежность юрлицу по ИНН/телефону не подтверждена.":
   "Совпадает название, но нет независимого подтверждения принадлежности сайта"};
}
async function scan(c,mode="name"){
 // A domain from incoming correspondence, a user-supplied link or a
 // signature is only a site CANDIDATE. Inspect each independently and
 // confirm name plus exact independent identity evidence.
 let supplied=null;
 const hints=[...new Set([c.suppliedSiteCandidate,...(c.suppliedSiteCandidates||[])].filter(Boolean))].slice(0,4);
 const inspected=new Set();
 for(const hint of hints){
  try{
   const candidate=domainAllowed(hint);
   if(!candidate||inspected.has(candidate))continue;
   inspected.add(candidate);
   const result=await inspect(c,{url:candidate,title:"Сайт-кандидат из переписки"});
   if(!supplied||result.status==="needs_review")supplied=result;
   if(result.status==="confirmed"){
    confirmed++;
    require("./website-profiler").enqueue([{...c,siteCandidate:result.url,
     siteSource:"Поиск по названию — подтверждено независимыми реквизитами"}]);
    return {status:"confirmed",site:result.url,candidates:[result],
     source:"Домен письма или сайт-кандидат, сверенный по реквизитам",note:result.note};
   }
  }catch{ /* Continue other leads; failures must not mask other sites. */ }
 }
 let hits;
 try{
  const name=cleanName(c.name),inn=String(c.crmInn||"");
  hits=await search(name,mode==="inn"?inn:c.dealOnlyResearch&&inn?inn:"");
  // For hard-to-identify clients, don't stop at one search phrase:
  // the legal INN may be missing from search snippets even when the actual
  // site is relevant. The second search varies the evidence, not the entity.
  if(c.dealOnlyResearch&&inn){
   const byName=await search(name,"").catch(()=>[]);
   const known=new Set(hits.map(x=>x.url));
   for(const h of byName)if(!known.has(h.url)){hits.push(h);known.add(h.url)}
  }
 }
 catch(e){unavailable++;return {status:supplied?"needs_review":"search_unavailable",
  candidates:supplied?[supplied]:[],note:String(e.message||e).slice(0,95)}}
 const results=supplied?[supplied]:[];
 let preliminary=supplied?.status==="candidate_company_site"?supplied:null;
 for(const hit of hits.slice(0,c.dealOnlyResearch?6:4)){
  try{
   const candidate=await inspect(c,hit);
   results.push(candidate);
   if(candidate.status==="candidate_company_site"&&!preliminary)preliminary=candidate;
   if(candidate.status==="confirmed"){
    confirmed++;
    if(mode==="inn")innConfirmed++;
    require("./website-profiler").enqueue([{...c,siteCandidate:candidate.url,siteSource:"Поиск по названию — подтверждено независимыми реквизитами"}]);
    return {status:"confirmed",site:candidate.url,candidates:results,source:"Поиск по названию",note:candidate.note};
   }
  }catch{results.push({url:hit.url,title:hit.title,status:"unavailable",note:"Не удалось проверить сайт"})}
 }
 if(preliminary){
  review++;
  require("./website-profiler").enqueue([{...c,siteCandidate:preliminary.url,
   siteSource:"Поиск по юридическому наименованию — предварительно"}]);
  return {status:"candidate_company_site",site:preliminary.url,
   candidates:results,note:preliminary.note};
 }
 if(results.some(x=>x.status==="needs_review"))review++;
 return {status:results.some(x=>x.status==="needs_review")?"needs_review":
   hits.length?"no_confirmed_site":"not_found",candidates:results,
   note:"Список сайтов-кандидатов без подтверждения принадлежности"};
}
async function pump(){
 if(busy)return;busy=true;
 while(queue.length){
  const c=queue.shift(),id=String(c.id),mode=c.__siteLookupMode==="inn"?"inn":"name";
  pending.delete(id);
  if(completion.isComplete(id)||(mode==="name"&&profiles.has(id)))continue;
  attempted++;
  if(mode==="inn")innAttempted++;
  try{profiles.set(id,await scan(c,mode))}
  catch{unavailable++;profiles.set(id,{status:"error",candidates:[]})}
  if(attempted%40===0||queue.length===0)console.log(JSON.stringify({component:"name-site-search",event:"progress",attempted,confirmed,review,unavailable,innAttempted,innConfirmed,remaining:queue.length}));
  await sleep(1350);
 }
 busy=false;
}
function enqueue(companies){
 let added=0;
 for(const c of companies||[]){
  const id=String(c.id||"");if(!id||completion.isComplete(id)||profiles.has(id)||pending.has(id)||!eligible(c))continue;
  pending.add(id);queue.push(c);added++;
 }
 if(added)console.log(JSON.stringify({component:"name-site-search",event:"queued",count:added,remaining:queue.length}));
 pump().catch(()=>{busy=false});
}
function enqueuePriority(companies,limit=25){
 let added=0;
 for(const c of (companies||[]).slice(0,Math.min(45,Math.max(1,limit))).reverse()){
  const id=String(c?.id||"");
  if(!id||pending.has(id)||profiles.has(id)||completion.isComplete(id)||!eligible(c))continue;
  pending.add(id);queue.unshift(c);added++;
 }
 if(added)console.log(JSON.stringify({component:"name-site-search",
  event:"deal-only-sites-prioritized",queued:added,remaining:queue.length}));
 if(added)pump().catch(()=>{busy=false});
 return added;
}
function enqueueByInn(companies){
 let added=0;
 for(const c of companies||[]){
  if(added>=30)break;
  const id=String(c?.id||""),inn=String(c?.crmInn||"").replace(/\D/g,"");
  if(!/^\d+$/.test(id)||!/(?:^\d{10}$|^\d{12}$)/.test(inn)||
     innTried.has(id)||pending.has(id)||completion.isComplete(id)||!eligible(c))continue;
  const previous=profiles.get(id);
  if(!previous||!["not_found","no_confirmed_site"].includes(previous.status))continue;
  innTried.add(id);pending.add(id);queue.push({...c,__siteLookupMode:"inn"});added++;
 }
 if(added)console.log(JSON.stringify({component:"name-site-search",
  event:"inn-search-queued",count:added,remaining:queue.length}));
 if(added)pump().catch(()=>{busy=false});
 return added;
}
function get(id){return profiles.get(String(id))||{status:pending.has(String(id))?"queued":"not_started",candidates:[]}}
function stats(){const count={};for(const p of profiles.values())count[p.status]=(count[p.status]||0)+1;return {attempted,confirmed,review,unavailable,innAttempted,innConfirmed,remaining:queue.length,count}}
module.exports={enqueue,enqueuePriority,enqueueByInn,get,stats,cleanName,eligible,domainAllowed,legalOrPhoneMatch,legalNameOnOwnSite};

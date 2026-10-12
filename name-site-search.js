"use strict";
// Read-only website discovery for company records with no website/domain.
// A search result is NOT identity proof. Only name + independent phone/city
// corroboration is allowed to promote a URL to an official website.
const queue=[],pending=new Set(),profiles=new Map();
let busy=false,attempted=0,confirmed=0,review=0,unavailable=0;
const skipDomains=new Set(["bing.com","google.com","yandex.ru","2gis.ru","rusprofile.ru","checko.ru","sbis.ru","saby.ru","companies.rbc.ru","list-org.com","orgpage.ru","avito.ru","hh.ru","vk.com","youtube.com","facebook.com","instagram.com","spravker.ru","spark-interfax.ru"]);
const sleep=n=>new Promise(r=>setTimeout(r,n));
const normalized=s=>String(s||"").toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"");
function cleanName(raw){
 return String(raw||"").trim().replace(/^(?:\s*["«»']*)?(?:ООО|ОАО|ПАО|АО|ЗАО|НАО|ИП)\s*["«»']?\s*/i,"")
 .replace(/\s*[,.\-]?\s*(?:ООО|ОАО|ПАО|АО|ЗАО|НАО|ИП)$/i,"").replace(/["«»]/g,"").trim();
}
function eligible(c){
 const name=normalized(cleanName(c.name));
 if(name.length<9||/^(?:безназвания|неизвестно|безимени|неопределено|физлицо|частноелицо|тестоваякомпания|нетназвания)$/.test(name))return false;
 if(c.siteCandidate||c.corporateDomain||c.verifiedOrgType)return false;
 const free=/^(?:gmail\.com|mail\.ru|list\.ru|bk\.ru|yandex\.ru|ya\.ru|outlook\.com|rambler\.ru|hotmail\.com|icloud\.com)$/i;
 return ![...(c.crmEmails||[]),...(c.contactEmails||[])].some(e=>{
  const d=String(e||"").split("@");return d.length>1&&d[d.length-1].includes(".")&&!free.test(d[d.length-1]);
 });
}
function legalOrPhoneMatch(c,site){
 const content=String([site.meta.title,site.meta.description,...(site.meta.headings||[]),site.meta.body||""].join(" ")).toLowerCase().replace(/ё/g,"е");
 const digits=s=>String(s||"").replace(/\D/g,"");
 const originalPhones=(c.crmPhones||[]).map(digits).filter(x=>x.length>=10).map(x=>x.slice(-10));
 const shownPhones=[...content.matchAll(/(?:\+7|7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/g)].map(x=>digits(x[0]).slice(-10));
 const phone=originalPhones.length>0&&originalPhones.some(x=>shownPhones.includes(x));
 const city=String(c.crmCity||"").trim().toLowerCase();
 const region=String(c.crmRegion||"").trim().toLowerCase();
 const location=(city.length>=5&&content.includes(city))||(region.length>=6&&content.includes(region));
 const legal=String(c.crmInn||"").replace(/\D/g,"");
 const legalMatch=legal.length>=10&&content.includes(legal);
 return {matched:phone||legalMatch,proof:phone?"Совпадает телефон":legalMatch?"Совпадает ИНН":"",locationCorroboration:location};
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
async function search(name){
 const u=new URL("https://www.bing.com/search");
 u.searchParams.set("format","rss");u.searchParams.set("q",'"'+name+'" официальный сайт');u.searchParams.set("setlang","ru");
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
async function inspect(c,hit){
 const site=await require("./website-profiler").fetchPage(hit.url);
 const name=normalized(cleanName(c.name));
 const siteText=[site.meta.title,site.meta.description,...(site.meta.headings||[]),site.meta.body||""].join(" ");
 const siteNormalized=normalized(siteText);
 const nameMatch=name.length>=9&&siteNormalized.includes(name);
 if(!nameMatch)return {url:site.url,title:hit.title,status:"other_company",note:"Название организации на сайте не совпало"};
 const proof=legalOrPhoneMatch(c,site);
 return {url:site.url,title:hit.title,status:proof.matched?"confirmed":"needs_review",
  note:proof.matched?proof.proof:"Совпадает название, но не телефон или ИНН — принадлежность сайта не подтверждена"};
}
async function scan(c){
 let hits;
 try{hits=await search(cleanName(c.name))}
 catch(e){unavailable++;return {status:"search_unavailable",candidates:[],note:String(e.message||e).slice(0,95)}}
 const results=[];
 for(const hit of hits.slice(0,4)){
  try{
   const candidate=await inspect(c,hit);
   results.push(candidate);
   if(candidate.status==="confirmed"){
    confirmed++;
    require("./website-profiler").enqueue([{...c,siteCandidate:candidate.url,siteSource:"Поиск по названию — подтверждено независимыми реквизитами"}]);
    return {status:"confirmed",site:candidate.url,candidates:results,source:"Поиск по названию",note:candidate.note};
   }
  }catch{results.push({url:hit.url,title:hit.title,status:"unavailable",note:"Не удалось проверить сайт"})}
 }
 if(results.some(x=>x.status==="needs_review"))review++;
 return {status:results.some(x=>x.status==="needs_review")?"needs_review":hits.length?"no_confirmed_site":"not_found",
  candidates:results,note:"Список сайтов-кандидатов без подтверждения принадлежности"};
}
async function pump(){
 if(busy)return;busy=true;
 while(queue.length){
  const c=queue.shift(),id=String(c.id);pending.delete(id);if(profiles.has(id))continue;
  attempted++;
  try{profiles.set(id,await scan(c))}
  catch{unavailable++;profiles.set(id,{status:"error",candidates:[]})}
  if(attempted%40===0||queue.length===0)console.log(JSON.stringify({component:"name-site-search",event:"progress",attempted,confirmed,review,unavailable,remaining:queue.length}));
  await sleep(1350);
 }
 busy=false;
}
function enqueue(companies){
 let added=0;
 for(const c of companies||[]){
  const id=String(c.id||"");if(!id||profiles.has(id)||pending.has(id)||!eligible(c))continue;
  pending.add(id);queue.push(c);added++;
 }
 if(added)console.log(JSON.stringify({component:"name-site-search",event:"queued",count:added,remaining:queue.length}));
 pump().catch(()=>{busy=false});
}
function get(id){return profiles.get(String(id))||{status:pending.has(String(id))?"queued":"not_started",candidates:[]}}
function stats(){const count={};for(const p of profiles.values())count[p.status]=(count[p.status]||0)+1;return {attempted,confirmed,review,unavailable,remaining:queue.length,count}}
module.exports={enqueue,get,stats,cleanName,eligible,domainAllowed};

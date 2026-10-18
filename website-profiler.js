"use strict";
const dns=require("dns").promises,net=require("net");
const {inferWebsiteActivity}=require("./client-type-inference");
const evidenceStore=require("./site-profile-store");
const completion=require("./client-finalization");
const profiles=new Map(),visited=new Set(),queue=[],sourcePriority=new Map(),sourceFingerprints=new Map();
const attemptedFingerprints=new Map(),transientRetries=new Map();
const RETRY_AFTER_MS=3*60*60*1000,MAX_TRANSIENT_RETRIES=1;
const persistedProfiles=new Map(),deferredCompanies=[];
let restoring=false,restored=false,restoredProfiles=0;
let pagesScanned=0,checkedSites=0,lastProgressLogged=0;
let active=0,lastAt=0;
function publicIPv4(ip){
 const x=ip.split(".").map(Number);
 if(x.length!==4||x.some(z=>!Number.isInteger(z)||z<0||z>255))return false;
 return !(
 x[0]===0||x[0]===10||x[0]===127||x[0]>=224||
 (x[0]===169&&x[1]===254)||(x[0]===172&&x[1]>=16&&x[1]<=31)||
 (x[0]===192&&x[1]===168)||(x[0]===100&&x[1]>=64&&x[1]<=127)||
 (x[0]===192&&x[1]===0)||(x[0]===198&&[18,19].includes(x[1]))
 );
}
async function safeUrl(value){
 const u=new URL(String(value||""));
 if(!["https:","http:"].includes(u.protocol)||u.username||u.password)return null;
 if(u.port&&!["80","443"].includes(u.port))return null;
 const host=u.hostname.toLowerCase();
 if(!host.includes(".")||host.endsWith(".local")||host.endsWith(".internal")||host.endsWith(".localhost")||host.endsWith(".test")||host.endsWith(".arpa")||net.isIP(host))return null;
 const ips=await dns.lookup(host,{all:true,verbatim:true});
 if(!ips.length||ips.some(a=>a.family===4?!publicIPv4(a.address):a.family===6?!/^[23][0-9a-f]{3}:/i.test(a.address):true))return null;
 return u;
}
function urls(c){
 const selected=evidenceStore.inputUrl(c);
 if(!selected)return [];
 const pinned=Boolean(c.verifiedOrgType)||
  ["Официальный сайт, проверенный по юридическим данным",
   "Сайт организации, установленный по независимым источникам; содержимое и доступность ещё не проверены",
   "Поиск по названию — подтверждено независимыми реквизитами",
   "Сайт из подписи входящего письма",
   "Сайт из карточки компании, присланной письмом"].includes(c.siteSource);
 const fromEmail=!pinned&&Boolean(c.corporateDomain)&&selected==="https://"+c.corporateDomain;
 const origin=fromEmail?(
   ["Домен привязанного контакта","Альтернативный домен привязанного контакта","Домен из входящей сделки",
    "Непривязанные CRM-контакты: совпали название и корпоративный домен"].includes(c.siteSource)
     ?c.siteSource:"Корпоративный домен e-mail CRM"
   ):(c.siteSource||"Сайт из CRM");
 return [{url:selected,origin}];
}
function strip(s){
 return String(s||"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
 .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
 .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi," ")
 .replace(/<(?:nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|footer|aside)>/gi," ")
 .replace(/<[^>]*>/g," ").replace(/&(?:nbsp|amp|quot|lt|gt);/gi," ")
 .replace(/\s+/g," ").trim();
}
function extract(html){
 const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"";
 const description=(html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)||[])[1]||
 (html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i)||[])[1]||"";
 const headings=[...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].slice(0,14).map(m=>strip(m[1]));
 const focus=(html.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)||[])[1]||html;
 const body=strip(focus).slice(0,7500);
 const whole=strip(html);
 const identityText=(whole.slice(0,1900)+" "+whole.slice(-5000)).slice(0,6900);
 return {title:strip(title).slice(0,200),description:strip(description).slice(0,600),headings,body,identityText};
}
function discoverLinks(html,base){
 const seen=new Set(),suggestions=[];
 const general=/(?:о[-_ ]?(?:компании|нас)|about|company|proizvod|production|продукц|products|catalog|katalog|services|услуг|uslugi|деятельност|deyatelnost|направлен|napravlen|solutions|решения|kontakty|contacts|контакт|реквизит|rekvizit|requisites|legal[-_ ]?details|информац.{0,15}юрлиц)/i;
 for(const m of String(html||"").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']{1,230})["'][^>]*>([\s\S]{0,950}?)<\/a>/gi)){
  const label=strip(m[2]),raw=m[1].replace(/&amp;/gi,"&");
  if(!general.test(label+" "+raw))continue;
  try{
   const dest=new URL(raw,base);
   if(!["https:","http:"].includes(dest.protocol)||dest.hostname.toLowerCase()!==base.hostname.toLowerCase()||dest.username||dest.password||dest.port)continue;
   if(/\.(?:pdf|docx?|xlsx?|zip|rar|7z|png|jpg|jpeg|gif|svg|js|css)(?:$|[?#])/i.test(dest.pathname)||/\/(?:login|auth|admin|cart|search)\b/i.test(dest.pathname))continue;
   dest.hash="";dest.search="";
   const u=dest.toString();
   if(u===base.origin+"/"||seen.has(u))continue;
   seen.add(u);
   const isAbout=/(?:о[-_ ]?(?:компании|нас)|about|company|o-kompanii|onas)/i.test(label+" "+raw);
   const identityPage=/(?:реквизит|rekvizit|requisites|legal[-_ ]?details|контакт|kontakty|contacts|contact[-_ ]?us|legal[-_ ]?information)/i.test(label+" "+raw);
   const isProducts=/(?:продукц|products|catalog|katalog|services|услуг|uslugi|деятельност|deyatelnost|направлен|napravlen|production|proizvod|solutions|решен)/i.test(label+" "+raw);
   const category=/(?:реквизит|rekvizit|requisites|legal[-_ ]?details)/i.test(label+" "+raw)?"requisites":/(?:контакт|kontakty|contacts|contact[-_ ]?us)/i.test(label+" "+raw)?"contacts":isAbout?"about":isProducts?"activity":"other";
   suggestions.push({url:u,score:identityPage?5:isAbout?4:isProducts?3:1,category});
   if(suggestions.length>=18)break;
  }catch{}
 }
 const list=suggestions.sort((a,b)=>b.score-a.score);
 const picked=[],kinds=new Set(),urls=new Set();
 for(const candidate of list){if(kinds.has(candidate.category))continue; kinds.add(candidate.category);picked.push(candidate);urls.add(candidate.url);}
 for(const candidate of list){if(picked.length>=5)break;if(urls.has(candidate.url))continue;picked.push(candidate);urls.add(candidate.url)}
 return picked.slice(0,5).map(x=>x.url);
}
function homepageVariants(raw){
 // A protocol-less address is only input notation, not a fifth network
 // protocol: an actual request must use HTTP or HTTPS.
 const value=String(raw||"").trim();
 if(!value)return [];
 let url;
 try{
  const normalized=/^\/\//.test(value)?"https:"+value:
   /^[a-z][a-z0-9+.-]*:\/\//i.test(value)?value:"https://"+value;
  url=new URL(normalized);
 }catch{return [value]}
 if(!["https:","http:"].includes(url.protocol)||url.username||url.password||
  !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)||url.hostname.includes(".."))return [value];
 // Preserve explicit ports (including non-default) instead of rewriting them.
 // The fetchPage safety gate still disallows unsafe ports or hostnames.
 if(url.port)return [url.toString()];
 const baseHost=url.hostname.toLowerCase().replace(/^www\./,"");
 const variants=[],seen=new Set();
 for(const [protocol,host] of [
  ["https:",baseHost],
  ["https:","www."+baseHost],
  ["http:","www."+baseHost],
  ["http:",baseHost]
 ]){
  const candidate=new URL(url);
  candidate.protocol=protocol;candidate.hostname=host;
  candidate.hash="";
  const text=candidate.toString();
  if(!seen.has(text)){seen.add(text);variants.push(text)}
 }
 return variants;
}
async function fetchCorporateHome(raw){
 let lastError;
 for(const candidate of homepageVariants(raw)){
  try{return await fetchPage(candidate)}
  catch(error){lastError=error}
 }
 throw lastError||Error("Сайт не открылся");
}
async function fetchPage(raw){
 let current=raw;
 for(let n=0;n<3;n++){
  const u=await safeUrl(current);if(!u)throw Error("Адрес сайта не прошёл проверку безопасности");
  const r=await fetch(u,{method:"GET",headers:{"accept":"text/html","user-agent":"TOPSENSE-Corporate-Profile-Reader/1.0"},redirect:"manual",signal:AbortSignal.timeout(8500)});
  if([301,302,303,307,308].includes(r.status)){const dest=r.headers.get("location");if(!dest)throw Error("Пустой redirect");current=new URL(dest,u).toString();await r.body?.cancel();continue}
  if(!r.ok)throw Error("HTTP "+r.status);
  const ct=String(r.headers.get("content-type")||"").toLowerCase();
  if(!ct.includes("text/html"))throw Error("Это не HTML");
  const reader=r.body?.getReader();if(!reader)throw Error("Нет тела страницы");
  const chunks=[];let bytes=0;
  while(bytes<160000){const {value,done}=await reader.read();if(done)break;chunks.push(value);bytes+=value.length}
  await reader.cancel().catch(()=>{});
  const all=new Uint8Array(Math.min(bytes,160000));let pos=0;for(const chunk of chunks){const sl=chunk.subarray(0,all.length-pos);all.set(sl,pos);pos+=sl.length;if(pos>=all.length)break}
  const text=new TextDecoder("utf-8",{fatal:false}).decode(all);
  return {url:u.origin,pageUrl:u.toString(),meta:extract(text),links:discoverLinks(text,u)};
 }
 throw Error("Много перенаправлений");
}
async function one(c){
 if(completion.isComplete(c.id))return;
 const candidates=urls(c);
 if(!candidates.length){profiles.set(c.id,{status:"site_absent",source:"Карточка CRM не содержит сайт или корпоративный домен"});return}
 try{
  const currentRank=evidenceRank(candidates[0].origin);
  const result=await fetchCorporateHome(candidates[0].url);
  if(currentRank<(sourcePriority.get(String(c.id))||0))return;
  // The homepage often contains marketing but not the company's actual activity.
  // Look at up to three same-host About / Services / Products pages.
  const pages=[result],seenPages=new Set([result.pageUrl]);
  for(const u of result.links.slice(0,5)){
   if(seenPages.has(u))continue;
   try{
    const part=await fetchPage(u);
    if(new URL(part.url).hostname!==new URL(result.url).hostname)continue;
    if(currentRank<(sourcePriority.get(String(c.id))||0))return;
    pages.push(part);seenPages.add(part.pageUrl);
   }catch{}
  }
  // Site owner activity must be distinguished from sectors buying its equipment.
  // Read About/Products for activity, Contacts/Requisites for legal identity.
  const activity=inferWebsiteActivity(pages,c.name);
  const found=activity?.type?{type:activity.type}:null;
  const ambiguous=Boolean(activity&&!activity.type);
  const tokens=String(c.name||"").toLowerCase().replace(/(?:ооо|ао|оао|пао|зао|пкф|нпп|тд|филиал)/g," ").split(/[^а-яёa-z0-9]+/i).filter(t=>t.length>=5);
  const target=pages.map(p=>[p.meta.title,p.meta.description,...p.meta.headings,p.meta.body.slice(0,2000),p.meta.identityText].join(" ")).join(" ").toLowerCase();
  const checkedName=tokens.some(t=>target.includes(t));
  const orphanSource=c.siteSource==="Непривязанные CRM-контакты: совпали название и корпоративный домен";
  const fullCompanyName=String(c.name||"").toLowerCase().replace(/ё/g,"е")
    .replace(/^(?:ооо|ао|пао|оао|зао|ип)[\s\W]+/i,"").replace(/[^а-яa-z0-9]/g,"");
  const pageIdentity=target.replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"");
  const orphanNameConfirmed=fullCompanyName.length>=11&&pageIdentity.includes(fullCompanyName);
  const redirectedToOtherDomain=new URL(candidates[0].url).hostname.replace(/^www\./i,"")!==new URL(result.url).hostname.replace(/^www\./i,"");
  const emailDomainOnly=["Корпоративный домен e-mail CRM","Домен привязанного контакта"].includes(candidates[0].origin);
  const identifiedReference=String(c.siteSource||"").startsWith("Сайт организации, установленный по независимым источникам");
  const provisionalLegalNameSearch=c.siteSource==="Поиск по юридическому наименованию — предварительно";
  // HTTP-only fallback must corroborate company identity on the page.
  const insecureTransport=new URL(result.url).protocol==="http:";
  const thirdParty=c.siteSource==="Домен привязанного контакта"||c.siteSource==="Альтернативный домен привязанного контакта"||c.siteSource==="Домен из входящей сделки"||c.siteSource==="Кандидат из прежнего AI-пилота"||orphanSource||redirectedToOtherDomain||emailDomainOnly||identifiedReference||insecureTransport||provisionalLegalNameSearch;
  // A website typed into the CRM by a manager is not proof of ownership.
  // Require the company's FULL legal name on its own website, not one
  // matching keyword in a partner / holding / customer listing.
  const legalNameMatchesOwnSite=require("./name-site-search").legalNameOnOwnSite(c,pages);
  const crmWebsiteOnly=candidates[0].origin==="Сайт из CRM"&&!c.verifiedOrgType;
  const trusted=provisionalLegalNameSearch?legalNameMatchesOwnSite:
   orphanSource?(orphanNameConfirmed&&legalNameMatchesOwnSite):
   crmWebsiteOnly?legalNameMatchesOwnSite:(!thirdParty||checkedName);
  pagesScanned+=pages.length;checkedSites++;
  const profile={status:!trusted?"site_identity_unclear":provisionalLegalNameSearch&&found&&!ambiguous?
   "site_preliminary_profiled":ambiguous?"site_read_ambiguous_type":found?"site_profiled":"site_read_no_clear_type",source:candidates[0].origin,url:result.url,
   staffEvidence:trusted&&!provisionalLegalNameSearch?require("./staff-evidence").fromPages(pages):null,siteTitle:result.meta.title,siteDescription:result.meta.description,siteHeadings:pages.flatMap(p=>p.meta.headings).slice(0,18),sitePageCount:pages.length,sitePagesVisited:pages.map(p=>p.pageUrl),siteContactPages:pages.filter(p=>/(?:контакт|contact|kontakty|реквизит|rekvizit|requisite)/i.test(p.pageUrl)).map(p=>p.pageUrl),siteActivityReason:activity?.reason||"",
   siteIdentityEvidence:legalNameMatchesOwnSite?"full_legal_name_on_own_site":
    "legal_ownership_not_confirmed",
   // Website reading never establishes legal identity by itself.
   siteIdentityVerified:Boolean(c.verifiedOrgType&&
    c.siteSource==="Официальный сайт, проверенный по юридическим данным"),
   siteType:trusted&&!ambiguous?(found?.type||null):null,siteConfidence:trusted&&found&&!ambiguous?(provisionalLegalNameSearch?"Предварительная — совпали полное наименование и ОПФ, реквизиты пока не сверены":"Предварительная по нескольким страницам"):"Не определена",checkedAt:new Date().toISOString()};
  profiles.set(c.id,profile);
  evidenceStore.queue(c,profile);
 }catch(error){if(evidenceRank(candidates[0].origin)<(sourcePriority.get(String(c.id))||0))return;checkedSites++;profiles.set(c.id,{status:"site_unavailable",source:candidates[0].origin,url:candidates[0].url,error:String(error.message||error).slice(0,90),checkedAt:new Date().toISOString()})}
}
function pump(){
 while(active<2&&queue.length){
  const now=Date.now();if(now-lastAt<1200){setTimeout(pump,1250);return}
  const c=queue.shift();if(completion.isComplete(c.id))continue;
  active++;lastAt=Date.now();
  one(c).finally(()=>{
   active--;
   if(checkedSites-lastProgressLogged>=35||(!queue.length&&active===0)){
    lastProgressLogged=checkedSites;
    const counts={};for(const profile of profiles.values())counts[profile.status]=(counts[profile.status]||0)+1;
    console.log(JSON.stringify({component:"site-profiler",event:"progress",checkedSites,pagesScanned,remaining:queue.length,active,byStatus:counts}));
   }
   setTimeout(pump,1300);
  });
 }
}
function evidenceRank(source){
 if(source==="Сайт из подписи входящего письма")return 7;
 if(source==="Сайт из карточки компании, присланной письмом")return 6;
 if(source==="Корпоративный домен e-mail CRM")return 4;
 if(["Домен привязанного контакта","Альтернативный домен привязанного контакта","Домен из входящей сделки"].includes(source))return 3;
 if(source==="Непривязанные CRM-контакты: совпали название и корпоративный домен")return 3;
 if(source==="Поиск по названию — подтверждено независимыми реквизитами")return 0.5;
 if(source==="Сайт из CRM")return 2;
 if(source==="Кандидат из прежнего AI-пилота")return 1;
 return 2;
}
function restorePreliminaryNameProfile(c,row){
 // When CRM has no website, recover a previously researched provisional
 // own-legal-name site from our private store. Do not silently turn this
 // into a verified website: the profile status remains preliminary.
 const profile=row?.profile;
 if(profile?.status!=="site_preliminary_profiled"||
    profile.source!=="Поиск по юридическому наименованию — предварительно"||
    !profile.url)return null;
 const sameIdentity={...c,siteCandidate:profile.url,corporateDomain:"",
  siteSource:profile.source};
 return evidenceStore.restored(sameIdentity,row);
}
function enqueue(companies){
 // Restore already completed free site checks before starting a new crawl.
 // Render instances are ephemeral; a restart must not erase classification.
 if(!restored&&evidenceStore.configured()){
  deferredCompanies.push(...(companies||[]));
  if(!restoring){
   restoring=true;
   evidenceStore.load().then(map=>{
    for(const [id,row] of map)persistedProfiles.set(id,row);
   }).catch(()=>{}).finally(()=>{
    restored=true;restoring=false;
    const buffered=deferredCompanies.splice(0);
    console.log(JSON.stringify({component:"site-profiler",event:"cache-loaded",rows:persistedProfiles.size}));
    enqueue(buffered);
   });
  }
  return;
 }
 let added=0;
 for(const c of companies||[]){
  const id=String(c?.id||"");if(!id||completion.isComplete(id))continue;
  const candidates=urls(c);
  const hasSite=candidates.length>0;
  const newRank=hasSite?evidenceRank(candidates[0].origin):0;
  const signature=hasSite?evidenceStore.fingerprint(c):"";
  if(!attemptedFingerprints.has(id))attemptedFingerprints.set(id,new Set());
  const fingerprints=attemptedFingerprints.get(id);
  // Do not oscillate between the same CRM domain and a fallback contact domain
  // whenever the CRM refreshes. A separate cooldown controls true retries.
  if(hasSite&&fingerprints.has(signature))continue;
  if(visited.has(id)){
   const oldRank=sourcePriority.get(id)||0;
   const status=profiles.get(id)?.status;
   const unresolved=["site_unavailable","site_identity_unclear","site_read_no_clear_type"].includes(status);
   if(newRank<oldRank&&!unresolved)continue;
   if(newRank===oldRank&&sourceFingerprints.get(id)===signature)continue;
   if(hasSite)fingerprints.add(signature);
   sourcePriority.set(id,newRank);sourceFingerprints.set(id,signature);
   // Changing a same-priority website must invalidate a previous site's type.
   profiles.set(id,{status:hasSite?"site_pending":"site_absent",source:"Источник сайта изменился; нужна перепроверка"});
   if(hasSite){queue.push(c);added++}
   continue;
  }
  visited.add(id);sourcePriority.set(id,newRank);sourceFingerprints.set(id,signature);
  if(hasSite)fingerprints.add(signature);
  if(!hasSite){
   const prior=restorePreliminaryNameProfile(c,persistedProfiles.get(id));
   if(prior){profiles.set(id,prior);restoredProfiles++;continue}
   profiles.set(id,{status:"site_absent",source:"Нет подтверждённого сайта или корпоративного домена"});
   continue;
  }
  const cached=evidenceStore.restored(c,persistedProfiles.get(id));
  if(cached){
   profiles.set(id,cached);restoredProfiles++;continue;
  }
  queue.push(c);added++;
 }
 pump();
 if((companies||[]).length>25)console.log(JSON.stringify({component:"site-profiler",event:"queue-updated",added,queued:queue.length,known:profiles.size,restoredProfiles}));
 return added;
}
function retryTransient(companies,now=Date.now()){
 if((!restored&&evidenceStore.configured())||queue.length||active)return 0;
 let accepted=0;
 for(const c of companies||[]){
  if(accepted>=20)break;
  const id=String(c?.id||"");
  if(!id||completion.isComplete(id))continue;
  const profile=profiles.get(id);
  if(profile?.status!=="site_unavailable")continue;
  // Retry only probable temporary connection/rate-limit/server failures.
  // Never repeatedly query permanently unavailable or blocked endpoints.
  if(!/timed? ?out|abort|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP 429|HTTP 50[0234]/i.test(String(profile.error||"")))continue;
  const previous=transientRetries.get(id)||0;
  if(previous>=MAX_TRANSIENT_RETRIES)continue;
  const last=Date.parse(profile.checkedAt||"");
  if(!Number.isFinite(last)||now-last<RETRY_AFTER_MS)continue;
  const candidates=urls(c);
  if(!candidates.length||evidenceStore.fingerprint(c)!==sourceFingerprints.get(id))continue;
  transientRetries.set(id,previous+1);
  profiles.set(id,{...profile,status:"site_pending",source:"Повторная проверка временно недоступного сайта"});
  queue.push(c);accepted++;
 }
 if(accepted){
  console.log(JSON.stringify({component:"site-profiler",event:"transient-retries-queued",count:accepted,remaining:queue.length}));
  pump();
 }
 return accepted;
}
function get(id){return profiles.get(String(id))||{status:"site_pending"}}
function stats(){
 const by={};for(const c of profiles.values())by[c.status]=(by[c.status]||0)+1;
 return {restorationComplete:restored,restorationInProgress:restoring,
  classificationSnapshotProvisional:!restored||queue.length>0||active>0,
  queued:queue.length,active,processed:profiles.size,checkedSites,pagesScanned,
  restoredProfiles,byStatus:by,checkpoint:evidenceStore.stats()};
}
module.exports={enqueue,get,stats,retryTransient,fetchPage,fetchCorporateHome,homepageVariants,restorePreliminaryNameProfile};
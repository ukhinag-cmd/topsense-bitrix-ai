"use strict";
const dns=require("dns").promises,net=require("net");
const {infer}=require("./client-type-inference");
const profiles=new Map(),visited=new Set(),queue=[],sourcePriority=new Map();
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
 const out=[];
 if(c.siteCandidate)out.push({url:c.siteCandidate,origin:c.siteSource||"Сайт из CRM"});
 else if(c.corporateDomain&&/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(c.corporateDomain))
   out.push({url:"https://"+c.corporateDomain,origin:c.siteSource||"Корпоративный домен e-mail CRM"});
 return out;
}
function strip(s){
 return String(s||"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
 .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
 .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi," ")
 .replace(/<[^>]*>/g," ").replace(/&(?:nbsp|amp|quot|lt|gt);/gi," ")
 .replace(/\s+/g," ").trim();
}
function extract(html){
 const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"";
 const description=(html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)||[])[1]||
 (html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i)||[])[1]||"";
 const headings=[...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].slice(0,8).map(m=>strip(m[1]));
 const body=strip(html).slice(0,3500);
 return {title:strip(title).slice(0,200),description:strip(description).slice(0,600),headings,body};
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
  return {url:u.origin,meta:extract(text)};
 }
 throw Error("Много перенаправлений");
}
async function one(c){
 const candidates=urls(c);
 if(!candidates.length){profiles.set(c.id,{status:"site_absent",source:"Карточка CRM не содержит сайт или корпоративный домен"});return}
 try{
  const currentRank=evidenceRank(c.siteSource||(c.siteCandidate?"Сайт из CRM":"Корпоративный домен e-mail CRM"));
  const result=await fetchPage(candidates[0].url);
  if(currentRank<(sourcePriority.get(String(c.id))||0))return;
  const text=[result.meta.title,result.meta.description,...result.meta.headings,result.meta.body.slice(0,1600)].join(". ");
  const found=infer(text);
  const tokens=String(c.name||"").toLowerCase().replace(/(?:ооо|ао|оао|пао|зао|пкф|нпп|тд|филиал)/g," ").split(/[^а-яёa-z0-9]+/i).filter(t=>t.length>=5);
  const target=[result.meta.title,result.meta.description,...result.meta.headings].join(" ").toLowerCase();
  const checkedName=tokens.some(t=>target.includes(t));
  const orphanSource=c.siteSource==="Непривязанные CRM-контакты: совпали название и корпоративный домен";
  const fullCompanyName=String(c.name||"").toLowerCase().replace(/ё/g,"е")
    .replace(/^(?:ооо|ао|пао|оао|зао|ип)[\\s\\W]+/i,"").replace(/[^а-яa-z0-9]/g,"");
  const pageIdentity=target.replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"");
  const orphanNameConfirmed=fullCompanyName.length>=11&&pageIdentity.includes(fullCompanyName);
  const redirectedToOtherDomain=new URL(candidates[0].url).hostname.replace(/^www\\./i,"")!==new URL(result.url).hostname.replace(/^www\\./i,"");
  const thirdParty=c.siteSource==="Домен привязанного контакта"||c.siteSource==="Кандидат из прежнего AI-пилота"||orphanSource||redirectedToOtherDomain;
  const trusted=orphanSource?orphanNameConfirmed:(!thirdParty||checkedName);
  profiles.set(c.id,{status:!trusted?"site_identity_unclear":found?"site_profiled":"site_read_no_clear_type",source:candidates[0].origin,url:result.url,siteTitle:result.meta.title,siteDescription:result.meta.description,siteHeadings:result.meta.headings,siteType:trusted?(found?.type||null):null,siteConfidence:trusted&&found?"Предварительная по сайту":"Не определена",checkedAt:new Date().toISOString()});
 }catch(error){if(evidenceRank(c.siteSource||(c.siteCandidate?"Сайт из CRM":"Корпоративный домен e-mail CRM"))<(sourcePriority.get(String(c.id))||0))return;profiles.set(c.id,{status:"site_unavailable",source:candidates[0].origin,url:candidates[0].url,error:String(error.message||error).slice(0,90),checkedAt:new Date().toISOString()})}
}
function pump(){
 while(active<2&&queue.length){
  const now=Date.now();if(now-lastAt<1200){setTimeout(pump,1250);return}
  const c=queue.shift();active++;lastAt=Date.now();
  one(c).finally(()=>{active--;setTimeout(pump,1300)});
 }
}
function evidenceRank(source){
 if(source==="Сайт из подписи входящего письма")return 7;
 if(source==="Сайт из карточки компании, присланной письмом")return 6;
 if(source==="Корпоративный домен e-mail CRM")return 4;
 if(source==="Домен привязанного контакта")return 3;
 if(source==="Непривязанные CRM-контакты: совпали название и корпоративный домен")return 3;
 if(source==="Поиск по названию — подтверждено независимыми реквизитами")return 5;
 if(source==="Сайт из CRM")return 2;
 if(source==="Кандидат из прежнего AI-пилота")return 1;
 return 2;
}
function enqueue(companies){
 for(const c of companies){
  const id=String(c.id||"");
  const newRank=urls(c).length?evidenceRank(c.siteSource||(c.siteCandidate?"Сайт из CRM":"Корпоративный домен e-mail CRM")):0;
  if(visited.has(id)){
   if(newRank<=(sourcePriority.get(id)||0))continue;
   sourcePriority.set(id,newRank);
   if(!urls(c).length)continue;
   queue.push(c);
   continue;
  }
  visited.add(id);sourcePriority.set(id,newRank);
  if(!urls(c).length){profiles.set(id,{status:"site_absent",source:"Нет подтверждённого сайта или корпоративного домена"});}
  else queue.push(c);
 }
 pump();
 if(companies.length>25)console.log(JSON.stringify({component:"site-profiler",event:"queue-updated",queued:queue.length,known:profiles.size}));
}
function get(id){return profiles.get(String(id))||{status:"site_pending"}}
function stats(){const by={};for(const c of profiles.values())by[c.status]=(by[c.status]||0)+1;return {queued:queue.length,active,processed:profiles.size,byStatus:by}}
module.exports={enqueue,get,stats,fetchPage};
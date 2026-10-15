"use strict";
// Independent site-research lane for analytical clients identified from deals.
// Reuses the general name/INN/phone/email website verifier and safe crawler;
// no CRM writes, no paid AI, no arbitrary domain-to-holding assignments.
const emailDomains=require("./company-email-domains");
const nameSites=require("./name-site-search");
const profiler=require("./website-profiler");
const state={lastQueuedAt:null,lastAttemptMs:0,submitted:0,attempted:0};
const str=x=>String(x??"").trim();
function evidenceFor(client,read){
 const dealRefs=(client?.dealRefs||[]).slice(0,45);
 const profiles=dealRefs.map(r=>read(r.id)).filter(Boolean);
 const inns=new Set(),phones=new Set(),emails=new Set(),hints=new Set(),domains=new Set();
 for(const p of profiles){
  for(const n of p.requisitesInnCandidates||[]){
   const candidate=str(n).replace(/\D/g,"");
   if(/^(?:\d{10}|\d{12})$/.test(candidate))inns.add(candidate);
  }
  for(const n of p.legalNameCandidates||[]){
   const candidate=str(n.inn).replace(/\D/g,"");
   if(/^(?:\d{10}|\d{12})$/.test(candidate))inns.add(candidate);
  }
  for(const phone of p.phoneHints||[])if(phones.size<14)phones.add(str(phone));
  for(const mail of p.senderEmails||[])if(emails.size<24)emails.add(str(mail).toLowerCase());
  for(const host of p.corporateDomains||[])domains.add(str(host).toLowerCase());
  for(const raw of p.websiteHints||[])if(hints.size<15)hints.add(raw);
 }
 for(const host of emailDomains.extract([...emails])){
  domains.add(host);
 }
 const ownedDomainCandidates=[...domains].filter(d=>/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))
  .slice(0,6).map(d=>"https://"+d+"/");
 // Published/legal hints in the company record can be tried, but without
 // a corroborating CRM phone/INN/email they remain UNCONFIRMED.
 const rawCandidates=[client.siteCandidate,...hints,...ownedDomainCandidates]
  .filter(Boolean).map(str);
 const candidates=[],seen=new Set();
 for(const raw of rawCandidates){
  const url=nameSites.domainAllowed(raw);
  if(!url||seen.has(url))continue;
  seen.add(url);candidates.push(url);
  if(candidates.length>=8)break;
 }
 return {dealReadCount:profiles.length,innCount:inns.size,inn:inns.size===1?[...inns][0]:"",
  innConflict:inns.size>1,crmPhones:[...phones],crmEmails:[...emails],
  candidateSites:candidates,mailDomainCount:ownedDomainCandidates.length};
}
function prepare(client,evidence){
 return {id:client.id,name:client.name,dealOnlyResearch:true,
  crmInn:evidence.innConflict?"":evidence.inn,
  crmPhones:evidence.crmPhones,crmEmails:evidence.crmEmails,
  contactEmails:[],crmAddress:client.crmAddress||"",crmCity:client.crmCity||"",
  crmRegion:client.crmRegion||"",siteCandidate:"",
  corporateDomain:"",verifiedOrgType:"",
  suppliedSiteCandidate:evidence.candidateSites[0]||"",
  suppliedSiteCandidates:evidence.candidateSites.slice(1,4),
  siteSource:"Поиск из входящих сделок, подтверждение принадлежности ожидается"};
}
function enqueue(clients,{read,limit=22}={}){
 if(typeof read!=="function")return 0;
 // The UI may be refreshed often. Avoid repeatedly scheduling remote
 // website research or growing the public-search queue without a bound.
 const now=Date.now();
 if(now-state.lastAttemptMs<120000)return 0;
 if(nameSites.stats().remaining>90)return 0;
 state.lastAttemptMs=now;
 state.attempted++;
 const scored=(clients||[]).filter(c=>c?.companyCardMissing)
  .map(c=>({client:c,evidence:evidenceFor(c,read)}))
  .sort((a,b)=>Number(b.client.crmDealCount||0)-Number(a.client.crmDealCount||0)||
   b.evidence.dealReadCount-a.evidence.dealReadCount);
 const candidates=[];
 for(const c of scored){
  if(candidates.length>=Math.min(40,Math.max(1,limit)))break;
  if(c.evidence.innConflict)continue;
  // Don't trust a stale form or a domain alone; use them only as search hints.
  const record=prepare(c.client,c.evidence);
  if(nameSites.eligible(record))candidates.push(record);
 }
 const accepted=nameSites.enqueuePriority(candidates,Math.min(40,Math.max(1,limit)))||0;
 if(accepted){state.lastQueuedAt=new Date().toISOString();state.submitted+=accepted}
 return accepted;
}
function enrich(client,read){
 const evidence=evidenceFor(client,read);
 const checked=nameSites.get(client.id);
 const siteStatus=checked.status||"not_started";
 const web=siteStatus==="confirmed"?profiler.get(client.id):null;
 const trustedWeb=siteStatus==="confirmed"&&
  ["site_profiled","site_read_no_clear_type","site_read_ambiguous_type"].includes(web?.status);
 const annotated={
  ...client,websiteResearch:{
   status:siteStatus,checkedSite:siteStatus==="confirmed"?str(checked.site):"",
   evidence:siteStatus==="confirmed"?str(checked.note):"",
   candidateSites:evidence.candidateSites.slice(0,5),
   dealProfilesRead:evidence.dealReadCount,independentInn:!evidence.innConflict&&Boolean(evidence.inn),
   innConflict:evidence.innConflict,phoneClues:evidence.crmPhones.length,
   emailClues:evidence.crmEmails.length,sitePageCount:Number(web?.sitePageCount||0),
   activityTypeConfirmedBySite:Boolean(trustedWeb&&web?.siteType)
  }
 };
 if(siteStatus==="confirmed"&&checked.site){
  annotated.siteCandidate=str(checked.site);
  annotated.siteSource="Поиск из сделок — сайт подтверждён совпадением реквизитов";
 }
 if(trustedWeb){
  annotated.siteStatus=web.status;
  annotated.siteProfileUrl=web.url||checked.site;
  annotated.siteProfileTitle=web.siteTitle||"";
  annotated.siteProfileDescription=web.siteDescription||"";
  if(web.siteType&&require("./client-taxonomy").known(web.siteType)){
   annotated.organizationType=web.siteType;
   annotated.type=web.siteType;
   annotated.segmentConfidence="Профиль компании определён по изученным разделам сайта";
   annotated.segmentSource="Официальный сайт, реквизиты и история клиентских обращений";
  }
 }
 return annotated;
}
function stats(){return {...state,siteSearch:nameSites.stats(),siteProfiler:profiler.stats()}}
module.exports={evidenceFor,prepare,enqueue,enrich,stats};

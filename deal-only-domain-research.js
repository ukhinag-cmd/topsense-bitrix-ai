"use strict";
const crypto=require("node:crypto");
const mail=require("./sender-domain-site-proof");
const intake=require("./crm-deal-intake");
const profiler=require("./website-profiler");
const taxonomy=require("./client-taxonomy");
let scanned=0,queued=0,matched=0;
function siteId(c){
 const id=String(c?.id||"");
 if(!id.startsWith("dealonly:"))return "";
 const hex=crypto.createHash("sha256").update(id).digest("hex").slice(0,12);
 return "8"+(parseInt(hex,16)%10000000000000).toString().padStart(13,"0");
}
function domainFor(c){
 const domains=new Set();
 for(const deal of c?.dealRefs||[]){
  const p=intake.get(deal.id);
  if(!p||!Number(p.incomingEmails))continue;
  for(const address of p.senderEmails||[]){
   const host=String(address).split("@")[1];
   const value=mail.senderDomain(host);
   if(value)domains.add(value);
  }
 }
 if(domains.size>1)return ""; // multiple organizations may share an inferred group
 const ledger=require("./deal-only-sender-ledger");
 if(domains.size===1){
  const domain=[...domains][0];
  ledger.remember(c.id,domain);return domain;
 }
 return ledger.get(c?.id);
}
function enqueue(clients,limit=8){
 if(process.env.TOPSENSE_ANALYTICS_READONLY!=="1")return 0;
 scanned++;let added=0;
 for(const c of clients||[]){
  if(added>=limit)break;
  if(!c?.companyCardMissing||taxonomy.known(c.organizationType))continue;
  const domain=domainFor(c),id=siteId(c);
  if(!domain||!id)continue;
  const old=profiler.get(id);
  if(old.siteIdentityEvidence==="inbound_sender_domain_matches_website"&&old.emailSenderDomain===domain)continue;
  added+=profiler.enqueue([{id,name:c.name,corporateDomain:domain,emailSenderDomain:domain,
   siteCandidate:"",siteSource:"Домен отправителя входящего письма"}])||0;
 }
 queued+=added;
 if(added)console.log(JSON.stringify({component:"deal-only-domain-research",event:"queued",added,total:queued}));
 return added;
}
function apply(clients){
 matched=0;
 return (clients||[]).map(c=>{
  if(!c?.companyCardMissing||taxonomy.known(c.organizationType))return c;
  const profile=profiler.get(siteId(c)),domain=domainFor(c);
  if(!domain||profile.status!=="site_profiled"||!profile.siteIdentityVerified||
   profile.siteIdentityEvidence!=="inbound_sender_domain_matches_website"||
   !mail.matches(domain,profile.url)||!taxonomy.known(profile.siteType))return c;
  matched++;
  return {...c,organizationType:profile.siteType,type:profile.siteType,
   siteProfileUrl:profile.url,siteVerified:profile.url,siteStatus:"site_profiled",
   emailSenderDomain:domain,siteIdentityVerified:true,
   segmentSource:"Собственная деятельность на сайте "+profile.url+
    "; домен совпадает с корпоративной почтой отправителя входящей сделки",
   verification:"Домен письма совпал с сайтом; юридическая карточка отсутствует",
   researchStatus:"mail_domain_site_qualified",
   classificationEvidenceStatus:"confirmed_by_mail_domain_site",
   candidateReview:true};
 });
}
function stats(){return {scanned,queued,matched}}
module.exports={siteId,domainFor,enqueue,apply,stats};

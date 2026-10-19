"use strict";
// Reuse previously crawled first-party website activity only if the host
// exactly matches a unique corporate sender domain from ORIGINAL incoming
// CRM deal correspondence. Never use deal product needs to infer industry.
const proof=require("./sender-domain-site-proof");
const taxonomy=require("./client-taxonomy");
function match(company,site){
 if(site?.status!=="site_profiled"||!taxonomy.known(site.siteType)||
    !site.url||!site.siteActivityReason||!Array.isArray(company?.dealEvidence))return "";
 const original=company.dealEvidence.filter(p=>p?.incomingEmails>0);
 const domains=new Set();
 for(const deal of original){
  for(const from of deal.senderEmails||[]){
   const m=String(from||"").match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
   const host=proof.senderDomain(m?.[1]||"");
   if(host)domains.add(host);
  }
 }
 if(domains.size!==1)return "";
 const sender=[...domains][0];
 return proof.matches(sender,site.url)?sender:"";
}
module.exports={match};

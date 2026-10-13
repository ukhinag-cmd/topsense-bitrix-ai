"use strict";
// Read-only reconciliation of deals without COMPANY_ID.
// Never edit CRM, never attribute a deal merely because a short word occurs.
// Exact distinctive deal title and unique linked email domain are separate evidence.
const stopWords=new Set(["компания","фирма","организация","заказ","оборудование","монтаж","заявка","поставка","снабжение","покупатель","промснаб","инжиниринг","сервис","технологии","строй","группа","промстрой","завод","проект","ремонт","контакт","спец","тендер","сервисная","инвест","новая","холдинг","клиент","партнер","институт","производство","торговыйдом"]);
const generalDomains=new Set(["gmail.com","mail.ru","bk.ru","list.ru","inbox.ru","yandex.ru","ya.ru","rambler.ru","outlook.com","hotmail.com","icloud.com","yahoo.com","topsense.su","detector-gaza.ru","rutector.email"]);
const stats={status:"not_started",orphanDeals:0,matchedByTitle:0,matchedByDomain:0,matchedByContact:0,ambiguous:0,unmatched:0,emailsInspected:0,emailOwnerMatches:0,emailReadErrors:0};
function norm(v){return String(v||"").toLowerCase().replace(/ё/g,"е").replace(/[«»“”"'«»]/g,"").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ")}
function stripped(v){return norm(String(v||"").replace(/^\s*(?:общество с ограниченной ответственностью|ооо|пао|оао|зао|ао|ип|нпп|пкф|тд)\s*/i,"")).replace(/^(?:ооо|пао|оао|зао|ао|ип|нпп|пкф|тд) /,"")}
function compact(v){return String(v||"").replace(/\s/g,"")}
function meaningful(v){const n=stripped(v);return n.length>=7&&!stopWords.has(n)&&!/^\d+$/.test(n)&&n.split(" ").some(w=>w.length>=6&&!stopWords.has(w))}
function domain(addr){const z=String(addr||"").toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);return z?z[1]:""}
function websiteHost(site){try{return new URL(/^[a-z]+:\/\//i.test(site)?site:"https://"+site).hostname.replace(/^www\./,"").toLowerCase()}catch{return""}}
function indexCompanies(companies){
 const companyById=new Map(),byDomain=new Map(),names=[];
 for(const c of companies||[]){
  const id=String(c.id||"");if(!id)continue;companyById.set(id,c);
  if(meaningful(c.name))names.push({id,key:stripped(c.name),compact:compact(stripped(c.name))});
  const addresses=[...(c.crmEmails||[]),...(c.contactEmails||[])].map(domain);
  if(c.corporateDomain)addresses.push(c.corporateDomain.toLowerCase());
  if(c.siteCandidate)addresses.push(websiteHost(c.siteCandidate));
  for(const d of new Set(addresses.filter(Boolean))){
   if(generalDomains.has(d))continue;
   if(!byDomain.has(d))byDomain.set(d,new Set());
   byDomain.get(d).add(id);
  }
 }
 return {companyById,byDomain,names};
}
function titleCandidates(title,idx){
 const full=" "+norm(title)+" ";
 const found=[];
 if(!full.trim()||full.length>650)return found;
 for(const n of idx.names){
  // A complete distinctive company name must form a phrase with word boundaries.
  if(full.includes(" "+n.key+" "))found.push(n);
 }
 // Several distinct company names in one deal title = unsafe to assign to one.
 if(!found.length)return [];
 const unique=[...new Set(found.map(x=>x.key))];
 if(unique.length!==1)return found.map(x=>x.id);
 return [...new Set(found.map(x=>x.id))];
}
function emailCandidates(addresses,idx){
 const out=new Set();
 for(const e of addresses||[]){
  const d=domain(e);if(!d||generalDomains.has(d))continue;
  const ids=idx.byDomain.get(d);
  if(ids&&ids.size===1)for(const id of ids)out.add(id);
 }
 return [...out];
}
function resolveDeal(d,idx,contacts){
 const old=String(d.COMPANY_ID||"");
 if(old!=="0"&&old&&idx.companyById.has(old))return {companyId:old,source:"direct_company",verified:true};
 if(old!=="0"&&old)return null; // Never override a nonempty CRM company ID.
 const matches=titleCandidates(d.TITLE,idx);
 const contactId=String(d.CONTACT_ID||"");
 let contactMatch="";
 if(contacts?.has(contactId)){
  const p=contacts.get(contactId);
  const own=String(p.COMPANY_ID||"");
  if(idx.companyById.has(own))contactMatch=own;
  else{
   const via=emailCandidates((p.EMAIL||[]).map(e=>typeof e==="object"?e.VALUE:e),idx);
   if(via.length===1)contactMatch=via[0];
  }
 }
 if(contactMatch){
  if(matches.length===0||matches.includes(contactMatch))
   return {companyId:contactMatch,source:"crm_contact_id",verified:true};
  return {companyId:"",source:"ambiguous_title_contact",verified:false};
 }
 if(matches.length===1)return {companyId:matches[0],source:"unique_full_title",verified:false};
 return {companyId:"",source:matches.length?"ambiguous_title":"no_title_match",verified:false};
}
function indexContacts(items){
 const contactById=new Map();
 for(const c of items||[])if(c.ID)contactById.set(String(c.ID),c);
 return contactById;
}
async function lookupDealEmailEvidence(deal,companyId,call,idx){
 try{
  const r=await call("crm.activity.list",{order:{ID:"DESC"},
   filter:{OWNER_TYPE_ID:2,OWNER_ID:Number(deal.ID)},
   select:["ID","OWNER_TYPE_ID","OWNER_ID","TYPE_ID","DIRECTION","PROVIDER_ID","SUBJECT","COMMUNICATIONS"],start:0});
  const emails=[];
  for(const a of (r.result||[])){
   if(String(a.TYPE_ID)!=="4"&&String(a.PROVIDER_ID||"").toUpperCase()!=="CRM_EMAIL")continue;
   stats.emailsInspected++;
   for(const c of Array.isArray(a.COMMUNICATIONS)?a.COMMUNICATIONS:[]){
    if(c?.VALUE)emails.push(c.VALUE);
   }
  }
  const matches=emailCandidates(emails,idx);
  if(matches.length===1&&matches[0]===companyId){stats.emailOwnerMatches++;return{verified:true,source:"deal_email_corporate_domain"}}
  if(matches.length>1||matches.length===1&&matches[0]!==companyId)return{verified:false,source:"email_domain_conflict"};
  return{verified:false,source:"no_mail_domain_evidence"};
 }catch{stats.emailReadErrors++;return{verified:false,source:"mail_read_unavailable"}}
}
function reconcile(deals,companies,contacts){
 const idx=indexCompanies(companies),byDeal=new Map(),candidates=[];
 Object.assign(stats,{status:"reconciling",orphanDeals:0,matchedByTitle:0,matchedByDomain:0,matchedByContact:0,ambiguous:0,unmatched:0,emailsInspected:0,emailOwnerMatches:0,emailReadErrors:0});
 for(const d of deals.values()){
  const id=String(d.ID||"");
  if(!id||String(d.COMPANY_ID||"")!=="0"&&String(d.COMPANY_ID||"")!=="")continue;
  stats.orphanDeals++;
  const link=resolveDeal(d,idx,contacts);
  if(link?.companyId){
   if(link.source==="unique_full_title")stats.matchedByTitle++;
   if(link.source==="crm_contact_id")stats.matchedByContact++;
   const row={dealId:id,companyId:link.companyId,linkSource:link.source,linkVerified:link.verified,originalCompanyId:"",title:String(d.TITLE||"").slice(0,180)};
   candidates.push(row);byDeal.set(id,row);
  }else if(link?.source.startsWith("ambiguous"))stats.ambiguous++;
  else stats.unmatched++;
 }
 stats.status="title_and_contact_matched";
 return {byDeal,candidates,idx,stats:{...stats}};
}
module.exports={reconcile,indexCompanies,indexContacts,resolveDeal,lookupDealEmailEvidence,stats,norm,stripped,emailCandidates,titleCandidates};
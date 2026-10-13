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
function normalizedLegal(v){
 const x=stripped(v).replace(/^(?:нпп|пкф|тд|ооо|оао|пао|ао|зао|ип)\s+/,"");
 return x.replace(/(?:\s+(?:ооо|оао|пао|ао|зао|ип))$/,"").replace(/\s+/g,"").trim();
}
function legalForm(v){
 const m=norm(v).match(/^(?:ооо|оао|пао|ао|зао|ип)\b|\b(?:ооо|оао|пао|ао|зао|ип)$/i);
 return m?m[0]:"";
}
function canonicalDomain(idset,idx){
 const ids=[...(idset||[])].filter(id=>idx.companyById.has(id));
 if(ids.length===1)return ids[0];
 if(ids.length<2)return"";
 const companies=ids.map(id=>idx.companyById.get(id));
 const keys=[...new Set(companies.map(c=>normalizedLegal(c.name)))];
 const forms=[...new Set(companies.map(c=>legalForm(c.name)).filter(Boolean))];
 if(keys.length!==1||keys[0].length<5||forms.length>1)return"";
 return ids.sort((a,b)=>Number(a)-Number(b))[0];
}
function domainsInTitle(title,idx){
 const out=[];
 const raw=String(title||"").toLowerCase();
 for(const [d,ids] of idx.byDomain){
  if(d.length<7||generalDomains.has(d))continue;
  let at=raw.indexOf(d);
  while(at>=0){
   const left=at===0?"":raw[at-1],right=at+d.length>=raw.length?"":raw[at+d.length];
   if(!/[a-z0-9.-]/.test(left)&&!/[a-z0-9.-]/.test(right)){
    const owner=canonicalDomain(ids,idx);if(owner)out.push(owner);
    break;
   }
   at=raw.indexOf(d,at+1);
  }
 }
 return [...new Set(out)];
}
function emailCandidates(addresses,idx){
 const out=new Set();
 for(const e of addresses||[]){
  const d=domain(e);if(!d||generalDomains.has(d))continue;
  const ids=idx.byDomain.get(d);
  if(ids){const owner=canonicalDomain(ids,idx);if(owner)out.add(owner)}
 }
 return [...out];
}
function resolveDeal(d,idx,contacts){
 const old=String(d.COMPANY_ID||"");
 if(old!=="0"&&old&&idx.companyById.has(old))return {companyId:old,source:"direct_company",verified:true};
 if(old!=="0"&&old)return null; // Never override a nonempty CRM company ID.
 const matches=titleCandidates(d.TITLE,idx);
 const titleDomains=domainsInTitle(d.TITLE,idx);
 if(titleDomains.length===1&&(!matches.length||matches.includes(titleDomains[0])))
  return {companyId:titleDomains[0],source:"deal_title_corporate_domain",verified:true};
 if(titleDomains.length>1)return {companyId:"",source:"ambiguous_domains_in_title",verified:false};
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


// Resolve CONTACT_ID on orphan deals without scanning all ~20k CRM contacts again.
async function fetchContactIndex(deals,call){
 const ids=[...new Set([...deals.values()]
  .filter(d=>String(d.COMPANY_ID||"")==="0"||String(d.COMPANY_ID||"")==="")
  .map(d=>String(d.CONTACT_ID||""))
  .filter(s=>/^\d+$/.test(s)&&s!=="0"))];
 const maxIds=4500,map=new Map(),errors=[];
 for(let i=0;i<Math.min(ids.length,maxIds);i+=40){
  try{
   const p=await call("crm.contact.list",{
    order:{ID:"ASC"},filter:{"@ID":ids.slice(i,i+40)},
    select:["ID","COMPANY_ID","EMAIL"],start:0});
   for(const row of Array.isArray(p.result)?p.result:[])if(row.ID)map.set(String(row.ID),row);
  }catch{errors.push(i)}
  if(i%240===0)await new Promise(resolve=>setTimeout(resolve,120));
 }
 return {contacts:map,stats:{contactIdsFound:ids.length,contactsRead:map.size,failedBatches:errors.length,
  status:errors.length?"partial_errors":ids.length>maxIds?"partial_limit":"complete"}};
}
// Check the ENTIRE lifetime of every orphan deal reaching a qualifying stage.
// Avoid relying on a recent slice of global correspondence.
async function verifyRelevantDealEmails(deals,reconciliation,stageMap,history,call){
 const requested=[];
 for(const d of deals.values()){
  const id=String(d.ID||"");
  if(!id||(String(d.COMPANY_ID||"")!=="0"&&String(d.COMPANY_ID||"")!==""))continue;
  const h=history.get(id);
  if(!h?.paid&&!h?.shipped&&!h?.qualified&&!stageMap.has(String(d.STAGE_ID||"")))continue;
  const current=reconciliation.byDeal.get(id);
  if(current?.linkVerified&&/domain/.test(current.linkSource))continue;
  requested.push(id);
 }
 const result={status:"not_started",qualifyingUnlinkedDeals:requested.length,checked:0,domainConfirmed:0,conflicts:0,failed:0};
 const limit=1200;
 for(let i=0;i<Math.min(requested.length,limit);i+=3){
  const chunk=requested.slice(i,i+3);
  const outputs=await Promise.all(chunk.map(async id=>{
   try{
    const resp=await call("crm.activity.list",{order:{ID:"DESC"},
     filter:{OWNER_TYPE_ID:2,OWNER_ID:Number(id)},
     select:["ID","TYPE_ID","PROVIDER_ID","COMMUNICATIONS"],start:0});
    return {id,items:Array.isArray(resp.result)?resp.result:[]};
   }catch{return{id,items:null}}
  }));
  for(const o of outputs){
   result.checked++;
   if(o.items===null){result.failed++;continue}
   const domains=new Set();
   for(const a of o.items){
    if(String(a.TYPE_ID||"")!=="4"&&String(a.PROVIDER_ID||"").toUpperCase()!=="CRM_EMAIL")continue;
    for(const c of Array.isArray(a.COMMUNICATIONS)?a.COMMUNICATIONS:[])
     for(const owner of emailCandidates([c.VALUE||""],reconciliation.idx))domains.add(owner);
   }
   if(domains.size!==1){if(domains.size>1)result.conflicts++;continue}
   const owner=[...domains][0];
   const prior=reconciliation.byDeal.get(o.id),deal=deals.get(o.id);
   if(prior&&prior.companyId!==owner){
    reconciliation.byDeal.delete(o.id);result.conflicts++;continue;
   }
   reconciliation.byDeal.set(o.id,{dealId:o.id,companyId:owner,
    linkSource:"deal_email_corporate_domain",linkVerified:true,
    originalCompanyId:"",title:String(deal?.TITLE||"").slice(0,180)});
   result.domainConfirmed++;
  }
  if(i%75===0)await new Promise(done=>setTimeout(done,250));
 }
 reconciliation.candidates=[...reconciliation.byDeal.values()];
 result.status=result.failed?"partial_errors":requested.length>limit?"partial_limit":"complete";
 console.log(JSON.stringify({component:"crm-orphan-deals",event:"qualifying-deal-email-audit",...result}));
 return result;
}
// Read inbound/outbound CRM email activities attached to deals. This recovers
// deals with generic titles that still contain a unique customer email domain.
// Completeness is surfaced; partial scans must never imply no deal exists.
async function scanEmailActivities(deals,reconciliation,call){
 const maxActivities=15000;
 const filter={TYPE_ID:4,BINDINGS:[{OWNER_TYPE_ID:2}]};
 const baseParams={order:{ID:"DESC"},filter,
  select:["ID","OWNER_ID","OWNER_TYPE_ID","TYPE_ID","PROVIDER_ID","DIRECTION","COMMUNICATIONS","BINDINGS"]};
 const out={status:"not_started",scannedActivities:0,totalActivities:0,domainLinkedDeals:0,verifiedTitleDeals:0,conflictingEvidence:0,failedPages:0};
 let first;
 try{first=await call("crm.activity.list",{...baseParams,start:0})}
 catch(err){out.status="activity_filter_unavailable";return out}
 const rows=Array.isArray(first.result)?first.result:[];
 const total=Number(first.total||rows.length);
 out.totalActivities=total;
 const bucket=new Map();
 function handle(a){
  out.scannedActivities++;
  if(String(a.TYPE_ID||"")!=="4"&&String(a.PROVIDER_ID||"").toUpperCase()!=="CRM_EMAIL")return;
  const bindingIds=[];
  if(Number(a.OWNER_TYPE_ID)===2)bindingIds.push(String(a.OWNER_ID||""));
  for(const b of Array.isArray(a.BINDINGS)?a.BINDINGS:[])
   if(Number(b.OWNER_TYPE_ID)===2)bindingIds.push(String(b.OWNER_ID||""));
  if(!bindingIds.length)return;
  const communications=Array.isArray(a.COMMUNICATIONS)?a.COMMUNICATIONS:[];
  const ids=emailCandidates(communications.map(c=>c.VALUE||""),reconciliation.idx);
  if(ids.length!==1)return;
  for(const id of new Set(bindingIds)){
   const d=deals.get(id);if(!d||String(d.COMPANY_ID||"")!=="0"&&String(d.COMPANY_ID||"")!=="")continue;
   if(!bucket.has(id))bucket.set(id,new Set());
   bucket.get(id).add(ids[0]);
  }
 }
 rows.forEach(handle);
 if(total>rows.length){
  const size=Math.max(1,rows.length||50),last=Math.min(total,maxActivities),starts=[];
  for(let i=size;i<last;i+=size)starts.push(i);
  for(let i=0;i<starts.length;i+=3){
   const parts=await Promise.all(starts.slice(i,i+3).map(async start=>{
    try{return await call("crm.activity.list",{...baseParams,start})}catch{return null}
   }));
   for(const p of parts)if(!p||!Array.isArray(p.result))out.failedPages++;
   else p.result.forEach(handle);
   if(i%42===0)console.log(JSON.stringify({component:"crm-orphan-deals",event:"correspondence-progress",scanned:out.scannedActivities,total:out.totalActivities,errors:out.failedPages}));
   if(i%48===0)await new Promise(resolve=>setTimeout(resolve,180));
  }
 }
 for(const [dealId,companySet] of bucket){
  if(companySet.size!==1){out.conflictingEvidence++;continue}
  const companyId=[...companySet][0],old=reconciliation.byDeal.get(dealId);
  if(old){
   if(old.companyId!==companyId){
    reconciliation.byDeal.delete(dealId);
    out.conflictingEvidence++;
   }else{
    old.linkVerified=true;old.linkSource="deal_email_corporate_domain_plus_title";
    out.verifiedTitleDeals++;
   }
  }else{
   const deal=deals.get(dealId);
   reconciliation.byDeal.set(dealId,{
    dealId,companyId,linkSource:"deal_email_corporate_domain",linkVerified:true,
    originalCompanyId:"",title:String(deal?.TITLE||"").slice(0,180)
   });
   out.domainLinkedDeals++;
  }
 }
 reconciliation.candidates=[...reconciliation.byDeal.values()];
 out.status=out.failedPages?"partial_errors":out.scannedActivities>=total?"complete":"partial_limit";
 stats.matchedByDomain=out.domainLinkedDeals;
 stats.emailOwnerMatches=out.verifiedTitleDeals;
 stats.emailsInspected=out.scannedActivities;
 return out;
}

module.exports={verifyRelevantDealEmails,fetchContactIndex,scanEmailActivities,reconcile,indexCompanies,indexContacts,resolveDeal,lookupDealEmailEvidence,stats,norm,stripped,emailCandidates,titleCandidates};
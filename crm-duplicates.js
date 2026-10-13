"use strict";
// Reporting-only grouping. Never modifies CRM company IDs or legal ownership.
// Multiple CRM cards remain accessible independently in the manual merge list.
const {display}=require("./company-name-format");
function normalize(s){return String(s||"").toLocaleLowerCase("ru-RU").replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"")}
const blank=s=>String(s||"").trim();
const distinct=a=>[...new Set(a.filter(Boolean))];
function identity(c){
 const d=display(c.name),opf=d.opf||"";
 const base=opf?d.name.slice(0,-(opf.length+2)):d.name;
 return {display:d.name,base:normalize(base),opf};
}
// Expand common industry acronyms ONLY when checking a shared corporate domain.
// Never merge dissimilar entities by domain alone.
function aliasBase(base){
 const b=String(base||"");
 return b
  .replace(/^инженернотехническ(?:ий|ого|ая)центр/,"итц")
  .replace(/^научнотехническ(?:ий|ого|ая)центр/,"нтц")
  .replace(/^научнопроизводственн(?:ое|ого|ая)предприятие/,"нпп")
  .replace(/^научнопроизводственн(?:ый|ого|ая)центр/,"нпц")
  .replace(/^производственнокоммерческ(?:ая|ой)фирма/,"пкф")
  .replace(/^торговыйдом/,"тд");
}
function domain(value){
 const raw=String(value||"").toLowerCase();
 try{return new URL(raw.includes("://")?raw:"https://"+raw).hostname.replace(/^www\./,"")}catch{return""}
}
function emailDomains(c){
 const out=[];
 for(const e of [...(c.crmEmails||[]),...(c.contactEmails||[])]){
  const s=String(e||"").trim().toLowerCase(),i=s.lastIndexOf("@");
  if(i>0)out.push(s.slice(i+1));
 }
 return distinct(out).filter(x=>x&&!/^(?:gmail\.com|mail\.ru|ya\.ru|yandex\.ru|list\.ru|bk\.ru|outlook\.com|rambler\.ru)$/i.test(x));
}
function identifiers(c){
 const v=[domain(c.siteCandidate),domain(c.siteVerified),domain(c.siteProfileUrl),blank(c.corporateDomain).toLowerCase(),...emailDomains(c)];
 return distinct(v.filter(x=>x.includes(".")));
}
function phones(c){
 return distinct([...(c.crmPhones||[]),...(c.contactPhones||[])]
  .map(v=>String(v||"").replace(/\D/g,""))
  .filter(v=>v.length>=10).map(v=>v.slice(-10)));
}
function links(c){
 return {id:c.id,name:display(c.name).name,crmUrl:c.crmUrl,
  hasEmail:distinct([...(c.crmEmails||[]),...(c.contactEmails||[])]).length>0,
  saleStatus:c.saleInfo?.purchaseStatus||"ПРОВЕРЯЕТСЯ",
  type:c.organizationType||c.type||"",
  source:c.verifiedOrgEvidence||c.segmentSource||""};
}
function isPositive(x){return String(x?.purchaseStatus||"").startsWith("БЫЛА")}
function isNegative(x){return /^(?:НЕ БЫЛО|НЕ НАЙДЕНО)/.test(String(x?.purchaseStatus||""))}
function combineSale(members){
 const sales=members.map(c=>c.saleInfo||{});
 const yes=sales.filter(isPositive),negative=sales.every(isNegative);
 const status=yes.length?"БЫЛА":negative?"НЕ БЫЛО":"ПРОВЕРЯЕТСЯ";
 const productNames=distinct(sales.flatMap(s=>s.purchaseItems||[]).map(blank));
 const purchaseDeals=members.flatMap(c=>(c.saleInfo?.purchaseDeals||[]).map(d=>({...d,crmCompanyId:String(c.id)}))).slice(0,55);
 const linkedDeals=members.flatMap(c=>(c.saleInfo?.linkedDeals||[]).map(d=>({...d,sourceCrmCompanyId:String(c.id)}))).slice(0,140);
 const involved=yes;
 const usable=involved.length>0&&involved.every(s=>Number.isFinite(s.purchaseAmount)&&s.purchaseCurrency);
 const currencies=distinct(involved.map(s=>s.purchaseCurrency));
 const amount=usable&&currencies.length===1?involved.reduce((a,s)=>a+Number(s.purchaseAmount),0):null;
 return {purchaseStatus:status,shipped:sales.some(s=>Boolean(s.shipped)),paid:sales.some(s=>Boolean(s.paid)),
  purchaseItems:productNames,purchaseDeals,linkedDeals,purchaseAmount:amount,purchaseCurrency:amount===null?"":currencies[0],
  purchaseDealCount:sales.reduce((a,s)=>a+Number(s.purchaseDealCount||0),0),
  purchaseBasis:"Виртуально сведены отдельные CRM-карточки. Документальные суммы суммируются только если подтверждены для всех карточек с покупкой.",
  mergedCrmIds:members.map(x=>String(x.id)),
  amountStatus:amount===null?"Не все суммы подтверждены документами":"Суммы по документам всех карточек с покупкой"};
}
function merge(members,certainty){
 const sorted=[...members].sort((a,b)=>Number(a.id)-Number(b.id));
 const lead=[...sorted].sort((a,b)=>{
  const score=x=>10*Number(Boolean(x.verifiedOrgType))+4*Number(Boolean(x.siteProfileUrl||x.siteCandidate))+3*Number(Boolean(identity(x).opf))
   +2*Number(Boolean(x.organizationType||x.type))+Number((x.crmEmails||[]).length>0);
  return score(b)-score(a)||Number(a.id)-Number(b.id);
 })[0];
 const websites=distinct(sorted.map(c=>c.siteProfileUrl||c.siteCandidate||"").filter(Boolean));
 const types=distinct(sorted.map(c=>c.organizationType||c.type||"").filter(Boolean));
 const category=lead.category||"Не определены";
 const rawEmails=distinct(sorted.flatMap(c=>[...(c.crmEmails||[]),...(c.contactEmails||[])])
  .map(v=>String(v||"").trim().toLowerCase()));
 const contacts=distinct(sorted.flatMap(c=>c.contactNames||[]).map(blank));
 const reviewed=sorted.every(c=>Boolean(c.verifiedOrgType))&&websites.length===1;
 const groupId="G-"+sorted.map(c=>c.id).join("-");
 return {
  ...lead,id:groupId,name:display(lead.name).name,
  sourceCrmId:lead.id,crmUrl:lead.crmUrl,
  crmEmails:rawEmails,contactEmails:[],contactNames:contacts,
  siteProfileUrl:lead.siteProfileUrl||websites[0]||"",
  organizationType:types.length===1?types[0]:lead.organizationType||"",
  segmentConfidence:types.length>1?"Есть расхождения типов в CRM":lead.segmentConfidence||"",
  category,
  saleInfo:combineSale(sorted),finance2025:require("./financial-2025").forGroup(sorted),mergedCrmCards:sorted.map(links),memberCount:sorted.length,
  duplicateStatus:reviewed?"Найдено совпадение названия и официального сайта":"Объединено только в аналитике по точному имени и ОПФ; проверить юридическое совпадение",
  duplicateConfidence:certainty,
  duplicateGroupId:groupId,
  crmIdList:sorted.map(c=>String(c.id))
 };
}
function consolidate(companies){
 const rows=(companies||[]).filter(c=>c&&c.id);
 const byExact=new Map(),byBase=new Map();
 for(const c of rows){
  const id=identity(c);
  if(id.base.length<3||/^(?:безназвания|неизвестно|нетназвания|неназвано|безимени|неопределено|тест|названиенетуказано)$/i.test(id.base))continue;
  if(!byBase.has(id.base))byBase.set(id.base,[]);
  byBase.get(id.base).push(c);
  if(!id.opf||id.base.length<7)continue;
  const k=id.base+"|"+id.opf;
  if(!byExact.has(k))byExact.set(k,[]);
  byExact.get(k).push(c);
 }
 const accepted=[],review=[],claimed=new Set();
 for(const set of byExact.values()){
  if(set.length<2)continue;
  // Exact name+legal form: reversible grouping in reporting only.
  // Conflicting known corporate domains prevent consolidation.
  const anchors=set.map(identifiers).filter(a=>a.length).flat();
  const explicitDomains=distinct(anchors);
  const verified=new Set(set.map(x=>domain(x.siteProfileUrl||x.siteCandidate||"")).filter(Boolean));
  const siteConflict=verified.size>1;
  const emailOnlyConflict=explicitDomains.length>1&&set.every(c=>identifiers(c).length>0)
    &&!set.some(c=>c.verifiedOrgType);
  const legalInn=distinct(set.map(c=>String(c.finance2025?.inn||c.crmInn||"").replace(/\D/g,"")).filter(v=>v.length===10||v.length===12));
  const legalConflict=legalInn.length>1;
  const conf=siteConflict||emailOnlyConflict||legalConflict?"review":"exact_name_opf";
  if(conf==="review"){
   review.push({id:"R-"+set.map(c=>c.id).join("-"),
    name:display(set[0].name).name,reason:legalConflict?"Название и ОПФ совпадают, но ИНН разные — юридические лица не объединены":"Название и ОПФ совпадают, но сайты или домены расходятся",
    members:set.map(links),count:set.length});
   continue;
  }
  const combined=merge(set,conf);
  accepted.push(combined);
  for(const c of set)claimed.add(String(c.id));
 }

 // The same legal name is often recorded with and without ООО/АО. If their
 // corporate domain also matches, use one reversible analytical card.
 // Never merge different known legal forms or distinct legal INNs.
 function identityDomain(c){
  const corporate=distinct([blank(c.corporateDomain).toLowerCase(),...[...(c.crmEmails||[]),...(c.contactEmails||[])].map(e=>{
   const m=String(e||"").toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/);
   return m?m[1]:"";
  }),domain(c.siteCandidate||"")]).filter(d=>d&&d.includes("."));
  const publicMail=/^(?:gmail\.com|mail\.ru|bk\.ru|inbox\.ru|yandex\.ru|ya\.ru|rambler\.ru|outlook\.com|yahoo\.com|hotmail\.com|icloud\.com|topsense\.su|detector-gaza\.ru)$/;
  return corporate.filter(d=>!publicMail.test(d));
 }
 const domainSameBase=new Map();
 for(const c of rows){
  if(claimed.has(String(c.id)))continue;
  const ident=identity(c);
  if(ident.base.length<3||/^(?:безназвания|неизвестно|нетназвания|тест)$/.test(ident.base))continue;
  for(const d of identityDomain(c)){
   const key=aliasBase(ident.base)+"|"+d;
   if(!domainSameBase.has(key))domainSameBase.set(key,[]);
   domainSameBase.get(key).push(c);
  }
 }
 const domainClusters=[...domainSameBase].filter(([key,x])=>x.length>1).sort((a,b)=>b[1].length-a[1].length);
 for(const [key,set] of domainClusters){
  const rest=set.filter(c=>!claimed.has(String(c.id)));
  if(rest.length<2)continue;
  const forms=distinct(rest.map(c=>identity(c).opf).filter(Boolean));
  const inns=distinct(rest.map(c=>String(c.finance2025?.inn||c.crmInn||"").replace(/\D/g,"")).filter(x=>x.length===10||x.length===12));
  if(forms.length>1||inns.length>1){
   review.push({id:"R-domain-"+rest.map(x=>x.id).join("-"),name:display(rest[0].name).name,
    reason:"Совпадает наименование и домен, но конфликтуют ОПФ или ИНН — не объединено",
    members:rest.map(links),count:rest.length});
   continue;
  }
  const group=merge(rest,"matching_corporate_domain_and_name");
  group.duplicateStatus="Совпадают корпоративный домен и нормализованное название (включая ИТЦ/инженерно-технический центр); юридическая сверка перед объединением в Bitrix24";
  accepted.push(group);
  for(const c of rest)claimed.add(String(c.id));
 }

 // Fall back to a distinctive exact company name when neither record has a
 // usable corporate domain. One card may omit its legal form. Virtual only.
 // Require long names and no conflicting known INNs, domains or OPFs.
 for(const set of byBase.values()){
  const remaining=set.filter(c=>!claimed.has(String(c.id)));
  if(remaining.length<2)continue;
  const ident=identity(remaining[0]);
  const phonesets=remaining.map(phones).filter(a=>a.length);
  const overlap=distinct(phonesets.flat()).some(p=>phonesets.length>=2&&phonesets.every(a=>a.includes(p)));
  if(ident.base.length<9&&!overlap)continue;
  const forms=distinct(remaining.map(c=>identity(c).opf).filter(Boolean));
  if(forms.length>1)continue;
  const inns=distinct(remaining.map(c=>String(c.finance2025?.inn||c.crmInn||"").replace(/\D/g,"")).filter(v=>v.length===10||v.length===12));
  if(inns.length>1)continue;
  const sites=distinct(remaining.flatMap(c=>identityDomain(c)));
  if(ident.base.length<9&&sites.length===0&&!overlap)continue;
  if(sites.length>1)continue; // Different corporate identities.
  // If there are multiple cards and no independent evidence, grouping remains
  // expressly preliminary, never proof that the legal entities are identical.
  const merged=merge(remaining,sites.length?"exact_name_domain":overlap?"exact_name_matching_phone":"exact_distinctive_name_provisional");
  merged.duplicateStatus=sites.length
   ?"Совпадают полное наименование и домен; объединено в аналитике"
   :overlap?"Совпадают название и контактный телефон; аналитическое объединение, юридическая сверка необходима"
   :"Совпадает полное отличительное название; ОПФ отсутствует в части карточек или домен не указан. Юридическую идентичность проверить при слиянии в CRM";
  merged.segmentConfidence=sites.length?merged.segmentConfidence:"Предварительная виртуальная группа";
  accepted.push(merged);
  remaining.forEach(c=>claimed.add(String(c.id)));
 }
 // Same organization label with different legal forms or a missing legal form:
 // put on the review list, DO NOT merge contacts or deals.
 for(const set of byBase.values()){
  if(set.length<2)continue;
  const residual=set.filter(c=>!claimed.has(String(c.id)));
  if(residual.length<2)continue;
  // Very short matching labels without shared corporate evidence are not enough
  // to call separate CRM cards duplicates or burden the manual review queue.
  if(identity(residual[0]).base.length<7)continue;
  if(review.some(g=>g.members.some(c=>residual.some(x=>String(x.id)===String(c.id)))))continue;
  review.push({id:"R-"+residual.map(c=>c.id).join("-"),
   name:display(residual[0].name).name,
   reason:"Совпало название; ОПФ отличается или не указана — необходима ручная проверка",
   members:residual.map(links),count:residual.length});
 }

 // One corporate domain can serve many legal entities (e.g. group companies).
 // Surface such cases for the user's manual review, NEVER merge different names.
 const sharedDomain=new Map();
 for(const c of rows){
  if(claimed.has(String(c.id)))continue;
  for(const d of identityDomain(c)){
   if(!sharedDomain.has(d))sharedDomain.set(d,[]);
   sharedDomain.get(d).push(c);
  }
 }
 for(const [d,items] of sharedDomain){
  if(items.length<2)continue;
  const cores=new Set(items.map(c=>aliasBase(identity(c).base)));
  if(cores.size<2)continue; // Same normalized company: handled above.
  const unreviewed=items.filter(c=>!review.some(g=>g.members.some(m=>String(m.id)===String(c.id))));
  if(unreviewed.length<2)continue;
  review.push({id:"R-shared-domain-"+d,name:"Общий домен: "+d,
   reason:"Один корпоративный домен у компаний с разными названиями. Это могут быть отдельные юрлица или карточки с ошибочным названием; контакты и сделки не объединены",
   members:unreviewed.map(links),count:unreviewed.length,sharedDomain:d});
 }
 // A pair can initially enter manual review and later be consolidated using
 // better evidence (shared domain, phone, full name). Never show it twice.
 const finalReview=review.map(group=>{
  const members=group.members.filter(c=>!claimed.has(String(c.id)));
  return {...group,members,count:members.length};
 }).filter(group=>group.members.length>=2);
 // If any CRM record is still duplicated between analytical rows, report it.
 const sourceIds=[...rows.filter(c=>!claimed.has(String(c.id))).map(c=>String(c.id)),
  ...accepted.flatMap(g=>g.crmIdList||[])];
 const integrityOK=sourceIds.length===rows.length&&new Set(sourceIds).size===rows.length;
 if(!integrityOK)console.warn(JSON.stringify({component:"crm-duplicates",event:"group-integrity-check-failed",raw:rows.length,seen:sourceIds.length,unique:new Set(sourceIds).size}));
 const leftover=rows.filter(c=>!claimed.has(String(c.id)));
 const possible=new Map();
 for(const c of leftover){
  const ident=identity(c);
  if(ident.base.length<7)continue;
  const key=aliasBase(ident.base);
  if(!possible.has(key))possible.set(key,[]);
  possible.get(key).push(c);
 }
 let unresolvedExactNameGroups=0,unresolvedDomainNameGroups=0;
 for(const cluster of possible.values()){
  if(cluster.length<2)continue;
  unresolvedExactNameGroups++;
  const domains=cluster.map(c=>new Set(identityDomain(c)));
  if(domains.some((set,i)=>domains.some((other,j)=>i<j&&[...set].some(d=>other.has(d)))))
   unresolvedDomainNameGroups++;
 }
 const all=[...rows.filter(c=>!claimed.has(String(c.id))),...accepted]
  .sort((a,b)=>{
    const an=display(a.name).name,bn=display(b.name).name;
    return an.localeCompare(bn,"ru")||String(a.id).localeCompare(String(b.id),"ru");
  });
 const groups=accepted.map(x=>({id:x.duplicateGroupId,name:x.name,count:x.memberCount,
  reason:x.duplicateStatus,confidence:x.duplicateConfidence,members:x.mergedCrmCards,
  saleInfo:x.saleInfo,crmEmails:x.crmEmails,contactNames:x.contactNames,
  crmUrl:x.crmUrl,virtualCardId:x.id,website:x.siteProfileUrl||"",
  clientType:x.organizationType||""})).sort((a,b)=>a.name.localeCompare(b.name,"ru"));
 return {companies:all,duplicates:groups,review:finalReview,stats:{
  rawCompanyCount:rows.length,customerCardCount:all.length,
  groupedCount:groups.length,groupedCrmCardCount:claimed.size,
  reviewGroupCount:finalReview.length,
  reviewCrmCardCount:distinct(finalReview.flatMap(g=>g.members.map(m=>m.id))).length,
  unresolvedExactNameGroups,unresolvedDomainNameGroups,
  duplicateCoverageValidated:integrityOK}};
}
module.exports={consolidate,identity,combineSale};

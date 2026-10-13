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
  const score=x=>10*Number(Boolean(x.verifiedOrgType))+4*Number(Boolean(x.siteProfileUrl||x.siteCandidate))
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
  if(id.base.length<7||/^(?:безназвания|неизвестно|нетназвания|неназвано|безимени|неопределено|тест|названиенетуказано)$/i.test(id.base))continue;
  if(!byBase.has(id.base))byBase.set(id.base,[]);
  byBase.get(id.base).push(c);
  if(!id.opf)continue;
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
  const conf=siteConflict||emailOnlyConflict?"review":"exact_name_opf";
  if(conf==="review"){
   review.push({id:"R-"+set.map(c=>c.id).join("-"),
    name:display(set[0].name).name,reason:"Название и ОПФ совпадают, но сайты или домены расходятся",
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
  const corporate=distinct([blank(c.corporateDomain).toLowerCase(),...(c.crmEmails||[]).map(e=>{
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
  if(ident.base.length<5||/^(?:безназвания|неизвестно|нетназвания)$/.test(ident.base))continue;
  for(const d of identityDomain(c)){
   const key=ident.base+"|"+d;
   if(!domainSameBase.has(key))domainSameBase.set(key,[]);
   domainSameBase.get(key).push(c);
  }
 }
 const domainClusters=[...domainSameBase].filter(([key,x])=>x.length>1).sort((a,b)=>b[1].length-a[1].length);
 for(const [key,set] of domainClusters){
  const rest=set.filter(c=>!claimed.has(String(c.id)));
  if(rest.length<2)continue;
  const forms=distinct(rest.map(c=>identity(c).opf));
  const inns=distinct(rest.map(c=>String(c.finance2025?.inn||c.crmInn||"").replace(/\D/g,"")).filter(x=>x.length===10||x.length===12));
  if(forms.length>1||inns.length>1){
   review.push({id:"R-domain-"+rest.map(x=>x.id).join("-"),name:display(rest[0].name).name,
    reason:"Совпадает наименование и домен, но конфликтуют ОПФ или ИНН — не объединено",
    members:rest.map(links),count:rest.length});
   continue;
  }
  const group=merge(rest,"matching_corporate_domain_and_name");
  group.duplicateStatus="Совпадают нормализованное название и корпоративный домен; юридическая сверка перед объединением в Bitrix24";
  accepted.push(group);
  for(const c of rest)claimed.add(String(c.id));
 }
 // Same organization label with different legal forms or a missing legal form:
 // put on the review list, DO NOT merge contacts or deals.
 for(const set of byBase.values()){
  if(set.length<2)continue;
  const residual=set.filter(c=>!claimed.has(String(c.id)));
  if(residual.length<2)continue;
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
  const cores=new Set(items.map(c=>identity(c).base));
  if(cores.size<2)continue; // Same normalized company: handled above.
  const unreviewed=items.filter(c=>!review.some(g=>g.members.some(m=>String(m.id)===String(c.id))));
  if(unreviewed.length<2)continue;
  review.push({id:"R-shared-domain-"+d,name:"Общий домен: "+d,
   reason:"Один корпоративный домен у компаний с разными названиями. Это могут быть отдельные юрлица или карточки с ошибочным названием; контакты и сделки не объединены",
   members:unreviewed.map(links),count:unreviewed.length,sharedDomain:d});
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
 return {companies:all,duplicates:groups,review,stats:{
  rawCompanyCount:rows.length,customerCardCount:all.length,
  groupedCount:groups.length,groupedCrmCardCount:claimed.size,
  reviewGroupCount:review.length,
  reviewCrmCardCount:distinct(review.flatMap(g=>g.members.map(m=>m.id))).length}};
}
module.exports={consolidate,identity,combineSale};

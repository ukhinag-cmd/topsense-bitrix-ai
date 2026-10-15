"use strict";
// Analytical organizations recovered from CRM DEALS, not from the unreliable
// manager-created CRM company cards. Read-only: no crm.company.add or merges.
// These evidence-backed identity candidates are never legal-identity proof.
const {display}=require("./company-name-format");
const entities=[
 {key:"automation-security-samara",name:"ООО «Автоматизация и Безопасность»",
  type:"Дилер промышленного оборудования",category:"Партнёрские продажи",
  match:/автоматизац(?:ия|ии)\s+и\s+безопасност(?:ь|и)/iu,
  websiteCandidate:"https://avbez.ru/",websiteStatus:"Домен найден в переписке; сайт/реквизиты ещё сверяются",
  userRelationship:"Постоянный клиент — подтверждено пользователем",
  note:"Тендерные и прямые запросы; статус поставки и юрлицо каждого обращения сверяются"},
 {key:"acron-fertilizers",name:"ПАО «Акрон»",type:"Производство удобрений",
  category:"Конечные потребители",
  match:/пао\s*["«»]?\s*акрон(?=$|[^а-яёa-z0-9])/iu,
  websiteCandidate:"https://www.acron.ru/",
  websiteStatus:"Официальный сайт ПАО «Акрон»; связь сделки с юрлицом требует проверки",
  note:"Минеральные удобрения. Не путать с «Акрон Холдинг»"},
 {key:"akron-industrial-holding",name:"ГК «Акрон Холдинг»",type:"",
  category:"Смежные организации",
  match:/(?:^|[^а-яёa-z0-9])(?:гк\s*)?акрон\s+холдинг(?=$|[^а-яёa-z0-9])/iu,
  websiteCandidate:"https://www.akron-holding.ru/",
  websiteStatus:"Официальный сайт другой группы, не ПАО «Акрон»",
  note:"Отдельная промышленная группа; запросы не приписывать ПАО «Акрон»"}
];
let snapshot=new Map(),updatedAt=null,coverage="not_started";
function norm(s){const d=display(s||"");return String(d.name||"").toLocaleLowerCase("ru-RU")
 .replace(/ё/g,"е").replace(/(?:,?\s*(?:ооо|оао|зао|ао|пао|гк)\s*)$/u,"").replace(/^(?:ооо|оао|зао|ао|пао|гк)\s+/u,"")
 .replace(/[^а-яa-z0-9]/g,"")}
function identify(title){
 const value=String(title||"");
 const found=entities.filter(e=>e.match.test(value));
 return found.length===1?found[0]:null;
}
function ingest(deals,{complete=false}={}){
 const incoming=deals instanceof Map?[...deals.values()]:Array.from(deals||[]);
 if(complete)snapshot=new Map();
 for(const deal of incoming){
  const id=String(deal?.ID||""),title=String(deal?.TITLE||"");
  if(!/^[1-9]\d*$/.test(id)||!title)continue;
  const entity=identify(title);
  if(!entity)continue;
  // If the CRM has a direct company ID, it should appear through the normal
  // company registry; no synthetic entity is created from that single deal.
  const otherParty=/сверк[аи]\s+по\s+взаиморасчет/i.test(title);
  snapshot.set(id,{id,entityKey:entity.key,title:title.slice(0,280),
   crmCompanyId:String(deal.COMPANY_ID||""),
   contactId:String(deal.CONTACT_ID||""),
   createdAt:String(deal.DATE_CREATE||""),
   stageId:String(deal.STAGE_ID||""),otherParty,
   url:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(id)+"/"});
 }
 coverage=complete?"full_deal_snapshot":coverage==="full_deal_snapshot"?coverage:"partial_deal_snapshot";
 updatedAt=new Date().toISOString();
 return stats();
}
function view(companies){
 const legalIds=new Set((companies||[]).flatMap(c=>(c.crmIdList||[c.id]).map(String)));
 const names=new Set((companies||[]).map(c=>norm(c.name)));
 const groups=[];
 for(const entity of entities){
  const items=[...snapshot.values()].filter(d=>d.entityKey===entity.key)
    .sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
  if(!items.length)continue;
  // Do not duplicate a real corresponding CRM company card.
  if(names.has(norm(entity.name)))continue;
  const relevant=items.filter(d=>!d.crmCompanyId||d.crmCompanyId==="0"||!legalIds.has(d.crmCompanyId));
  if(!relevant.length)continue;
  const dealRefs=relevant.map(d=>({id:d.id,title:d.title,url:d.url,createdAt:d.createdAt,
   directCompanyLink:Boolean(d.crmCompanyId&&d.crmCompanyId!=="0"),
   relationshipEvidence:d.otherParty?"упоминание в переписке":"название в сделке"}));
  groups.push({id:"dealonly:"+entity.key,name:entity.name,organizationType:entity.type,
   category:entity.category,companyCardMissing:true,sourceType:"crm_deals_only",
   crmIdList:[],crmUrl:"",dealRefs,crmDealCount:dealRefs.length,
   siteCandidate:entity.websiteCandidate,siteCandidateStatus:entity.websiteStatus,
   crmEmails:[],contactEmails:[],contactNames:[],
   relationStatus:entity.userRelationship||"",
   salesEvidenceStatus:"Покупки/отгрузки не подтверждены этим реестром",
   saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ",purchaseItems:[],purchaseDealCount:0},
   relationshipPotential:{status:"pending_reconciliation",level:entity.userRelationship?
    "Высокий — постоянный клиент (со слов пользователя)":"Требует оценки",
    dealCount:dealRefs.length,score:null,userConfirmed:Boolean(entity.userRelationship)},
   evidenceNote:entity.note});
 }
 // Generalizable discovery across ALL CRM deals, beyond the three
 // initially recovered customers. Keep unmatched title-only groups provisional.
 const crawler=require("./crm-unlinked-discovery");
 const alreadyNamed=new Set(entities.map(e=>crawler.normalize(e.name)));
 for(const found of crawler.group(companies)){
  if(found.linkedExisting||alreadyNamed.has(found.key))continue;
  groups.push({id:"dealonly:discovered:"+found.key,name:found.name,
   organizationType:"",category:"Не определены",companyCardMissing:true,
   sourceType:"crm_unlinked_deal_titles",
   candidateReview:true,identityConfidence:found.confidence,
   crmIdList:[],crmUrl:"",dealRefs:found.dealRefs.slice(0,30),
   crmDealCount:found.dealCount,siteCandidate:"",crmEmails:[],
   contactEmails:[],contactNames:[],evidenceNote:
    "Восстановлено из повторяющихся названий в сделках без компании. Для подтверждения нужны исходные письма, адреса, реквизиты и история.",
   relationStatus:"Кандидат на идентификацию — не подтверждённая юридическая связь",
   saleInfo:{purchaseStatus:"ПРОВЕРЯЕТСЯ",purchaseItems:[],purchaseDealCount:0},
   relationshipPotential:{status:"pending_reconciliation",level:"Требует оценки",
    dealCount:found.dealCount,score:null,userConfirmed:false}});
 }
 const intake=require("./crm-deal-intake");
 for(const client of groups){
  let inspected=0;
  for(const ref of client.dealRefs||[]){
   const evidence=intake.get(ref.id);
   if(!evidence)continue;
   inspected++;
   ref.emailAnalysis={
    firstIncomingAt:evidence.firstIncomingAt||"",
    incomingEmails:Number(evidence.incomingEmails||0),
    subsequentIncomingEmails:Number(evidence.subsequentIncomingEmails||0),
    attachmentCount:Number(evidence.attachmentCount||0),
    documentClues:Number(evidence.companyCardAttachmentCount||0),
    incomplete:Boolean(evidence.correspondencePartial)
   };
  }
  client.emailAnalysedDeals=inspected;
  const naming=require("./client-canonical-name");
  const ledger=require("./deal-only-name-ledger");
  const evidence=naming.fromIntake(client.dealRefs,id=>intake.get(id));
  const revised=naming.resolve(client,evidence);
  const upgraded=ledger.apply(revised);
  // Keep the same stable synthetic ID even after the legal name changes.
  ledger.offer(upgraded);
  Object.assign(client,upgraded);
 }
 const siteResearch=require("./deal-only-site-research");
 // Gradual bounded research. Each pass can discover new public sites,
 // without interfering with the main Bitrix24 company site queue.
 siteResearch.enqueue(groups,{read:id=>intake.get(id),limit:16});
 for(const c of groups)Object.assign(c,siteResearch.enrich(c,id=>intake.get(id)));
 return groups;
}
function stats(){return {status:coverage,updatedAt,matchedDeals:snapshot.size,
  uniqueCandidates:new Set([...snapshot.values()].map(d=>d.entityKey)).size}}
module.exports={ingest,view,stats,identify,norm};

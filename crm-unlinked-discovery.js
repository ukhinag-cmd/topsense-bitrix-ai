"use strict";
// Full-history read-only inventory for deals that have no CRM company link.
// Name fragments are CANDIDATES, not established legal identity; preserve
// every original deal ID. A group or holding name is never its subsidiaries.
const {display}=require("./company-name-format");
const legal="ООО|ПАО|ОАО|АО|ЗАО|НАО|ИП|ТОО";
const generic=/^(?:запрос|заявка|стоимость|ремонт|поверка|газоанализатор|газосигнализатор|топ.?сенс|оборудование|зип|счет|оплата|переписка|без названия|поставка|предложение|автоматическая|коммерческое предложение|входящее|письмо|договор|fw|re|fwd|тест)$/iu;
const technical=/(?:^|\s)(?:тс[- ]?\d|топ[- ]?сенс|запрос|тендер|газоанализ|поставка|ремонт|счет|счёт|замена|закупка|кп|уточнение|коммерческое|стандарт|зип|датчик|сенсор|поверка|письмо|вопрос|для\s+тендера)\b/iu;
const safe=str=>String(str??"").replace(/ё/gi,"е").toLocaleLowerCase("ru-RU")
 .replace(/[«»“”"]/g,"").replace(/[^а-яa-z0-9]+/g," ").trim().replace(/\s+/g," ");
const normalize=raw=>{
 const d=display(raw||"");
 return safe(d.name.replace(/,\s*(?:ООО|ПАО|ОАО|АО|ЗАО|НАО|ИП|ТОО)$/iu,""));
};
function acceptable(name,hasLegalForm=false){
 const n=normalize(name);
 // Short legal brand + distinguishing number is valid (ИС-16, ГСП-7).
 const shortLegal=hasLegalForm&&n.length>=4&&/\d/.test(n)&&/[а-яa-z]/i.test(n);
 return (n.length>=7||shortLegal)&&n.length<=90&&!generic.test(n)&&
  (n.split(" ").some(w=>w.length>=4)||shortLegal)&&!/^\d+$/.test(n);
}
function clean(raw){
 return String(raw||"").trim()
 .replace(/^[«"“'\s]+|[»"”'\s]+$/gu,"")
 .replace(/\s{2,}/g," ")
 .replace(/\s+(?:ТС[- ]?\d|ТОП[- ]?СЕНС|запрос|заявка|для\s+тендера|замена|коммерческое|тендер|КП|поверка|ремонт|поставка|закупка|счет|счёт|газоанализат\w*|сенсор\w*|датчик\w*|ЗИП)(?=$|[\s,;:()])[\s\S]*$/iu,"")
 .replace(/[.,;:\- ]+$/u,"").trim();
}
function candidateNames(title){
 const s=String(title||"").slice(0,550),out=[];
 // A pair of legal entities named in one thread is ambiguous. Do not turn
 // 'settlement between A and B' into a sale to either A or B.
 const matcher=new RegExp("(?:^|[\\s(,;])("+legal+")\\s*(?:[«\"“]([^»\"”]{3,110})[»\"”]|([^,;:\\/()\\n]{3,105}))","giu");
 for(const m of s.matchAll(matcher)){
  const opf=String(m[1]||"").toUpperCase();
  // Quoted text is the legal name, not the product description. In particular,
  // "ГСП Ремонт" must retain "Ремонт" as part of the company name.
  let company=m[2]?String(m[2]).trim():clean(m[3]||"");
  if(!acceptable(company,true))continue;
  out.push({name:opf+" "+company,base:normalize(company),opf,reason:"legal_name_in_deal_title"});
 }
 // Fallback: only recognizable starting phrase, product information follows.
 // Requires >=2 independent deals before it becomes a named CRM-less client.
 if(!out.length){
  const m=s.match(/^(?:\s*(?:RE|FW|FWD):\s*)?([^:,;()\n]{8,72}?)\s+(?:ТОП[- ]?СЕНС|ТС[- ]?\d{2,4}|запрос\s+цен|запрос\s+КП)\b/iu);
  if(m){
   const name=clean(m[1]);
   if(acceptable(name))out.push({name,base:normalize(name),opf:"",reason:"unverified_title_prefix"});
  }
 }
 const unique=new Map();
 for(const c of out)unique.set(c.opf+"|"+c.base,c);
 return [...unique.values()];
}
const state={status:"not_started",updatedAt:null,totalDeals:0,withoutCompanyId:0,
 identifiedDeals:0,ambiguousDeals:0,unidentifiedDeals:0,
 uniqueCandidateNames:0,repeatCandidateNames:0,crmCardMissingCandidates:0,
 possibleExistingClients:0,scanCompleteness:"not_started"};
const map=new Map();
function ingest(deals,{complete=false}={}){
 if(complete)map.clear();
 const input=deals instanceof Map?[...deals.values()]:Array.from(deals||[]);
 for(const row of input){
  const id=String(row?.ID||"");
  if(!/^[1-9]\d*$/.test(id))continue;
  const companyId=String(row.COMPANY_ID??"").trim();
  const title=String(row.TITLE||"").trim();
  map.set(id,{id,title:title.slice(0,300),companyId,contactId:String(row.CONTACT_ID||""),
   createdAt:String(row.DATE_CREATE||""),stageId:String(row.STAGE_ID||""),
   names:!companyId||companyId==="0"?candidateNames(title):[]});
 }
 let missing=0,identified=0,ambiguous=0,unidentified=0;
 const uniqueNames=new Set(),byName=new Map();
 for(const d of map.values()){
  if(d.companyId&&d.companyId!=="0")continue;
  missing++;
  if(d.names.length!==1){d.names.length>1?ambiguous++:unidentified++;continue}
  identified++;
  const n=d.names[0],k=n.base;
  uniqueNames.add(k);
  if(!byName.has(k))byName.set(k,new Set());
  byName.get(k).add(d.id);
 }
 Object.assign(state,{status:"ready",updatedAt:new Date().toISOString(),
  totalDeals:map.size,withoutCompanyId:missing,identifiedDeals:identified,
  ambiguousDeals:ambiguous,unidentifiedDeals:unidentified,
  uniqueCandidateNames:uniqueNames.size,
  repeatCandidateNames:[...byName.values()].filter(ids=>ids.size>=2).length,
  scanCompleteness:complete?"complete":state.scanCompleteness==="complete"?"complete":"partial"});
 return stats();
}
function namesFromInbound(d){
 // A generic or badly entered deal title may contain no usable company name.
 // Revisit the initial incoming email AND subsequent incoming letters.
 const p=require("./crm-deal-intake").get(d.id);
 const candidates=p?.legalNameCandidates||[];
 if(!candidates.length)return [];
 const parsed=candidates.map(x=>require("./client-canonical-name").parse(x.name))
  .filter(Boolean);
 const unique=new Map(parsed.map(x=>[x.opf+"|"+x.key,x]));
 // Contradictory names in one thread (including a forwarded exchange):
 // require human review rather than picking whichever occurs first.
 if(unique.size!==1)return [];
 return [...unique.values()].map(x=>({name:x.name,base:normalize(x.name),
  opf:x.opf,reason:"inbound_email_requisites"}));
}
function effectiveNames(d){
 if(d.names.length===0)return namesFromInbound(d);
 // A valid explicit legal name in the title remains an association candidate
 // until independent evidence confirms a different person/company.
 return d.names;
}
function group(companies=[],exclusions=[]){
 const existing=new Map(),invalidNames=new Set((exclusions||[]).map(normalize));
 for(const c of companies||[]){
  const b=normalize(c.name);
  if(!b)continue;
  if(!existing.has(b))existing.set(b,[]);
  existing.get(b).push(c);
 }
 const groups=new Map(),conflicting=new Set();
 for(const d of map.values()){
  if(d.companyId&&d.companyId!=="0")continue;
  const names=effectiveNames(d);
  if(names.length!==1)continue;
  const n=names[0],key=n.base;
  if(invalidNames.has(key))continue;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push({deal:d,identity:n});
 }
 const result=[];
 for(const [key,items] of groups){
  // Disallow multiple distinct known OPFs for a single group.
  const legalForms=[...new Set(items.map(x=>x.identity.opf).filter(Boolean))];
  if(legalForms.length>1){conflicting.add(key);continue}
  const prior=existing.get(key)||[];
  const priorOpfs=[...new Set(prior.map(c=>display(c.name).opf).filter(Boolean))];
  if(priorOpfs.length>1||legalForms.length&&priorOpfs.length&&priorOpfs[0]!==legalForms[0]){
   conflicting.add(key);continue;
  }
  const matchedExisting=prior.length>0;
  const directlyLinked=items.filter(x=>["legal_name_in_deal_title","inbound_email_requisites"].includes(x.identity.reason));
  const repeated=items.length>=2;
  if(!matchedExisting&&!directlyLinked.length&&!repeated)continue;
  const links=items.map(({deal:d})=>({
   id:d.id,title:d.title,createdAt:d.createdAt,contactId:d.contactId,
   url:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(d.id)+"/",
   relationshipEvidence:"Название в сделке; не проверено по первому письму"
  })).sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
  const displayName=display(items.find(x=>x.identity.opf)?.identity.name||items[0].identity.name).name;
  result.push({key,name:displayName,rawName:items[0].identity.name,
   confidence:directlyLinked.length&&repeated?"multiple_explicit_legal_names":
    directlyLinked.length?"one_explicit_legal_name":"repeated_title_only",
   linkedExisting:matchedExisting,
   existingCrmIds:prior.flatMap(c=>c.crmIdList||[c.id]).map(String),
   dealCount:links.length,dealRefs:links,needsIdentityCheck:true});
 }
 result.sort((a,b)=>b.dealCount-a.dealCount||a.name.localeCompare(b.name,"ru"));
 state.possibleExistingClients=result.filter(x=>x.linkedExisting).length;
 state.crmCardMissingCandidates=result.filter(x=>!x.linkedExisting).length;
 return result;
}
// Read-only export snapshot. A restarted process must finish a complete
// historical scan before claiming that this is the full deal backlog.
function unlinkedRecords(){
 if(state.scanCompleteness!=="complete"||map.size!==state.totalDeals)
  return null;
 const intake=require("./crm-deal-intake");
 return [...map.values()].filter(d=>!d.companyId||d.companyId==="0")
  .map(d=>{
   const identities=effectiveNames(d);
   return {id:d.id,title:d.title,createdAt:d.createdAt,
    contactId:d.contactId,stageId:d.stageId,
    identityCandidates:identities.map(x=>({name:String(x.name||"").slice(0,180),
     reason:String(x.reason||"").slice(0,90)})),
    inspectedThisProcess:Boolean(intake.get(d.id))};
  });
}
function stats(){return {...state}}
module.exports={ingest,group,stats,unlinkedRecords,candidateNames,normalize,namesFromInbound,effectiveNames};

"use strict";
// Read-only audit of inbound emails attached to CRM company records.
// No message bodies, customer names, personal emails or attachments are logged.
// This service cannot inspect Gmail-only correspondence; that is audited separately.
const companies=new Map(),queue=[],pending=new Set(),results=new Map();
const MAX_ACTIVITY_PAGES=2,MAX_COMPANIES=7000;
let running=false,checked=0,readErrors=0;
const freeDomains=new Set(["gmail.com","mail.ru","bk.ru","inbox.ru","list.ru","ya.ru","yandex.ru","rambler.ru","outlook.com","yahoo.com","hotmail.com","icloud.com","topsense.su","detector-gaza.ru"]);
function normalDomain(s){try{return new URL(/^https?:\/\//i.test(s)?s:"https://"+s).hostname.toLowerCase().replace(/^www\./,"")}catch{return""}}
function emailDomain(s){const m=String(s||"").match(/@([a-z0-9.-]+\.[a-z]{2,})/i);return m?m[1].toLowerCase():""}
function permittedDomain(s){const d=normalDomain(s);return d&&!freeDomains.has(d)&&/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(d)?d:""}
function cleanHtml(s){return String(s||"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\r/g,"\n").slice(0,16000)}
function signaturePart(s){
 const lines=cleanHtml(s).split("\n").map(x=>x.trim()).filter(Boolean);
 const cut=lines.findIndex(x=>/^(от:|from:|-----original message|начало переадресованного сообщения)/i.test(x));
 const clean=cut>=0?lines.slice(0,cut):lines;
 const marker=clean.findIndex(x=>/(?:^|^.{0,25})(?:с уважением|best regards|с наилучшими пожеланиями|kind regards)/i.test(x));
 return (marker>=0?clean.slice(marker):clean.slice(-16)).join("\n").slice(0,2600);
}
function siteLinks(s){
 const links=new Set();
 const text=String(s||"");
 for(const match of text.matchAll(/\b(?:https?:\/\/|www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/ig)){
  const raw=match[0].replace(/[),.;]+$/,"");
  const d=permittedDomain(raw);
  if(d)links.add("https://"+d);
 }
 return [...links].slice(0,12);
}
function nameProof(name,txt){
 const words=String(name||"").toLowerCase()
 .replace(/\b(?:ооо|ао|пао|оао|зао|тд|филиал)\b/gi," ")
 .split(/[^а-яёa-z0-9]+/i).filter(x=>x.length>=5);
 const lines=String(txt||"").toLowerCase();
 return words.some(w=>lines.includes(w));
}
function attachmentCandidates(items){
 const out=[];
 for(const a of items){
  for(const f of Array.isArray(a.FILES)?a.FILES:[]){
   const fn=String(f.NAME||f.name||"");
   if(/карточк[аи]|реквизит|анкета.?контрагента|company.?profile|контрагент/i.test(fn))
    out.push({fileName:fn.slice(0,160),activityId:String(a.ID||"")});
  }
  if(!Array.isArray(a.FILES)&&Array.isArray(a.STORAGE_ELEMENT_IDS)&&a.STORAGE_ELEMENT_IDS.length){
   out.push({fileName:"Вложения в CRM: названия недоступны",activityId:String(a.ID||"")});
  }
 }
 return out.slice(0,10);
}
async function bitrix(method,params){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");if(!base)throw Error("Bitrix not connected");
 const endpoint=new URL(method+".json",base.endsWith("/")?base:base+"/");
 const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)});
 const j=await r.json();if(!r.ok||j.error||!Array.isArray(j.result))throw Error("CRM read unavailable");
 return j;
}
// PDF company-card extraction is text-only. Scans and image-only documents stay
// explicitly pending; no legal, financial or shipment fields are inferred.
async function readPdfCompanyCard(items,c){
 const seen=new Set();
 const relevant=[];
 for(const a of items){
  for(const file of Array.isArray(a.FILES)?a.FILES:[]){
   const id=Number(file.ID||file.id||0),name=String(file.NAME||file.name||"");
   if(!id||seen.has(id))continue;
   seen.add(id);
   relevant.push({id,name});
  }
 }
 let unresolved=0,readCount=0;
 for(const ref of relevant.slice(0,4)){
  try{
   const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
   const url=new URL("disk.file.get.json",base.endsWith("/")?base:base+"/");
   const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:ref.id}),signal:AbortSignal.timeout(12000)});
   const j=await r.json();if(!r.ok||j.error||!j.result){unresolved++;continue}
   const meta=j.result;
   const filename=String(meta.NAME||ref.name||"");
   if(!/карточк|реквизит|company.?card|counterparty|анкета/i.test(filename))continue;
   if(!/\.pdf$/i.test(filename)){unresolved++;continue}
   if(Number(meta.SIZE||0)>2*1024*1024){unresolved++;continue}
   const downloadUrl=String(meta.DOWNLOAD_URL||"");
   if(!downloadUrl){unresolved++;continue}
   const target=new URL(downloadUrl,url);
   if(target.hostname!==url.hostname||target.protocol!=="https:"){unresolved++;continue}
   const fileResp=await fetch(target,{redirect:"manual",signal:AbortSignal.timeout(12000)});
   if(!fileResp.ok||Number(fileResp.headers.get("content-length")||0)>2*1024*1024){unresolved++;continue}
   const bytes=Buffer.from(await fileResp.arrayBuffer());
   if(bytes.length>2*1024*1024){unresolved++;continue}
   const parsed=await require("pdf-parse")(bytes);
   const content=String(parsed.text||"").slice(0,10000);
   if(!content){unresolved++;continue}
   readCount++;
   for(const website of siteLinks(content)){
    const domain=normalDomain(website);
    const known=[c.corporateDomain,...(c.crmEmails||[]).map(emailDomain)].filter(Boolean);
    const domainMatch=known.includes(domain);
    if(domainMatch||nameProof(c.name,content)){
     return {website,readCount,unresolved,status:"pdf_card_website_candidate",source:"Сайт из карточки компании, присланной письмом (PDF, текстовый слой)"};
    }
   }
  }catch{unresolved++}
 }
 return {website:"",readCount,unresolved,status:relevant.length?"card_documents_not_proven":"no_candidate_card_documents"};
}
async function scan(c){
 const acts=[];let start=0;
 for(let n=0;n<MAX_ACTIVITY_PAGES;n++){
  const options={order:{ID:"DESC"},filter:{BINDINGS:[{OWNER_TYPE_ID:4,OWNER_ID:Number(c.id)}]},
   select:["ID","TYPE_ID","DIRECTION","PROVIDER_ID","DESCRIPTION","COMMUNICATIONS","FILES","STORAGE_ELEMENT_IDS"],start};
  let out;
  try{out=await bitrix("crm.activity.list",options)}
  catch{options.filter={OWNER_TYPE_ID:4,OWNER_ID:Number(c.id)};out=await bitrix("crm.activity.list",options)}

  acts.push(...out.result);
  if(out.next==null||acts.length>=100)break;
  start=Number(out.next);
 }
 const inbound=acts.filter(x=>String(x.PROVIDER_ID||"").toUpperCase()==="CRM_EMAIL"||String(x.TYPE_ID||"")==="4")
  .filter(x=>String(x.DIRECTION||"")==="1").slice(0,60);
 const domainCandidates=new Set([c.corporateDomain,...(c.crmEmails||[]).map(emailDomain)].filter(Boolean));
 const evidence={status:"no_incoming_company_email",inboundCount:inbound.length,attachments:0,signatureWebsite:"",signatureTrust:"",source:"CRM inbound activity scan",checkedAt:new Date().toISOString()};
 const cards=attachmentCandidates(inbound);
 evidence.attachments=cards.length;
 if(cards.length)evidence.attachmentStatus="requires_document_content_review";
 for(const msg of inbound){
  const sig=signaturePart(msg.DESCRIPTION);
  if(!sig)continue;
  const links=siteLinks(sig);
  for(const url of links){
   const d=normalDomain(url);
   const ownerMatches=domainCandidates.has(d)||[...domainCandidates].some(x=>d===x||d.endsWith("."+x));
   const hasName=nameProof(c.name,sig);
   if(ownerMatches||hasName){
    evidence.status="signature_website_candidate";
    evidence.signatureWebsite=url;
    evidence.signatureTrust=ownerMatches?"email_domain_matches_signature":"company_name_matches_signature";
    evidence.source="Сайт из подписи входящего письма CRM";
    break;
   }
  }
  if(evidence.signatureWebsite)break;
 }
 if(!evidence.signatureWebsite&&inbound.length){
  const cardsAudit=await readPdfCompanyCard(inbound,c);
  evidence.cardDocumentsRead=cardsAudit.readCount;
  evidence.cardDocumentsUnresolved=cardsAudit.unresolved;
  evidence.cardStatus=cardsAudit.status;
  if(cardsAudit.website){
   evidence.signatureWebsite=cardsAudit.website;
   evidence.signatureTrust="pdf_card_name_or_domain_match";
   evidence.source=cardsAudit.source;
   evidence.status="pdf_card_website_candidate";
  }else evidence.status="incoming_email_without_verified_signature_site";
 }
 return evidence;
}
async function loop(){
 if(running)return;running=true;
 while(queue.length){
  const c=queue.shift();pending.delete(c.id);
  if(results.has(c.id))continue;
  try{
   const record=await scan(c);results.set(c.id,record);checked++;
   if(record.signatureWebsite){
    require("./website-profiler").enqueue([{...c,siteCandidate:record.signatureWebsite,siteSource:record.source.startsWith("Сайт из карточки")?"Сайт из карточки компании, присланной письмом":"Сайт из подписи входящего письма"}]);
   }
  }catch(error){
   readErrors++;
   results.set(c.id,{status:"crm_activity_read_failed",checkedAt:new Date().toISOString()});
  }
  if(checked%100===0||queue.length===0)
   console.log(JSON.stringify({component:"mail-evidence",event:"audit-progress",checked,remaining:queue.length,errors:readErrors,signatureSites:[...results.values()].filter(x=>x.signatureWebsite).length}));
  await new Promise(resolve=>setTimeout(resolve,450));
 }
 running=false;
}
function enqueue(items){
 for(const c of items){
  const id=String(c.id||"");if(!id||require("./client-finalization").isComplete(id)||results.has(id)||pending.has(id)||companies.size>=MAX_COMPANIES)continue;
  companies.set(id,c);pending.add(id);queue.push(c);
 }
 setTimeout(()=>loop().catch(()=>{running=false}),50);
}
function get(id){return results.get(String(id))||{status:pending.has(String(id))?"queued":"not_started"}}
function stats(){const counter={};for(const v of results.values())counter[v.status]=(counter[v.status]||0)+1;return{checked,remaining:queue.length,errors:readErrors,statusCounts:counter}}
module.exports={enqueue,get,stats};

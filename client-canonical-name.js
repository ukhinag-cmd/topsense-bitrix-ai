"use strict";
// Provisional names may come from an operator-edited deal TITLE.
// Promote only corroborated legal identity evidence from correspondence or
// independently verified corporate requisites. Never change any Bitrix record.
const {display}=require("./company-name-format");
const forms=new Set(["ООО","ПАО","АО","ОАО","ЗАО","НАО","ИП","ТОО"]);
const str=v=>String(v??"").trim();
const normalized=s=>str(s).toLowerCase().replace(/ё/g,"е").replace(/[^а-яa-z0-9]/g,"");
function parse(raw){
 const d=display(raw);
 const opf=str(d.opf).toUpperCase();
 if(!forms.has(opf))return null;
 const companyName=d.name.replace(new RegExp(",\\s*"+opf+"$","iu"),"").trim();
 if(!companyName||companyName.length<3||companyName.length>170)return null;
 if(/^(?:без названия|неизвестно|тест|клиент|компания)$/iu.test(companyName))return null;
 return {opf,base:companyName,key:normalized(companyName),
  name:opf+" «"+companyName.replace(/^[«"'\s]+|[»"'\s]+$/gu,"")+"»"};
}
function comparable(a,b){
 if(a===b)return true;
 // Normalized full legal names may have minor spelling/punctuation differences.
 return a.length>=6&&b.length>=6&&(a.includes(b)||b.includes(a))&&
  Math.min(a.length,b.length)/Math.max(a.length,b.length)>=0.8;
}
function safeEvidence(e){
 if(!e||typeof e!=="object")return null;
 const legal=parse(e.legalName||e.name);
 if(!legal)return null;
 const src=str(e.source);
 const supported=new Set(["incoming_email_requisites","official_website_and_inn",
  "official_website_and_phone","crm_verified_requisites","independent_manual_review"]);
 if(!supported.has(src))return null;
 const inn=str(e.inn).replace(/\D/g,"");
 if(inn&&!/^(?:\d{10}|\d{12})$/.test(inn))return null;
 const confirmed=src!=="incoming_email_requisites"&&e.verified===true&&
  Boolean(str(e.sourceRef))&&(src!=="official_website_and_inn"||inn.length>=10);
 return {...legal,source:src,sourceRef:str(e.sourceRef).slice(0,250),
  inn,verified:confirmed,
  emailActivityId:str(e.emailActivityId||"").slice(0,30)};
}
function resolve(client,externalEvidence=[]){
 const original=str(client?.name),originalName=original;
 const originalLegal=parse(original);
 const expectedKey=normalized(client?.rawName||original);
 const aliases=new Set([original,client?.rawName,...(client?.aliases||[])].filter(Boolean));
 const incoming=(externalEvidence||[]).map(safeEvidence).filter(Boolean);
 if(!incoming.length)return {...client,displayName:original,nameStatus:client?.nameStatus||"deal_title_provisional",
  originalName,aliases:[...aliases],nameEvidence:client?.nameEvidence||[]};
 const candidates=new Map();
 for(const e of incoming){
  const groupId=e.opf+"|"+e.key;
  if(!candidates.has(groupId))candidates.set(groupId,[]);
  candidates.get(groupId).push(e);
 }
 const verified=incoming.filter(x=>x.verified);
 // Any contradictory independently verified legal identities demand review.
 const identities=new Set(verified.map(x=>x.opf+"|"+x.key));
 const inns=new Set(verified.map(x=>x.inn).filter(Boolean));
 if(identities.size>1||inns.size>1)return {...client,displayName:original,
  nameStatus:"identity_conflict",originalName,aliases:[...aliases],
  nameEvidence:incoming.map(x=>({source:x.source,sourceRef:x.sourceRef,verified:x.verified}))};
 const approved=verified[0]||null;
 // A first-party incoming letter with explicit requisites provides a useful
 // *provisional* legal name, but never by itself legal identity proof.
 const stated=candidates.size===1?
  [...candidates.values()][0].find(x=>x.source==="incoming_email_requisites"):null;
 const matched=approved||stated;
 if(!matched)return {...client,displayName:original,nameStatus:"needs_identity_review",
  originalName,aliases:[...aliases],nameEvidence:incoming.map(x=>({source:x.source,sourceRef:x.sourceRef,verified:x.verified}))};
 if(originalLegal&&!approved&&originalLegal.opf!==matched.opf)
  return {...client,displayName:original,nameStatus:"identity_conflict",originalName,
   aliases:[...aliases],nameEvidence:incoming.map(x=>({source:x.source,sourceRef:x.sourceRef,verified:x.verified}))};
 // Explicit, corroborated legal evidence may resolve an abbreviation (e.g.
 // IS-16 -> Engineering Systems-16). Unverified mail cannot overwrite an
 // unrelated, already normalized organization with a different name.
 if(!approved&&originalLegal&&!comparable(originalLegal.key,matched.key))
  return {...client,displayName:original,nameStatus:"needs_identity_review",
   originalName,aliases:[...aliases],nameEvidence:incoming.map(x=>({source:x.source,sourceRef:x.sourceRef,verified:x.verified}))};
 aliases.add(matched.name);
 return {...client,name:matched.name,displayName:matched.name,
  nameStatus:matched.verified?"legal_name_verified":"legal_name_from_incoming_requisites",
  legalForm:matched.opf,canonicalInn:matched.inn||"",
  identityVerified:matched.verified,originalName,
  aliases:[...aliases],nameEvidence:[{source:matched.source,sourceRef:matched.sourceRef,
    inn:matched.inn||"",verified:matched.verified}]};
}
function fromIntake(dealRefs,read){
 const candidate=[];
 for(const ref of dealRefs||[]){
  const p=read(ref.id);
  if(!p)continue;
  for(const e of p.legalNameCandidates||[]){
   candidate.push({legalName:e.name,source:"incoming_email_requisites",
    emailActivityId:e.activityId,sourceRef:"Bitrix24 activity "+str(e.activityId),
    inn:str(e.inn),verified:false});
  }
 }
 return candidate;
}
module.exports={parse,resolve,safeEvidence,fromIntake};

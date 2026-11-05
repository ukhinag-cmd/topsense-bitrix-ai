"use strict";
/*
 TOP-SENS Sales Control: INERT READ-ONLY Bitrix24 preparation.
 DO NOT import from sales-standalone.js until separately approved.
 No credentials, URLs, network clients or requests on module import.
 Caller must explicitly inject a request(method, params) transport in a future phase.
 Supported methods: crm.item.list, crm.status.list, crm.category.list ONLY.
 Lead entityTypeId 1; deal entityTypeId 2; universal Bitrix API (camelCase fields).
 "Live" means stage semantics "process", not a new creation date.
*/
const ALLOWED=new Set(["crm.item.list","crm.status.list","crm.category.list"]);
const FIELDS=["id","title","stageId","assignedById","createdTime","updatedTime","opportunity","currencyId"];
// Money is summed in integer kopecks: floating point addition (0.10 + 0.20)
// is not an exact monetary subtotal. The symbol stays out of public JSON.
const RUB_KOPECKS=Symbol("RUB_KOPECKS");
const MAX_SAFE_RUB_KOPECKS=BigInt(Number.MAX_SAFE_INTEGER)*100n;
function parseRubKopecks(value){
 const text=typeof value==="string"?value.trim():
  typeof value==="number"&&Number.isFinite(value)?String(value):null;
 // Accept only nonnegative monetary decimals with at most two kopecks digits.
 // Do not coerce JSON arrays, empty strings, objects or sub-kopeck values to 0.
 if(text===null||text.length>64||/^\d+(?:\.\d{1,2})?$/.test(text)===false)return null;
 const [rub,kopecks=""]=text.split(".");
 return BigInt(rub)*100n+BigInt((kopecks+"00").slice(0,2));
}
// JSON numbers cannot express all cent values near the JS precision limit.
// Verify the exact kopecks survive Number -> JSON decimal serialization;
// otherwise show an unknown amount rather than a fabricated cent value.
function safeRubNumber(kopecks){
 if(kopecks===null||kopecks>MAX_SAFE_RUB_KOPECKS)return null;
 const rub=Number(kopecks/100n)+Number(kopecks%100n)/100;
 return parseRubKopecks(String(rub))===kopecks?rub:null;
}
function adapter(request){
 if(typeof request!=="function")throw new TypeError("Missing explicit read-only transport");
 async function read(method,params){
  if(!ALLOWED.has(method))throw new Error("Write/unknown CRM method blocked");
  const out=await request(method,params);
  if(!out||typeof out!=="object"||out.error)throw new Error("CRM read failed");
  return out;
 }
 async function pages(method,params,key){
  const all=[];let start=0;let expectedTotal=null;
  // A stable Bitrix total does not guard against offset drift: the same CRM
  // record can appear twice on different pages while another is skipped.
  // Never certify such a scan as a complete read-only snapshot.
  const seenRowIdentities=new Set();
  for(let n=0;n<100;n++){
   const data=await read(method,{...params,start});
   const items=key?data.result&&data.result[key]:data.result;
   if(!Array.isArray(items)||items.length>50)throw new Error("Invalid CRM list page");
   const consumed=start+items.length;
   // The API must never skip unseen rows with a jumped cursor or certify a
   // partial response as complete. Treat Bitrix totals as scan-wide promises.
   if(data.total!==undefined&&data.total!==null){
    const text=(typeof data.total==="number"||typeof data.total==="string")
     ?String(data.total).trim():"";
    const total=Number(text);
    if(!/^(0|[1-9]\d*)$/.test(text)||!Number.isSafeInteger(total)||
       total<consumed||(expectedTotal!==null&&total!==expectedTotal))
     throw new Error("Inconsistent CRM pagination total");
    expectedTotal=total;
   }
   const hasNext=data.next!==undefined&&data.next!==null;
   let next=null;
   if(hasNext){
    const text=(typeof data.next==="number"||typeof data.next==="string")
     ?String(data.next).trim():"";
    next=Number(text);
    if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(next)||
       next!==consumed||next<=start||
       (expectedTotal!==null&&next>expectedTotal))
     throw new Error("Invalid CRM pagination cursor");
   }else if(expectedTotal!==null&&consumed!==expectedTotal){
    throw new Error("Incomplete CRM pagination total");
   }
   for(const row of items){
    const field=method==="crm.status.list"?"STATUS_ID":"id";
    const identity=row&&typeof row==="object"&&!Array.isArray(row)?row[field]:null;
    // A requested CRM row with no identity must not disappear from the
    // trusted snapshot. Reject the entire page instead of silently dropping
    // the row and undercounting the Sales queues.
    if(identity===undefined||identity===null)
      throw new Error("Missing CRM list row identity");
    if(typeof identity!=="string"&&!(typeof identity==="number"&&Number.isSafeInteger(identity)))
      throw new Error("Invalid CRM list row identity");
    // Bitrix may serialize numeric IDs as numbers or strings. Normalize both
    // so e.g. 50 and "50" (or legacy "050") cannot evade duplicate detection.
    // CRM numeric identities must be canonical decimal scalars. Number("007"),
    // Number("7e0") and Number(" 7 ") all alias the genuine ID 7; accepting
    // those provider values could corrupt cross-page and cross-pipeline counts.
    // Category zero is valid, while a CRM lead/deal item ID must be positive.
    const idText=field==="id"?String(identity):null;
    const normalized=field==="id"?Number(idText):null;
    if(field==="id"&&(!/^(0|[1-9]\d*)$/.test(idText)||
       !Number.isSafeInteger(normalized)||
       normalized<(method==="crm.item.list"?1:0)))
      throw new Error("Invalid CRM list row identity");
    if(field==="STATUS_ID"&&String(identity).trim()==="")
      throw new Error("Invalid CRM list row identity");
    const identityKey=field==="id"?String(normalized):String(identity);
    if(seenRowIdentities.has(identityKey))throw new Error("Duplicate CRM list row identity");
    seenRowIdentities.add(identityKey);
   }
   all.push(...items);
   if(hasNext){start=next;continue;}
   // A full page without either pagination marker is ambiguous: probe the
   // following offset once, without trusting the first 50 as a complete list.
   if(items.length===50&&expectedTotal===null){start=consumed;continue;}
   return all;
  }
  throw new Error("CRM page limit reached; incomplete snapshot rejected");
 }
 async function stages(entityId){
  const rows=await pages("crm.status.list",{filter:{ENTITY_ID:entityId},order:{SORT:"ASC"}},null);
  return rows.map(s=>{
   let state=null;
   if(s.SEMANTICS==="S"||s.SEMANTICS==="F")state=s.SEMANTICS;
   else if(s.EXTRA&&s.EXTRA.SEMANTICS==="process")state="P";
   return {id:String(s.STATUS_ID||""),name:String(s.NAME||""),state,sort:Number(s.SORT||0)};
  }).filter(s=>s.id);
 }
 // Bitrix ownership must be a canonical scalar identity. In particular,
 // ["9"] and "09" must not silently masquerade as manager 9 in a trusted queue.
 function scalarManagerId(value){
  if(value===undefined||value===null||value==="")return null;
  const text=typeof value==="string"?value:
   typeof value==="number"&&Number.isSafeInteger(value)?String(value):null;
  if(text===null||!/^(0|[1-9][0-9]*)$/.test(text)||
     !Number.isSafeInteger(Number(text)))
   throw new Error("Invalid CRM item manager identity");
  return text;
 }
 function item(row,type,stage,pipeline){
  const id=Number(row.id);
  if(!Number.isInteger(id)||id<=0)return null;
  // A JSON array such as ["RUB"] stringifies to "RUB", fabricating a
  // monetary classification for invalid provider data. Only CRM strings
  // (or absent currency metadata) are safe to interpret.
  if(row.currencyId!=null&&typeof row.currencyId!=="string")
   throw new Error("Invalid CRM item currency");
  const currency=(row.currencyId||"").toUpperCase();
  const cents=currency==="RUB"?parseRubKopecks(row.opportunity):null;
  const rub=safeRubNumber(cents);
  const out={key:type+":"+id,id,type,title:String(row.title||""),stageId:stage.id,
   stageName:stage.name,pipelineId:pipeline?pipeline.id:null,
   pipelineName:pipeline?pipeline.name:"Лиды",
   managerId:scalarManagerId(row.assignedById),
   createdAt:typeof row.createdTime==="string"?row.createdTime:null,
   updatedAt:typeof row.updatedTime==="string"?row.updatedTime:null,
   amountRUB:rub,currency,
   commercialRisk:null,discipline:null,qualificationQuality:null,
   assessment:"Недостаточно данных для оценки"};
  Object.defineProperty(out,RUB_KOPECKS,{value:cents});
  return out;
 }
 // Treat category IDs as canonical nonnegative integers. In particular,
 // Number(null) and Number([0]) both equal zero but are not real pipeline IDs.
 function categoryIdOf(value){
  const text=typeof value==="number"&&Number.isSafeInteger(value)?String(value):
   typeof value==="string"?value:null;
  if(text===null||!/^(0|[1-9][0-9]*)$/.test(text))return null;
  const id=Number(text);
  return Number.isSafeInteger(id)?id:null;
 }
 function scalarStageId(value){
  // Arrays like ["NEW"] must never masquerade as the requested scalar stage.
  if(typeof value==="string")return value;
  if(typeof value==="number"&&Number.isSafeInteger(value))return String(value);
  return null;
 }
 function recent(a,b){return (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||b.id-a.id}
 async function snapshot({pipelineIds}={}){
  const categories=await pages("crm.category.list",{entityTypeId:2},"categories");
  if(!categories.length)throw new Error("No deal pipelines returned");
  // Keep pipeline identifiers canonical before constructing a trusted queue:
  // Number("01"), Number("1e0") and Number(" 0 ") alias genuine Bitrix IDs.
  // Number.isInteger alone also accepts unsafe, rounded caller selections.
  const pipelines=categories.map(p=>({id:categoryIdOf(p.id),name:String(p.name||"Без названия")}));
  if(pipelines.some(p=>p.id===null))throw new Error("Invalid pipeline ID");
  if(pipelineIds!==undefined&&(!Array.isArray(pipelineIds)||
     pipelineIds.some(id=>typeof id!=="number"||categoryIdOf(id)===null)))
    throw new TypeError("Invalid pipelineIds");
  const selected=pipelines.filter(p=>pipelineIds===undefined||pipelineIds.includes(p.id));
  const leadStages=(await stages("STATUS")).filter(s=>s.state==="P").sort((a,b)=>a.sort-b.sort);
  const leadMap=new Map(leadStages.map(x=>[x.id,x]));
  const leads=[];
  if(leadStages.length){
   const raw=await pages("crm.item.list",{entityTypeId:1,select:[...FIELDS,"sourceId"],
    filter:{"@stageId":leadStages.map(x=>x.id)},order:{createdTime:"DESC",id:"DESC"}},"items");
   for(const row of raw){
    const stageId=scalarStageId(row.stageId);
    if(stageId===null)throw new Error("Invalid CRM item stage");
    const stage=leadMap.get(stageId);
    if(!stage)throw new Error("CRM lead row violates requested stage filter");
    const lead=item(row,"lead",stage,null);
    if(lead){lead.isNewLead=stage.id===leadStages[0].id;leads.push(lead)}
   }
  }
  const deals=[];
  for(const pipeline of selected){
   const entity=pipeline.id===0?"DEAL_STAGE":"DEAL_STAGE_"+pipeline.id;
   const active=(await stages(entity)).filter(s=>s.state==="P");
   const stageMap=new Map(active.map(s=>[s.id,s]));
   if(!active.length)continue;
   const raw=await pages("crm.item.list",{entityTypeId:2,
    select:[...FIELDS,"categoryId"],
    filter:{categoryId:pipeline.id,"@stageId":active.map(x=>x.id)},
    order:{createdTime:"DESC",id:"DESC"}},"items");
   for(const row of raw){
    if(categoryIdOf(row.categoryId)!==pipeline.id)throw new Error("CRM deal row violates requested pipeline filter");
    const stageId=scalarStageId(row.stageId);
    if(stageId===null)throw new Error("Invalid CRM item stage");
    const stage=stageMap.get(stageId);
    if(!stage)throw new Error("CRM deal row violates requested stage filter");
    const deal=item(row,"deal",stage,pipeline);
    if(deal)deals.push(deal);
   }
  }
  // Separate read-only pipeline scans are not one atomic CRM transaction.
  // A deal may move pipelines between requests and satisfy both filters,
  // despite consistent per-page totals. Never publish that partial view as
  // an authoritative count or subtotal by silently de-duplicating it.
  const seenDealKeys=new Set();
  for(const deal of deals){
   if(seenDealKeys.has(deal.key))
    throw new Error("Duplicate CRM deal identity across pipeline scans");
   seenDealKeys.add(deal.key);
  }
  const unique=rows=>[...new Map(rows.map(x=>[x.key,x])).values()];
  const cleanLeads=unique(leads),cleanDeals=unique(deals);
  const newLeads=cleanLeads.filter(x=>x.isNewLead).sort(recent);
  const activeLeads=cleanLeads.filter(x=>!x.isNewLead).sort(recent);
  const activeDeals=cleanDeals.sort((a,b)=>(b.amountRUB??-1)-(a.amountRUB??-1)||recent(a,b));
  const queue=[...newLeads,...activeLeads,...activeDeals];
  // A sum can exceed reliable JS numeric precision even if every individual
  // CRM amount is finite. Never publish an unsafe subtotal as exact RUB.
  let totalKopecks=0n, incompleteRubTotal=false;
  for(const deal of cleanDeals){
   if(deal.currency!=="RUB")continue;
   if(deal[RUB_KOPECKS]===null){incompleteRubTotal=true;break;}
   totalKopecks+=deal[RUB_KOPECKS];
   // Check exact cents before converting to Number: adding 0.01 to
   // MAX_SAFE_INTEGER RUB otherwise rounds away the overflow.
   if(totalKopecks>MAX_SAFE_RUB_KOPECKS){incompleteRubTotal=true;break;}
  }
  const safeTotalRUB=incompleteRubTotal?null:safeRubNumber(totalKopecks);
  return {mode:"read-only-preparation",connected:false,
   funnels:selected,counts:{newLeads:newLeads.length,activeLeads:activeLeads.length,
     activeDeals:activeDeals.length,queue:queue.length},
   activeDealAmountRUB:safeTotalRUB,
   nonRubDealCount:cleanDeals.filter(d=>d.currency!=="RUB").length,
   priorityQueue:queue,assessment:"Недостаточно данных для реального скоринга"};
 }
 return Object.freeze({snapshot});
}
module.exports=Object.freeze({createReadOnlySalesAdapter:adapter});
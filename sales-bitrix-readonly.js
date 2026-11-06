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
// Read transports normally return JSON data. An injected transport might
// instead return getters/proxies that throw secret-bearing exceptions after
// the request itself succeeds. Snapshot a JSON-shaped response while still
// inside the redaction boundary. Preserve malformed primitive/function
// values so downstream type checks reject them with their normal errors;
// JSON.stringify and structuredClone would silently coerce or reject them.
function copyReadPayload(value, ancestors=new WeakSet()){
 if(value===null||typeof value!=="object")return value;
 if(ancestors.has(value))throw new Error("Invalid CRM response cycle");
 const proto=Object.getPrototypeOf(value);
 if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)
  throw new Error("Invalid CRM response object");
 // A sparse injected array is not an empty CRM list. Copying only its
 // enumerable indexes would silently erase missing rows and undercount leads
 // or deals. Real JSON arrays are always dense; fail closed for other shapes.
 const keys=Object.keys(value);
 // A JSON response cannot have hidden own fields. Dropping a non-enumerable
 // total/next on copy would certify a partial CRM scan as a complete queue.
 // Array length is the sole legitimate non-enumerable own property.
 if(Object.getOwnPropertyNames(value).length!==keys.length+(Array.isArray(value)?1:0))
  throw new Error("Invalid CRM response hidden properties");
 if(Array.isArray(value)&&(keys.length!==value.length||
    keys.some((key,index)=>key!==String(index))))
  throw new Error("Invalid CRM response array");
 ancestors.add(value);
 const result=Array.isArray(value)?[]:Object.create(null);
 for(const key of keys)result[key]=copyReadPayload(value[key],ancestors);
 ancestors.delete(value);
 return result;
}
function adapter(request){
 if(typeof request!=="function")throw new TypeError("Missing explicit read-only transport");
 async function read(method,params){
  if(!ALLOWED.has(method))throw new Error("Write/unknown CRM method blocked");
  // Injected transport exceptions may contain Bitrix webhook credentials in
  // their URL or provider message. Do not expose those untrusted exceptions,
  // their causes, or malformed response getters to callers/logs.
  let out;
  try{
   out=await request(method,params);
   if(!out||typeof out!=="object"||out.error)throw new Error("CRM read failed");
   // Any malicious getter exceptions stay inside this sanitizing catch.
   out=copyReadPayload(out);
  }catch{
   throw new Error("CRM read failed");
  }
  return out;
 }
 async function pages(method,params,key){
  const all=[];let start=0;let expectedTotal=null;
  let lastItemSort=null;
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
   // A stable total and unique IDs still cannot prove an offset scan if
   // the first row on a later page is newer than the previous page's tail.
   // Check the cross-page createdTime DESC, id DESC boundary (including
   // sub-millisecond ties). Existing single-page fixture responses are left
   // compatible; an optional missing createdTime cannot prove an order.
   if(method==="crm.item.list"&&items.length){
    // Boundary checks alone miss an inversion *within* a page: its last
    // row can still be older than the next page's first row. A paginated
    // scan must honor the requested order at every adjacent row, not only
    // at offset boundaries. Retain legacy single-page fixture compatibility.
    const scansMultiplePages=hasNext||start>0||
     (items.length===50&&expectedTotal===null);
    if(scansMultiplePages){
     // createdTime is the primary requested sort key. A missing value on
     // any paginated item makes DATE DESC, ID DESC unverifiable, even when
     // totals, cursors and unique IDs all look consistent. Fail closed
     // rather than reporting a complete but potentially shifted queue.
     const times=items.map(row=>scalarItemTime(row.createdTime,"created"));
     if(times.includes(null))
      throw new Error("Missing CRM item pagination sort key");
     for(let i=1;i<items.length;i++){
      const order=compareItemTimes(times[i-1],times[i]);
      if(order<0||(order===0&&Number(items[i-1].id)<=Number(items[i].id)))
       throw new Error("Out-of-order CRM item pagination");
     }
    }
    const first=items[0], last=items[items.length-1];
    const firstCreatedAt=scalarItemTime(first.createdTime,"created");
    const lastCreatedAt=scalarItemTime(last.createdTime,"created");
    if(lastItemSort&&firstCreatedAt!==null&&lastItemSort.createdAt!==null){
     const order=compareItemTimes(lastItemSort.createdAt,firstCreatedAt);
     if(order<0||(order===0&&lastItemSort.id<=Number(first.id)))
      throw new Error("Out-of-order CRM item pagination");
    }
    lastItemSort={createdAt:lastCreatedAt,id:Number(last.id)};
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
   // Bitrix status listings are scoped by ENTITY_ID. A misrouted stage from
   // another pipeline can misclassify a deal even when the returned item
   // itself satisfies its requested stage/category filters. A missing entity
   // label is tolerated for older API responses, never an incorrect one.
   if(s.ENTITY_ID!=null&&(typeof s.ENTITY_ID!=="string"||s.ENTITY_ID!==entityId))
    throw new Error("Invalid CRM stage entity filter");
   // Stage metadata controls which CRM records enter the read-only queue and
   // which lead is classified as new. Never coerce arrays/objects to scalar
   // semantics or SORT, or silently hide malformed open stages.
   if(s.SEMANTICS!=null&&typeof s.SEMANTICS!=="string")
    throw new Error("Invalid CRM stage semantics");
   if(s.EXTRA!=null&&(typeof s.EXTRA!=="object"||Array.isArray(s.EXTRA)))
    throw new Error("Invalid CRM stage metadata");
   if(s.EXTRA&&s.EXTRA.SEMANTICS!=null&&typeof s.EXTRA.SEMANTICS!=="string")
    throw new Error("Invalid CRM stage semantics");
   // Bitrix publishes null/S/F short semantics and process/success/failure/
   // apology long semantics. Unknown strings were silently classified as
   // closed, making real active deals vanish from an apparently healthy queue.
   const short=s.SEMANTICS, long=s.EXTRA&&s.EXTRA.SEMANTICS;
   // Missing both semantic markers leaves the stage's active/closed state
   // unknown. Never silently suppress deals and certify a zero Sales queue.
   // Explicit SEMANTICS:null remains an active stage; long-only is valid.
   if(short===undefined&&long==null)
    throw new Error("Invalid CRM stage semantics");
   if(short!=null&&short!=="S"&&short!=="F")
    throw new Error("Invalid CRM stage semantics");
   if(long!=null&&!["process","success","failure","apology"].includes(long))
    throw new Error("Invalid CRM stage semantics");
   // An explicitly returned null short marker means process, not success or
   // failure. Absent (undefined) short metadata is left compatible with
   // responses providing only the long semantic value.
   if((short===null&&long!=null&&long!=="process")||
      (short==="S"&&long!=null&&long!=="success")||
      (short==="F"&&long!=null&&long!=="failure"&&long!=="apology"))
    throw new Error("Invalid CRM stage semantics");
   const sortInput=s.SORT;
   const sortText=typeof sortInput==="string"?sortInput:
    typeof sortInput==="number"&&Number.isSafeInteger(sortInput)?String(sortInput):null;
   if(sortText===null||!/^\d+$/.test(sortText)||
      !Number.isSafeInteger(Number(sortText)))
    throw new Error("Invalid CRM stage sort");
   let state=null;
   if(s.SEMANTICS==="S"||s.SEMANTICS==="F")state=s.SEMANTICS;
   // Bitrix's documented short null marker means an in-progress stage,
   // even when the optional EXTRA.SEMANTICS field is absent.
   else if(s.SEMANTICS===null||(s.EXTRA&&s.EXTRA.SEMANTICS==="process"))state="P";
   // STATUS_ID may be a scalar numeric zero. The identity was validated by
   // pages(); do not turn a valid zero into an empty ID using a falsy fallback.
   return {id:String(s.STATUS_ID),name:scalarLabel(s.NAME,"","stage label"),state,sort:Number(sortText)};
  }).filter(s=>s.id);
 }
 // A provider array such as ["Working"] stringifies to an apparently valid
 // stage name, and non-JSON objects can even throw during String coercion.
 // Display provenance must be a scalar string or explicitly absent.
 function scalarLabel(value,fallback,field){
  if(value===undefined||value===null)return fallback;
  if(typeof value!=="string")throw new Error("Invalid CRM "+field);
  return value||fallback;
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
 // Queue dates are provenance, not display-only text: a malformed array,
 // object or non-ISO string must never silently become a missing/epoch date
 // and reorder live leads or deals in an apparently trustworthy snapshot.
 // A timezone-less ISO date is also ambiguous: Date.parse interprets it in
 // the host timezone (e.g. UTC in CI and Moscow in production). Require an
 // explicit Z or numeric UTC offset for stable CRM chronology.
 function scalarItemTime(value,field){
  if(value===undefined||value===null)return null;
  const iso=typeof value==="string"
   ?/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value):null;
  if(!iso||!Number.isFinite(Date.parse(value)))
   throw new Error("Invalid CRM item "+field+" time");
  const year=Number(iso[1]),month=Number(iso[2]),day=Number(iso[3]);
  const hour=Number(iso[4]),minute=Number(iso[5]),second=Number(iso[6]);
  if(year<100||month<1||month>12||day<1||
     day>new Date(Date.UTC(year,month,0)).getUTCDate()||
     hour>23||minute>59||second>59)
   throw new Error("Invalid CRM item "+field+" time");
  // Date.parse permits offsets such as +23:59, which cannot occur in a
  // real UTC timezone. Use the same maximum +/-14:00 as the dormant
  // read-only activity adapter; never trust fabricated CRM chronology.
  const offset=/[+-](\d{2}):(\d{2})$/.exec(value);
  if(offset&&(Number(offset[1])>14||
     (Number(offset[1])===14&&Number(offset[2])!==0)))
   throw new Error("Invalid CRM item "+field+" time");
  // Creation and modification are observations of past CRM events, not
  // planned activity dates. Reject future provider timestamps rather than
  // letting a fictitious item dominate the recent lead/deal queue. Allow
  // the same ten minutes of clock skew as the active read-only Sales module.
  if(Date.parse(value)>Date.now()+10*60*1000)
   throw new Error("Invalid CRM item "+field+" time");
  return value;
 }
 // Date.parse retains only milliseconds. Bitrix may send additional fractional
 // digits, so two distinct CRM instants can compare equal after truncation.
 // Compare those remaining decimal digits if their epoch milliseconds tie.
 // Offset-normalized timestamps have the same UTC second on an ms tie.
 function compareItemTimes(a,b){
  const difference=Date.parse(a)-Date.parse(b);
  if(difference!==0)return difference;
  const fraction=s=>(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(s)||[])[1]||"";
  const left=fraction(a),right=fraction(b);
  for(let i=0;i<Math.max(left.length,right.length);i++){
   const diff=(left.charCodeAt(i)||48)-(right.charCodeAt(i)||48);
   if(diff!==0)return diff;
  }
  return 0;
 }
 function item(row,type,stage,pipeline){
  // crm.item.list is scoped by entityTypeId, but a contradictory provider
  // row could still reuse another entity's ID/stage and corrupt the trusted
  // read-only Sales counts. Optional metadata may be absent in older replies;
  // when present it must match the requested lead (1) or deal (2) entity.
  const expectedEntityType=type==="lead"?1:2;
  if(row.entityTypeId!=null&&row.entityTypeId!==expectedEntityType&&
     row.entityTypeId!==String(expectedEntityType))
   throw new Error("Invalid CRM item entity");
  const id=Number(row.id);
  if(!Number.isInteger(id)||id<=0)return null;
  // A JSON array such as ["RUB"] stringifies to "RUB", fabricating a
  // monetary classification for invalid provider data. Only CRM strings
  // (or absent currency metadata) are safe to interpret.
  if(row.currencyId!=null&&typeof row.currencyId!=="string")
   throw new Error("Invalid CRM item currency");
  // Provider padding must not make RUB amounts disappear from the subtotal.
  // Match the active read-only Dashboard currency normalization (trim/case).
  // An unreported currency cannot be identified as foreign. A verified
   // zero amount is currency-neutral; retain the active Dashboard convention
   // of using RUB for such zero-value CRM deals.
   const rawCurrency=(row.currencyId||"").trim().toUpperCase();
   const currency=rawCurrency||(parseRubKopecks(row.opportunity)===0n?"RUB":"");
  const cents=currency==="RUB"?parseRubKopecks(row.opportunity):null;
  const rub=safeRubNumber(cents);
  const createdAt=scalarItemTime(row.createdTime,"created");
  const updatedAt=scalarItemTime(row.updatedTime,"updated");
  // An update cannot precede the record's creation. Check UTC instants
  // rather than text, since Bitrix can return equivalent zoned ISO dates.
  if(createdAt!==null&&updatedAt!==null&&compareItemTimes(updatedAt,createdAt)<0)
   throw new Error("Invalid CRM item chronology");
  const out={key:type+":"+id,id,type,title:scalarLabel(row.title,"","item title"),stageId:stage.id,
   stageName:stage.name,pipelineId:pipeline?pipeline.id:null,
   pipelineName:pipeline?pipeline.name:"Лиды",
   managerId:scalarManagerId(row.assignedById),
   createdAt,updatedAt,
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
 function recent(a,b){
  if(a.createdAt!==null&&b.createdAt!==null)
   return compareItemTimes(b.createdAt,a.createdAt)||b.id-a.id;
  // An absent CRM creation date cannot be treated as a known epoch instant.
  if(a.createdAt!==null||b.createdAt!==null)return b.createdAt!==null?1:-1;
  return b.id-a.id;
 }
 async function snapshot({pipelineIds}={}){
  const categories=await pages("crm.category.list",{entityTypeId:2},"categories");
  if(!categories.length)throw new Error("No deal pipelines returned");
  // Keep pipeline identifiers canonical before constructing a trusted queue:
  // Number("01"), Number("1e0") and Number(" 0 ") alias genuine Bitrix IDs.
  // Number.isInteger alone also accepts unsafe, rounded caller selections.
  // crm.category.list is explicitly filtered to deal entityTypeId 2. A
  // cross-entity category from a misrouted/partial CRM response can reuse
  // pipeline ID 0 and fabricate authoritative deal queues. Verify the
  // returned entity type when supplied; older Bitrix responses may omit it.
  // Do not coerce arrays or objects (including ["2"]) into entity 2.
  const pipelines=categories.map(p=>{
   if(p.entityTypeId!=null&&p.entityTypeId!==2&&p.entityTypeId!=="2")
    throw new Error("Invalid CRM pipeline entity");
   return {id:categoryIdOf(p.id),name:scalarLabel(p.name,"Без названия","pipeline label")};
  });
  if(pipelines.some(p=>p.id===null))throw new Error("Invalid pipeline ID");
  if(pipelineIds!==undefined&&(!Array.isArray(pipelineIds)||
     pipelineIds.some(id=>typeof id!=="number"||categoryIdOf(id)===null)))
    throw new TypeError("Invalid pipelineIds");
  // An explicit funnel selection is a correctness contract, not an optional
  // best-effort filter. If Bitrix omits a requested ID (stale configuration or
  // missing CRM visibility), publishing zero deals would be misleading.
  if(pipelineIds!==undefined&&pipelineIds.some(id=>!pipelines.some(p=>p.id===id)))
   throw new Error("Requested pipeline ID missing from CRM categories");
  const selected=pipelines.filter(p=>pipelineIds===undefined||pipelineIds.includes(p.id));
  const leadStages=(await stages("STATUS")).filter(s=>s.state==="P").sort((a,b)=>a.sort-b.sort);
  // If two active lead stages share the minimum SORT, Bitrix's response order
  // does not prove which stage means "new". Never publish a fabricated
  // new-lead count based on an arbitrary tie-breaker.
  if(leadStages.length>1&&leadStages[0].sort===leadStages[1].sort)
   throw new Error("Ambiguous CRM initial lead stage sort");
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
  const unknownCurrencyDealCount=cleanDeals.filter(d=>!d.currency).length;
   let totalKopecks=0n, incompleteRubTotal=unknownCurrencyDealCount>0;
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
   nonRubDealCount:cleanDeals.filter(d=>d.currency&&d.currency!=="RUB").length,
    unknownCurrencyDealCount,
   priorityQueue:queue,assessment:"Недостаточно данных для реального скоринга"};
 }
 return Object.freeze({snapshot});
}
module.exports=Object.freeze({createReadOnlySalesAdapter:adapter});
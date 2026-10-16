"use strict";
// UTC+3 (Europe/Moscow) daily read-only delta guard for TOP-SENSE analytics.
// Existing qualified types remain frozen. New inbound/outbound correspondence
// reopens only the relationship evidence; an AI/site recrawl must not change
// the qualified type without an independently evidenced review.
const crypto=require("node:crypto");
const KEY="site-profile:v1:9800000000000000";
const TYPE="topsense-crm-morning-monitor-v1";
const tz="Europe/Moscow";
const str=x=>String(x??"").trim();
const day=(date=new Date())=>new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
const hour=(date=new Date())=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",hourCycle:"h23"}).format(date));
const changed=new Map();
let checkpoint=null,running=false,lastError="",lastStatus="not_started",
 lastAttemptAt=null,checked=0,rowsLoaded=0,writeErrors=0;
const MAX_ROWS=10000,DELAY_MS=48*3600000;
function valid(x){
 return x&&x.recordType===TYPE&&Number.isFinite(Date.parse(x.checkedAt||""))&&
  /^\d{4}-\d{2}-\d{2}$/.test(str(x.moscowDay))&&
  Number.isSafeInteger(x.highestDealId)&&x.highestDealId>=0&&
  Number.isSafeInteger(x.highestActivityId)&&x.highestActivityId>=0;
}
function ingest(rows){
 const saved=(rows||[]).find(r=>r?.key===KEY)?.payload;
 if(!valid(saved))return false;
 if(checkpoint&&Date.parse(checkpoint.checkedAt)>Date.parse(saved.checkedAt))return false;
 checkpoint=saved;rowsLoaded++;
 // Restore reviewed-company markers across service restarts. Store IDs and
 // dates only; no personal correspondence or customer email body.
 for(const rec of saved.latestCorrespondence||[]){
  const id=str(rec.companyId),activity=str(rec.lastActivityId);
  if(/^\d+$/.test(id)&&/^\d+$/.test(activity))changed.set(id,{
   companyId:id,lastActivityId:activity,changedAt:str(rec.changedAt),
   observedAt:str(saved.checkedAt),status:"new_correspondence_requires_evidence_review"});
 }
 return true;
}
async function bridge(action,rows){
 const endpoint=str(process.env.GOOGLE_SHEET_STORE_URL);
 const secret=str(process.env.GOOGLE_SHEET_STORE_SECRET);
 if(!endpoint||!secret)throw Error("private_store_unavailable");
 const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
  body:JSON.stringify({action,secret,...(rows?{rows}:{})}),signal:AbortSignal.timeout(25000)});
 const result=await r.json();
 if(!r.ok||result.ok===false)throw Error("private_store_write_or_read_failed");
 return result;
}
async function ensureCheckpoint(){
 if(checkpoint)return;
 const data=await bridge("load");
 if(!ingest(data.rows)){
  // First run scans the previous 48 hours; does not try to re-qualify
  // historically complete companies merely because a service restarted.
  checkpoint={recordType:TYPE,moscowDay:"1970-01-01",
   checkedAt:new Date(Date.now()-DELAY_MS).toISOString(),
   highestDealId:0,highestActivityId:0};
 }
}
async function crm(method,params){
 const base=str(process.env.BITRIX_WEBHOOK_BASE);
 if(!base)throw Error("crm_readonly_not_configured");
 const url=new URL(method+".json",base.endsWith("/")?base:base+"/");
 for(let attempt=0;attempt<3;attempt++){
  try{
   const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify(params),signal:AbortSignal.timeout(26000)});
   const j=await r.json();
   if(!r.ok||j.error||j.result==null)throw Error("CRM "+method+" "+str(j.error||r.status).slice(0,100));
   return j;
  }catch(e){if(attempt===2)throw e;await new Promise(resolve=>setTimeout(resolve,900*(attempt+1)))}
 }
}
async function list(method,since,select){
 const result=[],seen=new Set();
 let start=0;
 for(let page=0;page<Math.ceil(MAX_ROWS/50);page++){
  const j=await crm(method,{order:{ID:"ASC"},filter:{">=CREATED":since},
   select,start});
  if(!Array.isArray(j.result))throw Error("invalid_crm_activity_page");
  for(const x of j.result){
   const id=str(x?.ID);if(!/^\d+$/.test(id)||seen.has(id))continue;
   seen.add(id);result.push(x);
  }
  if(result.length>=MAX_ROWS&&j.next!=null)throw Error("delta_limit_exceeded_incomplete");
  if(j.next==null)return result;
  const next=Number(j.next);
  if(!Number.isInteger(next)||next<=start)throw Error("crm_pagination_stalled");
  start=next;
 }
 throw Error("delta_page_limit_exceeded_incomplete");
}
async function newDeals(since){
 const result=[],seen=new Set();let start=0;
 for(let page=0;page<Math.ceil(MAX_ROWS/50);page++){
  const j=await crm("crm.deal.list",{order:{ID:"ASC"},
   filter:{">=DATE_CREATE":since},
   select:["ID","TITLE","DATE_CREATE","DATE_MODIFY","COMPANY_ID",
    "CONTACT_ID","CATEGORY_ID","STAGE_ID"],start});
  if(!Array.isArray(j.result))throw Error("invalid_new_deal_page");
  for(const x of j.result){const id=str(x?.ID);if(!/^\d+$/.test(id)||seen.has(id))continue;seen.add(id);result.push(x)}
  if(result.length>=MAX_ROWS&&j.next!=null)throw Error("new_deal_limit_exceeded");
  if(j.next==null)return result;
  const next=Number(j.next);if(!Number.isInteger(next)||next<=start)throw Error("new_deal_pagination_stalled");
  start=next;
 }
 throw Error("new_deal_page_limit_exceeded");
}
function isCorrespondence(a){
 const provider=str(a.PROVIDER_ID).toUpperCase();
 return String(a.TYPE_ID)==="4"||/EMAIL|IMOPENLINES|CHAT|SMS|MESSENGER/.test(provider);
}
function ownerBindings(a){
 const set=[];
 if(Array.isArray(a.BINDINGS))for(const x of a.BINDINGS)set.push({
  type:Number(x.OWNER_TYPE_ID),id:str(x.OWNER_ID)});
 set.push({type:Number(a.OWNER_TYPE_ID),id:str(a.OWNER_ID)});
 return set.filter(x=>/^\d+$/.test(x.id)&&[2,3,4].includes(x.type));
}
function markCompany(id,activity,observedAt){
 id=str(id);if(!/^\d+$/.test(id)||id==="0")return;
 const old=changed.get(id);
 if(!old||Number(activity.ID)>Number(old.lastActivityId))changed.set(id,{
  companyId:id,lastActivityId:str(activity.ID),
  changedAt:str(activity.CREATED||observedAt),observedAt,
  status:"new_correspondence_requires_evidence_review"
 });
}
function forCompany(id){return changed.get(str(id))||null}
function shouldRun(now=new Date()){
 return !running&&hour(now)>=8&&checkpoint?.moscowDay!==day(now);
}
async function tick(now=new Date()){
 if(running)return {status:"already_running"};
 // At first launch, checkpoint must be recovered BEFORE deciding what is new.
 running=true;lastAttemptAt=now.toISOString();
 try{
  await ensureCheckpoint();
  if(hour(now)<8||checkpoint.moscowDay===day(now)){
   lastStatus="not_due";return {status:lastStatus};
  }
  // Never discard an outage gap: even after days offline, restart from the
  // last successful scan (with 15 minutes overlap), not "48 hours ago".
  const since=new Date(Date.parse(checkpoint.checkedAt)-15*60000).toISOString();
  const [deals,activities]=await Promise.all([
   newDeals(since),
   list("crm.activity.list",since,["ID","OWNER_ID","OWNER_TYPE_ID","BINDINGS",
    "TYPE_ID","PROVIDER_ID","CREATED","LAST_UPDATED","SUBJECT","DIRECTION"])
  ]);
  const freshDeals=deals.filter(d=>Number(d.ID)>checkpoint.highestDealId);
  const freshActivities=activities.filter(a=>Number(a.ID)>checkpoint.highestActivityId&&isCorrespondence(a));
  const dealsById=new Map(deals.map(d=>[str(d.ID),d]));
  const fetched=new Map(),refreshedDeals=new Map(),companyChanges=new Map();
  async function getDeal(id){
   if(dealsById.has(id))return dealsById.get(id);
   if(fetched.has("deal:"+id))return fetched.get("deal:"+id);
   const r=await crm("crm.deal.get",{id:Number(id)});
   const row=r.result||{};fetched.set("deal:"+id,row);return row;
  }
  async function getContact(id){
   if(fetched.has("contact:"+id))return fetched.get("contact:"+id);
   const r=await crm("crm.contact.get",{id:Number(id)});
   fetched.set("contact:"+id,r.result||{});return fetched.get("contact:"+id);
  }
  for(const a of freshActivities){
   for(const binding of ownerBindings(a)){
    let cid="",deal=null;
    if(binding.type===2){
     deal=await getDeal(binding.id);cid=str(deal.COMPANY_ID);
     if(/^\d+$/.test(binding.id))refreshedDeals.set(binding.id,deal);
    }else if(binding.type===4)cid=binding.id;
    else if(binding.type===3){const c=await getContact(binding.id);cid=str(c.COMPANY_ID)}
    if(cid&&cid!=="0")companyChanges.set(cid,a);
   }
  }
  // Do not rewrite existing qualified company research when a manager only
  // adds a deal, changes a stage, or modifies a CRM company card.
  // Deliver the new deal list to the analytical intake separately.
  const intake=require("./crm-deal-intake");
  // New deals without new correspondence are counted, but cannot silently
  // change an old customer profile. Only refreshed deal email threads enter
  // the existing-client analytical evidence queue.
  const refreshed=[...refreshedDeals.values()].filter(d=>d&&/^\d+$/.test(str(d.ID)));
  const accepted=refreshed.length?intake.queueDeals(refreshed,{force:true}):0;
  // Commit watermark only after both complete snapshots and all direct
  // company associations are resolved. A failure retains the old checkpoint.
  const cp={recordType:TYPE,moscowDay:day(now),checkedAt:now.toISOString(),
   highestDealId:Math.max(checkpoint.highestDealId,...deals.map(x=>Number(x.ID))),
   highestActivityId:Math.max(checkpoint.highestActivityId,...activities.map(x=>Number(x.ID))),
   newDeals:freshDeals.length,newMessages:freshActivities.length,
   companiesWithMessages:companyChanges.size,linkedDealsQueued:accepted,
   latestCorrespondence:[...companyChanges].slice(0,2000).map(([companyId,a])=>
    ({companyId,lastActivityId:str(a.ID),changedAt:str(a.CREATED||now.toISOString())}))};
  await bridge("upsert",[{key:KEY,payload:cp}]);
  checkpoint=cp;
  for(const [id,a] of companyChanges)markCompany(id,a,now.toISOString());
  checked++;lastStatus="complete";lastError="";
  console.log(JSON.stringify({component:"crm-morning-monitor",event:"complete",
   moscowDay:cp.moscowDay,newDeals:cp.newDeals,newMessages:cp.newMessages,
   companiesWithMessages:cp.companiesWithMessages,queued:accepted}));
  return {status:"complete",...cp};
 }catch(error){
  lastStatus="error";lastError=str(error.message||error).slice(0,170);writeErrors++;
  console.warn(JSON.stringify({component:"crm-morning-monitor",event:"retry_required",
   error:lastError,at:new Date().toISOString()}));
  return {status:"error",reason:lastError};
 }finally{running=false}
}
function stats(){return {status:lastStatus,checked,moscowDay:checkpoint?.moscowDay||null,
 lastSuccessAt:checkpoint?.checkedAt||null,changedCompanies:changed.size,
 lastNewDeals:checkpoint?.newDeals||0,lastNewMessages:checkpoint?.newMessages||0,
 lastCompaniesWithMessages:checkpoint?.companiesWithMessages||0,
 lastAttemptAt,rowsLoaded,errors:writeErrors,lastError,
 policy:"qualifications_frozen; new-correspondence-only relationship review; Bitrix read-only"}}
module.exports={KEY,TYPE,day,hour,valid,ingest,shouldRun,tick,forCompany,stats,
 isCorrespondence,ownerBindings,markCompany};

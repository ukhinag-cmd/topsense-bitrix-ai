"use strict";
const worklist=require("./qualification-review-worklist");
const crypto=require("node:crypto");
const KEY="review-worker:v1:checkpoint";
const done=new Map(),pending=new Map(),retryAfter=new Map();
const dossiers=new Map(),unsavedDossiers=new Map();
const DOSSIER_PREFIX="review-evidence:v1:";
const intake=require("./crm-deal-intake");
let running=false,cycles=0,queued=0,checked=0,errors=0,lastAt=null,lastError="",dirty=false;
const toId=v=>String(v??"").trim();
function signature(c){return crypto.createHash("sha256").update(JSON.stringify([c.name,c.crmIdList||[c.id],c.latestCorrespondenceActivityId||"",c.siteVerified||c.siteProfileUrl||""])).digest("hex").slice(0,24)}
function ingest(rows){const p=(rows||[]).find(r=>r?.key===KEY)?.payload;if(p?.recordType==="topsense-review-worker-checkpoint-v1"&&Array.isArray(p.seen))for(const item of p.seen){if(Array.isArray(item)&&/^\d+$/.test(String(item[0]))&&/^[0-9a-f]{24}$/.test(String(item[1])))done.set(String(item[0]),String(item[1]))}for(const row of rows||[]){
 const key=String(row?.key||"");
 if(!key.startsWith(DOSSIER_PREFIX))continue;
 const id=key.slice(DOSSIER_PREFIX.length),v=row?.payload;
 if(!/^\d+$/.test(id)||v?.recordType!=="topsense-review-evidence-v1"||
  String(v.crmCompanyId)!==id||!/^[0-9a-f]{24}$/.test(String(v.signature||"")))continue;
 dossiers.set(id,v);
}
return done.size}
async function save(){const url=String(process.env.GOOGLE_SHEET_STORE_URL||""),secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"");if(!url||!secret)throw Error("checkpoint_unavailable");const payload={recordType:"topsense-review-worker-checkpoint-v1",seen:[...done],updatedAt:new Date().toISOString()};const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",secret,rows:[{key:KEY,payload},...unsavedDossiers.values()]}),signal:AbortSignal.timeout(25000)});const p=await r.json();if(!r.ok||p?.ok===false)throw Error("checkpoint_write_failed");unsavedDossiers.clear()}

async function deals(companyId,order="ASC"){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"").trim();
 if(!base||!/^\d+$/.test(companyId))throw Error("CRM read connection unavailable");
 const url=new URL("crm.deal.list.json",base.endsWith("/")?base:base+"/");
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({filter:{COMPANY_ID:Number(companyId)},order:{ID:order},
 select:["ID","COMPANY_ID","TITLE","DATE_CREATE","CONTACT_ID","STAGE_ID"],start:0}),
 signal:AbortSignal.timeout(18000)});
 const data=await response.json();
 if(!response.ok||data.error||!Array.isArray(data.result))throw Error("CRM deal list failed");
 return data.result.filter(x=>toId(x.COMPANY_ID)===companyId&&/^\d+$/.test(toId(x.ID))).slice(0,3);
}
function evidenceSummary(id,task,dealIds){
 const source=dealIds.map(dealId=>intake.get(dealId)).filter(Boolean);
 const activities=source.map(row=>({
  dealId:toId(row.id),inboundEmails:Number(row.incomingEmails||0),
  attachments:Number(row.attachmentCount||0),
  requisitesFound:Array.isArray(row.requisitesInnCandidates)&&row.requisitesInnCandidates.length>0,
  legalNameFound:Array.isArray(row.legalNameCandidates)&&row.legalNameCandidates.length>0,
  websiteHintsFound:Array.isArray(row.websiteHints)&&row.websiteHints.length>0,
  correspondencePartial:Boolean(row.correspondencePartial),
  readStatus:String(row.status||"unknown").slice(0,50)
 }));
 return {recordType:"topsense-review-evidence-v1",crmCompanyId:id,
  signature:task.signature,checkedAt:new Date().toISOString(),
  dealCount:dealIds.length,readCount:source.length,activities,
  originalsWithInbound:activities.filter(x=>x.inboundEmails>0).length,
  documentsFlagged:activities.filter(x=>x.attachments>0).length,
  legalIdentityCandidates:activities.filter(x=>x.requisitesFound||x.legalNameFound).length,
  classificationStatus:"evidence_collected_not_yet_qualified",
  warning:"Buying a gas detector is not evidence of the buyer's own industry"};
}
async function tick(companies){
 if(running)return {status:"busy"};
 if(String(process.env.TOPSENSE_ANALYTICS_READONLY)!=="1")return {status:"read_only_required"};
 if(!Array.isArray(companies)||companies.length<500)return {status:"snapshot_not_ready"};
 running=true;lastAt=new Date().toISOString();cycles++;
 let inspected=0,submitted=0,attempted=0;
 try{
 const all=worklist.inspect(companies).items;
 let changed=false;
 for(const [id,p] of pending){
  if(p.dealIds.every(dealId=>Boolean(intake.get(dealId)))){
   const row=evidenceSummary(id,p,p.dealIds);
   dossiers.set(id,row);
   unsavedDossiers.set(id,{key:DOSSIER_PREFIX+id,payload:row});
   done.set(id,p.signature);pending.delete(id);changed=true;dirty=true;
  }
 }
 for(const item of all){
  if(attempted>=3)break;
  const id=toId(item.id);
  if(pending.has(id)||(retryAfter.get(id)||0)>Date.now())continue;
  const owner=companies.find(c=>(c.crmIdList||[c.id]).map(toId).includes(id));
  if(!owner||(done.get(id)===signature(owner)&&dossiers.has(id)))continue;
  attempted++;
  try{
   // Only deals explicitly linked to this CRM legal entity.
   // A virtual duplicate group can contain several distinct CRM IDs.
   // Inspect each source card separately, without guessing a legal merge.
   const sourceIds=[...new Set((owner.crmIdList?.length?owner.crmIdList:[id]).map(toId)
    .filter(x=>/^\d+$/.test(x)))].slice(0,3);
   const pages=await Promise.all(sourceIds.flatMap(cid=>[deals(cid,"ASC"),deals(cid,"DESC")]));
   const linked=(owner.saleInfo?.linkedDeals||[]).filter(d=>
    d.linkVerified===true&&/domain/i.test(String(d.linkSource||""))&&
    /^\d+$/.test(toId(d.id))).slice(0,5)
    .map(d=>({ID:toId(d.id),COMPANY_ID:toId(d.crmCompanyId||"0"),
     DATE_CREATE:"",TITLE:"",verifiedHistoricalLink:true,
     verifiedAnalyticalCompanyId:id}));
   // The audited CRM link is acceptable; a company-name similarity alone is not.
   const found=[...new Map([...pages.flatMap(list=>list.slice(0,2)),...linked]
    .map(d=>[toId(d.ID),d])).values()].slice(0,10);
   submitted+=intake.queueDeals(found);
   inspected++;checked++;
   if(found.length){pending.set(id,{signature:signature(owner),dealIds:found.map(d=>toId(d.ID))});}
   else{
    // The historical deal audit may still be scanning orphaned requests.
    // Do not permanently mark a company as researched before that finishes.
    const audit=require("./crm-sales-audit").stats();
    if(audit.status==="complete"){
     done.set(id,signature(owner));changed=true;dirty=true;
    }else retryAfter.set(id,Date.now()+30*60*1000);
   }
  }catch(e){errors++;lastError=String(e.message||e).slice(0,100);
   retryAfter.set(id,Date.now()+30*60*1000);continue}
 }
 if(dirty){try{await save();dirty=false}catch(e){errors++;lastError=String(e.message||e).slice(0,100);}}
 queued+=submitted;
 const summary={component:"qualification-review-processor",event:"cycle",at:lastAt,
 inspected,attempted,submitted,totalChecked:checked,remaining:Math.max(0,all.length-done.size),errors};
 console.log(JSON.stringify(summary));return summary;
 }finally{running=false}
}
function stats(){return {cycles,queued,checked,errors,lastAt,lastError,checkpointed:done.size,inFlight:pending.size,checkpointWritePending:dirty,cooldown:retryAfter.size,dossiersWithEvidence:dossiers.size,dossiersPersisted:dossiers.size-unsavedDossiers.size,dossiersPending:unsavedDossiers.size}}
module.exports={tick,stats,ingest,signature,evidenceSummary};

"use strict";
// Read-only CRM lead inbox. Leads without a verified COMPANY_ID stay separate
// from companies; identical names and contact emails do not prove identity.
const state={status:"not_started",updatedAt:null,error:null,total:0,items:[],loading:false,contactCompanyMap:new Map(),history:null,leadStatus:"not_started",dealStatus:"not_started"};
function str(s){return String(s??"").trim()}
function value(v){
 if(Array.isArray(v))return v.map(value).filter(Boolean).join("; ");
 return v&&typeof v==="object"?str(v.VALUE||v.value):str(v);
}
function clean(lead){
 return {id:str(lead.ID),title:str(lead.TITLE).slice(0,300),
  companyId:str(lead.COMPANY_ID),contactId:str(lead.CONTACT_ID),
  createdAt:str(lead.DATE_CREATE),modifiedAt:str(lead.DATE_MODIFY),
  statusId:str(lead.STATUS_ID),name:[str(lead.NAME),str(lead.LAST_NAME)].filter(Boolean).join(" ").slice(0,170),
  email:value(lead.EMAIL).slice(0,340),sourceId:str(lead.SOURCE_ID),ownerId:str(lead.ASSIGNED_BY_ID),
  companyCandidate:str(lead.COMPANY_TITLE).slice(0,200),categoryId:str(lead.CATEGORY_ID),
  crmUrl:"https://topsense.bitrix24.ru/crm/lead/details/"+encodeURIComponent(str(lead.ID))+"/"};
}
async function refresh(){
 if(state.loading||!str(process.env.BITRIX_WEBHOOK_BASE))return;
 state.loading=true;
 try{
  const base=str(process.env.BITRIX_WEBHOOK_BASE);
  const cutoff="2026-09-06T00:00:00+03:00";
  async function list(method,filter,fields){
   const endpoint=new URL(method+".json",base.endsWith("/")?base:base+"/");
   async function chunk(start){
    for(let attempt=0;attempt<2;attempt++){
     try{
      const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
       body:JSON.stringify({order:{ID:"DESC"},filter,select:fields,start}),
       signal:AbortSignal.timeout(20000)});
      const p=await r.json();
      if(!r.ok||p.error||!Array.isArray(p.result))throw Error("CRM "+method+" unavailable: "+str(p.error||r.status).slice(0,80));
      return p;
     }catch(e){if(attempt)throw e;await new Promise(resolve=>setTimeout(resolve,800))}
    }
   }
   const first=await chunk(0),all=[...first.result],total=Number(first.total||all.length);
   if(total>20000)throw Error(method+" count above safety limit");
   if(total>all.length){
    const size=Math.max(1,all.length),offsets=[];
    for(let i=size;i<total;i+=size)offsets.push(i);
    for(let i=0;i<offsets.length;i+=3){
     const pages=await Promise.all(offsets.slice(i,i+3).map(chunk));
     pages.forEach(p=>all.push(...p.result));
    }
   }
   const found=new Map(all.filter(x=>x&&x.ID).map(x=>[str(x.ID),x]));
   if(found.size<total)throw Error("Incomplete read-only "+method+" snapshot "+found.size+"/"+total);
   return [...found.values()];
  }
  // Some Bitrix portals use classic Leads; others record incoming requests as
  // deals in the "Входящие лиды" pipeline (category 0). Include both
  // without counting them as legally identified companies.
  const fields=["ID","TITLE","COMPANY_ID","CONTACT_ID","NAME","LAST_NAME","EMAIL","STATUS_ID","DATE_CREATE","DATE_MODIFY"];
  const [leads,deals]=await Promise.allSettled([
   list("crm.lead.list",{">=DATE_CREATE":cutoff},[...fields,"SOURCE_ID","ASSIGNED_BY_ID","COMPANY_TITLE"]),
   list("crm.deal.list",{">=DATE_CREATE":cutoff},
    ["ID","TITLE","COMPANY_ID","CONTACT_ID","STAGE_ID","CATEGORY_ID","SOURCE_ID","ASSIGNED_BY_ID","DATE_CREATE","DATE_MODIFY"])
  ]);
  if(leads.status!=="fulfilled"&&deals.status!=="fulfilled")throw Error("Lead and incoming-deal reads unavailable");
  const dealRows=deals.status==="fulfilled"?deals.value:[];
  if(dealRows.length)require("./deal-only-client-registry").ingest(dealRows);
  if(dealRows.length)require("./crm-unlinked-discovery").ingest(dealRows);
  const leadRows=leads.status==="fulfilled"?leads.value:[];
  const missingContacts=[...new Set([...leadRows,...dealRows].filter(x=>!x.COMPANY_ID||String(x.COMPANY_ID)==="0")
    .map(x=>str(x.CONTACT_ID)).filter(x=>/^[1-9]\d*$/.test(x)))];
  const linkedContacts=new Map();
  let contactLinkError="";
  for(let k=0;k<missingContacts.length;k+=40){
   try{
    const contacts=await list("crm.contact.list",{"@ID":missingContacts.slice(k,k+40)},["ID","COMPANY_ID"]);
    for(const c of contacts)linkedContacts.set(str(c.ID),str(c.COMPANY_ID));
   }catch(e){contactLinkError="contact_lookup_unavailable";break}
  }
  state.contactCompanyMap=linkedContacts;
  const records=[
   ...leadRows.map(c=>({...clean(c),kind:"lead"})),
   ...dealRows.map(c=>({...clean({...c,STATUS_ID:c.STAGE_ID}),kind:str(c.CATEGORY_ID)==="0"?"incoming_deal":"other_deal",
    crmUrl:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(str(c.ID))+"/"}))
  ];
  state.items=records
   .filter(x=>Date.parse(x.createdAt||0)>=Date.parse(cutoff))
   .sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)||Number(b.id)-Number(a.id));
  state.total=state.items.length;
  // Read the deal and its inbound e-mails before trusting manually filled CRM cards.
  require("./crm-deal-intake").queueDeals(dealRows);
  state.leadStatus=leads.status==="fulfilled"?"complete":"unavailable";
  state.dealStatus=deals.status==="fulfilled"?"complete":"unavailable";
  state.history={since:cutoff,leads:leadRows.length,deals:dealRows.length,
   incomingDeals:dealRows.filter(x=>str(x.CATEGORY_ID)==="0").length,
   otherPipelineDeals:dealRows.filter(x=>str(x.CATEGORY_ID)!=="0").length,
   october:state.items.filter(x=>Date.parse(x.createdAt||0)>=Date.parse("2026-10-01T00:00:00+03:00")).length,
   last7Days:state.items.filter(x=>Date.parse(x.createdAt||0)>=Date.now()-7*24*60*60*1000).length,
   recentDeals7Days:dealRows.filter(x=>Date.parse(x.DATE_CREATE||0)>=Date.now()-7*24*60*60*1000).length,
   withoutCompanyDirect:state.items.filter(x=>!x.companyId||x.companyId==="0").length,
   contactLinksChecked:linkedContacts.size,contactLinkError};
  state.status=leads.status==="fulfilled"&&deals.status==="fulfilled"?"ready":"partial";
  state.error=[leads,deals].filter(x=>x.status==="rejected")
   .map(x=>"CRM read unavailable: "+str(x.reason.message||x.reason).slice(0,80)).join("; ")||contactLinkError||null;
  state.updatedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"lead-inbox",event:"read-only-refreshed",inbound:state.total,
   crmLeads:leads.status==="fulfilled"?leads.value.length:0,
   incomingDeals:state.history.incomingDeals,otherPipelineDeals:state.history.otherPipelineDeals,
   allDeals:deals.status==="fulfilled"?deals.value.length:0,status:state.status}));
 }catch(e){
  state.status=state.updatedAt?"stale":"unavailable";state.error=str(e.message||e).slice(0,150);
  console.warn(JSON.stringify({component:"lead-inbox",event:"read-only-unavailable",reason:state.error}));
 }finally{state.loading=false}
}
function view(companies){
 const known=new Set((companies||[]).flatMap(c=>[str(c.id),...(c.crmIdList||[]).map(str)]));
 const classified=state.items.map(l=>{
  const direct=l.companyId&&l.companyId!=="0"&&known.has(l.companyId);
  const fromContact=state.contactCompanyMap.get(l.contactId)||"";
  const throughContact=!direct&&known.has(fromContact);
  const companyId=direct?l.companyId:throughContact?fromContact:"";
  const dealEvidence=l.kind==="lead"?null:require("./crm-deal-intake").get(l.id);
  return {...l,companyId,dealEvidence,linkStatus:companyId?"known_company":"pending_identification",
   linkSource:direct?"company_id":throughContact?"contact_company_id":"unlinked",
   possibleServiceMail:/undeliverable|delivery status notification|mail delivery failed|ошибка доставки|сбой доставки|рассылка|спам|security alert|password reset/i.test(l.title)};
 });
 return {status:state.status,error:state.error,updatedAt:state.updatedAt,total:classified.length,
  linked:classified.filter(l=>l.linkStatus==="known_company").length,
  pending:classified.filter(l=>l.linkStatus==="pending_identification").length,
  history:state.history||{},leadStatus:state.leadStatus,dealStatus:state.dealStatus,
  dealIntake:require("./crm-deal-intake").stats(),items:classified};
}
module.exports={refresh,view,state};

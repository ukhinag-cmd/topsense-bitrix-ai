"use strict";
// Read-only CRM lead inbox. Leads without a verified COMPANY_ID stay separate
// from companies; identical names and contact emails do not prove identity.
const state={status:"not_started",updatedAt:null,error:null,total:0,items:[],loading:false};
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
  email:value(lead.EMAIL).slice(0,340),crmUrl:"https://topsense.bitrix24.ru/crm/lead/details/"+encodeURIComponent(str(lead.ID))+"/"};
}
async function refresh(){
 if(state.loading||!str(process.env.BITRIX_WEBHOOK_BASE))return;
 state.loading=true;
 try{
  const base=str(process.env.BITRIX_WEBHOOK_BASE);
  const endpoint=new URL("crm.lead.list.json",base.endsWith("/")?base:base+"/");
  const cutoff=new Date(Date.now()-35*24*60*60*1000).toISOString();
  async function chunk(start){
   for(let attempt=0;attempt<2;attempt++){
    try{
     const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({order:{ID:"DESC"},filter:{">DATE_CREATE":cutoff},
       select:["ID","TITLE","COMPANY_ID","CONTACT_ID","NAME","LAST_NAME","EMAIL","STATUS_ID","DATE_CREATE","DATE_MODIFY"],start}),
      signal:AbortSignal.timeout(20000)});
     const p=await r.json();
     if(!r.ok||p.error||!Array.isArray(p.result))throw Error("CRM lead list inaccessible: "+str(p.error||r.status).slice(0,80));
     return p;
    }catch(e){if(attempt)throw e;await new Promise(resolve=>setTimeout(resolve,800))}
   }
  }
  const first=await chunk(0),all=[...first.result],total=Number(first.total||all.length);
  if(total>20000)throw Error("Lead count above safety limit");
  if(total>all.length){
   const size=Math.max(1,all.length),offsets=[];
   for(let i=size;i<total;i+=size)offsets.push(i);
   for(let i=0;i<offsets.length;i+=3){
    const pages=await Promise.all(offsets.slice(i,i+3).map(chunk));
    pages.forEach(p=>all.push(...p.result));
   }
  }
  const found=new Map(all.filter(x=>x&&x.ID).map(x=>[str(x.ID),clean(x)]));
  if(found.size<total)throw Error("Incomplete read-only lead snapshot "+found.size+"/"+total);
  state.items=[...found.values()].sort((a,b)=>Number(b.id)-Number(a.id));
  state.total=state.items.length;state.status="ready";state.error=null;
  state.updatedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"lead-inbox",event:"read-only-refreshed",leads:state.total}));
 }catch(e){
  state.status=state.updatedAt?"stale":"unavailable";
  state.error=str(e.message||e).slice(0,150);
  console.warn(JSON.stringify({component:"lead-inbox",event:"read-only-unavailable",reason:state.error}));
 }finally{state.loading=false}
}
function view(companies){
 const known=new Set((companies||[]).flatMap(c=>[str(c.id),...(c.crmIdList||[]).map(str)]));
 const classified=state.items.map(l=>{
  const linked=Boolean(l.companyId&&l.companyId!=="0"&&known.has(l.companyId));
  return {...l,linkStatus:linked?"known_company":"pending_identification"};
 });
 return {status:state.status,error:state.error,updatedAt:state.updatedAt,total:classified.length,
  linked:classified.filter(l=>l.linkStatus==="known_company").length,
  pending:classified.filter(l=>l.linkStatus==="pending_identification").length,
  items:classified};
}
module.exports={refresh,view,state};

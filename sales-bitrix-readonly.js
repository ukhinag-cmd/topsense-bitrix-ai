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
function adapter(request){
 if(typeof request!=="function")throw new TypeError("Missing explicit read-only transport");
 async function read(method,params){
  if(!ALLOWED.has(method))throw new Error("Write/unknown CRM method blocked");
  const out=await request(method,params);
  if(!out||typeof out!=="object"||out.error)throw new Error("CRM read failed");
  return out;
 }
 async function pages(method,params,key){
  const all=[];let start=0;
  for(let n=0;n<100;n++){
   const data=await read(method,{...params,start});
   const items=key?data.result&&data.result[key]:data.result;
   if(!Array.isArray(items))throw new Error("Invalid CRM list response");
   all.push(...items);
   if(data.next===undefined||data.next===null)return all;
   const next=Number(data.next);
   if(!Number.isInteger(next)||next<=start||next-start>50)throw new Error("Invalid CRM pagination cursor");
   start=next;
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
 function item(row,type,stage,pipeline){
  const id=Number(row.id);
  if(!Number.isInteger(id)||id<=0)return null;
  const currency=String(row.currencyId||"").toUpperCase();
  const amount=Number(row.opportunity);
  const rub=currency==="RUB"&&row.opportunity!=null&&Number.isFinite(amount)&&amount>=0?amount:null;
  return {key:type+":"+id,id,type,title:String(row.title||""),stageId:stage.id,
   stageName:stage.name,pipelineId:pipeline?pipeline.id:null,
   pipelineName:pipeline?pipeline.name:"Лиды",
   managerId:row.assignedById==null?null:String(row.assignedById),
   createdAt:typeof row.createdTime==="string"?row.createdTime:null,
   updatedAt:typeof row.updatedTime==="string"?row.updatedTime:null,
   amountRUB:rub,currency,
   commercialRisk:null,discipline:null,qualificationQuality:null,
   assessment:"Недостаточно данных для оценки"};
 }
 function recent(a,b){return (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||b.id-a.id}
 async function snapshot({pipelineIds}={}){
  const categories=await pages("crm.category.list",{entityTypeId:2},"categories");
  if(!categories.length)throw new Error("No deal pipelines returned");
  const pipelines=categories.map(p=>({id:Number(p.id),name:String(p.name||"Без названия")}));
  if(pipelines.some(p=>!Number.isInteger(p.id)||p.id<0))throw new Error("Invalid pipeline ID");
  if(pipelineIds!==undefined&&(!Array.isArray(pipelineIds)||pipelineIds.some(id=>!Number.isInteger(id)||id<0)))
    throw new TypeError("Invalid pipelineIds");
  const selected=pipelines.filter(p=>pipelineIds===undefined||pipelineIds.includes(p.id));
  const leadStages=(await stages("STATUS")).filter(s=>s.state==="P").sort((a,b)=>a.sort-b.sort);
  const leadMap=new Map(leadStages.map(x=>[x.id,x]));
  const leads=[];
  if(leadStages.length){
   const raw=await pages("crm.item.list",{entityTypeId:1,select:[...FIELDS,"sourceId"],
    filter:{"@stageId":leadStages.map(x=>x.id)},order:{createdTime:"DESC",id:"DESC"}},"items");
   for(const row of raw){
    const stage=leadMap.get(String(row.stageId||""));
    if(!stage)continue;
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
    if(Number(row.categoryId)!==pipeline.id)continue;
    const stage=stageMap.get(String(row.stageId||""));
    if(!stage)continue;
    const deal=item(row,"deal",stage,pipeline);
    if(deal)deals.push(deal);
   }
  }
  const unique=rows=>[...new Map(rows.map(x=>[x.key,x])).values()];
  const cleanLeads=unique(leads),cleanDeals=unique(deals);
  const newLeads=cleanLeads.filter(x=>x.isNewLead).sort(recent);
  const activeLeads=cleanLeads.filter(x=>!x.isNewLead).sort(recent);
  const activeDeals=cleanDeals.sort((a,b)=>(b.amountRUB??-1)-(a.amountRUB??-1)||recent(a,b));
  const queue=[...newLeads,...activeLeads,...activeDeals];
  return {mode:"read-only-preparation",connected:false,
   funnels:selected,counts:{newLeads:newLeads.length,activeLeads:activeLeads.length,
     activeDeals:activeDeals.length,queue:queue.length},
   activeDealAmountRUB:cleanDeals.reduce((n,d)=>n+(d.amountRUB||0),0),
   nonRubDealCount:cleanDeals.filter(d=>d.currency!=="RUB").length,
   priorityQueue:queue,assessment:"Недостаточно данных для реального скоринга"};
 }
 return Object.freeze({snapshot});
}
module.exports=Object.freeze({createReadOnlySalesAdapter:adapter});

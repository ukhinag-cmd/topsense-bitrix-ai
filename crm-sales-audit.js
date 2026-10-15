"use strict";
// TOP-SENSE. Read-only stage-based fulfilment/payment signals.
// Deal success ("won") alone is NEVER proof of shipment or payment.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const purchaseCheckpoint=require("./purchase-checkpoint");
const state={status:"not_started",totalDeals:0,scannedDeals:0,wonDeals:0,productRowsChecked:0,
 shipmentStages:[],paymentStages:[],commercialStages:[],stageHistoryRecords:0,stageHistoryStatus:"not_started",
 shippedDeals:0,paidDeals:0,qualifiedDeals:0,companiesWithPurchaseEvidence:0,
 error:null,startedAt:null,finishedAt:null,refreshAfter:null};
let summary=new Map(),busy=false,orphanDealIndex=new Map(),orphanMatchSummary={status:"not_started"};
async function call(method,params){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Bitrix webhook not configured");
 const u=new URL(method+".json",base.endsWith("/")?base:base+"/");
 for(let a=0;a<2;a++){
  try{
   const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify(params),signal:AbortSignal.timeout(22000)});
   const j=await r.json().catch(()=>({}));
   if(!r.ok||j.error)throw Error(String(j.error_description||j.error||"Bitrix read error").slice(0,140));
   return j;
  }catch(e){if(a)throw e;await sleep(650)}
 }
}
function won(d){
 return String(d.STAGE_SEMANTIC_ID||"").toUpperCase()==="S"||String(d.STAGE_ID||"").toUpperCase().endsWith("WON");
}
function typeOfStage(name){
 const n=String(name||"").toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ").trim();
 // Commercial success stage, but combined wording is NOT proof of payment.
 if(/договор/.test(n)&&/(?:оплат|оплач)/.test(n))return "qualified";
 if(/ожидает\s+отправк/.test(n))return "qualified";
 if(/(?:оплат[аыуы]?\s+(?:получен[аоы]?|поступил[аоы]?)|(?:получен[аоы]?|поступил[аоы]?)\s+оплат[аы]|счет\s+оплачен|средства\s+поступил)/i.test(n))return "paid";
 if(/(?:приборы?\s+получен[ыао]?\s*\/?\s*упд|упд\s+подписан)/i.test(n))return "shipped";
 if(/(?:прибор[ыа]?\s+отгруж|прибор[ыа]?\s+отправлен)/i.test(n))return "shipped";
 if(/(?:(?:товар|продукц|оборудован|заказ|груз)\S*(?:[\s\S]{0,32})(?:отгруж|отправлен|отправк[аыу] заверш)|(?:отгруж|отправлен)[\s\S]{0,24}(?:товар|заказ|оборудован|продукц))/i.test(n))return "shipped";
 return "";
}
async function stages(){
 const c=await call("crm.category.list",{entityTypeId:2});
 const cats=Array.isArray(c.result?.categories)?c.result.categories:[];
 if(!cats.length)cats.push({id:0,name:"Основная воронка"});
 if(!cats.some(x=>Number(x.id)===0))cats.push({id:0,name:"Основная воронка"});
 const found=new Map(),catalog=[];
 for(let k=0;k<cats.length;k+=3){
  const chunk=await Promise.all(cats.slice(k,k+3).map(async cat=>{
   const categoryId=Number(cat.id)||0;
   const entityId=categoryId?"DEAL_STAGE_"+categoryId:"DEAL_STAGE";
   const s=await call("crm.status.list",{order:{SORT:"ASC"},filter:{ENTITY_ID:entityId}});
   return {categoryId,pipeline:String(cat.name||""),data:Array.isArray(s.result)?s.result:[]};
  }));
  for(const {categoryId,pipeline,data} of chunk)for(const v of data){
   catalog.push({pipeline,categoryId,name:String(v.NAME||""),code:String(v.STATUS_ID||"")});
   const code=String(v.STATUS_ID||"");
   const kind=typeOfStage(v.NAME);
   if(code&&kind)found.set(code,{code,kind,categoryId,pipeline,stageName:String(v.NAME||"")});
  }
 }
 // Full stage catalog inspected once; do not continuously log it.
 state.shipmentStages=[...found.values()].filter(v=>v.kind==="shipped");
 state.commercialStages=[...found.values()].filter(v=>v.kind==="qualified");
 state.paymentStages=[...found.values()].filter(v=>v.kind==="paid");
 console.log(JSON.stringify({component:"sales-audit",event:"stage-mapping",
   shipments:state.shipmentStages,payments:state.paymentStages}));
 return found;
}
async function dealPage(start){
 return call("crm.deal.list",{order:{ID:"ASC"},filter:{},
 select:["ID","TITLE","CONTACT_ID","COMPANY_ID","CATEGORY_ID","STAGE_ID","STAGE_SEMANTIC_ID","CURRENCY_ID"],start});
}
async function allDeals(){
 const first=await dealPage(0);
 const initial=Array.isArray(first.result)?first.result:[];
 const total=Number(first.total||initial.length);
 if(total>75000)throw Error("Deal count above safety limit");
 state.totalDeals=total;
 const all=initial.slice();
 if(total>initial.length){
  const size=Math.max(1,initial.length||50),starts=[];
  for(let i=size;i<total;i+=size)starts.push(i);
  for(let j=0;j<starts.length;j+=4){
   const chunks=await Promise.all(starts.slice(j,j+4).map(dealPage));
   chunks.forEach(c=>all.push(...(Array.isArray(c.result)?c.result:[])));
   state.scannedDeals=all.length;
   if(j%80===0)await sleep(200);
  }
 }else if(first.next!=null){
  let next=first.next,guard=0;while(next!=null&&guard++<1600){
   const p=await dealPage(next);all.push(...(p.result||[]));next=p.next;
  }
 }
 const map=new Map(all.filter(d=>d&&d.ID).map(d=>[String(d.ID),d]));
 if(map.size<total)throw Error("Incomplete CRM deal scan "+map.size+"/"+total);
 state.scannedDeals=map.size;
 return map;
}
function arrayFromHistory(j){
 const r=j.result;
 return Array.isArray(r)?r:Array.isArray(r?.items)?r.items:[];
}
async function historyPage(ids,start){
 return call("crm.stagehistory.list",{entityTypeId:2,order:{ID:"ASC"},
 filter:{STAGE_ID:ids},select:["ID","OWNER_ID","CATEGORY_ID","STAGE_ID","CREATED_TIME"],start});
}
async function stageHistory(stages,knownDeals){
 const codes=[...stages.keys()];
 if(!codes.length){state.stageHistoryStatus="no_identified_stages";return new Map()}
 const found=new Map(),seen=new Set();
 let next=0,pages=0,complete=false;
 try{
  do{
   const resp=await historyPage(codes,next);
   const rows=arrayFromHistory(resp);
   if(!Array.isArray(rows))throw Error("Invalid history response");
   for(const row of rows){
    const id=String(row.OWNER_ID||"");
    const stage=stages.get(String(row.STAGE_ID||""));
    if(!id||!stage||!knownDeals.has(id))continue;
    const sig=id+":"+stage.code;
    if(seen.has(sig))continue;
    seen.add(sig);
    if(!found.has(id))found.set(id,{paid:false,shipped:false,sources:[]});
    const x=found.get(id);
    x[stage.kind]=true;
    if(x.sources.length<6)x.sources.push({code:stage.code,name:stage.stageName,kind:stage.kind,at:String(row.CREATED_TIME||"")});
   }
   state.stageHistoryRecords+=rows.length;
   next=resp.next==null?null:Number(resp.next);
   if(++pages>=700||state.stageHistoryRecords>=35000)break;
   if(pages%30===0)await sleep(150);
  }while(next!==null);
  complete=next===null;
 }catch(e){
  state.stageHistoryStatus="incomplete";
  console.warn(JSON.stringify({component:"sales-audit",event:"stage-history-unavailable",reason:String(e.message||e).slice(0,125)}));
  return found;
 }
 state.stageHistoryStatus=complete?"complete":"partial_safety_limit";
 return found;
}
async function productRows(dealId){
 try{
  const r=await call("crm.deal.productrows.get",{id:Number(dealId)});
  return Array.isArray(r.result)?r.result:[];
 }catch{return null}
}
function fallback(id){
 if(state.status==="complete")return {
  purchaseStatus:"НЕ БЫЛО",
  shipped:false,paid:false,purchaseItems:[],purchaseAmount:null,purchaseCurrency:"",
  purchaseDealCount:0,purchaseBasis:"Аудит доступных сделок и истории стадий завершён"};
 return {purchaseStatus:"ПРОВЕРЯЕТСЯ — отгрузка/оплата ещё не установлены",
  shipped:false,paid:false,purchaseItems:[],purchaseAmount:null,purchaseCurrency:"",
  purchaseDealCount:0,purchaseBasis:"Сбор сделок и истории стадий не завершён"};
}
async function run(companies){
 if(busy)return;
 busy=true; // Keep previously verified buyers visible during new scans.
 Object.assign(state,{status:"scanning",totalDeals:0,scannedDeals:0,wonDeals:0,productRowsChecked:0,
 shipmentStages:[],paymentStages:[],commercialStages:[],stageHistoryRecords:0,stageHistoryStatus:"not_started",
 shippedDeals:0,paidDeals:0,qualifiedDeals:0,companiesWithPurchaseEvidence:0,error:null,
 startedAt:new Date().toISOString(),finishedAt:null});
 try{
  const allowed=new Set((companies||[]).map(x=>String(x.id)));
  const stageMap=await stages();
  if(!stageMap.size)throw Error("Отгрузка и оплата не найдены среди названий стадий доступных воронок CRM");
  const deals=await allDeals();
  const linker=require("./crm-orphan-deals");
  const contactIndex=await linker.fetchContactIndex(deals,call);
  const orphan=linker.reconcile(deals,companies,contactIndex.contacts);
  const viaHistory=await stageHistory(stageMap,deals);
  const focusedEmailAudit=await linker.verifyRelevantDealEmails(deals,orphan,stageMap,viaHistory,call);
  const mailScan=await linker.scanEmailActivities(deals,orphan,call);
  orphanMatchSummary={...orphan.stats,contactAudit:contactIndex.stats,activityScan:mailScan,qualifyingDealEmailAudit:focusedEmailAudit,
    verifiedDomainLinks:orphan.candidates.filter(c=>c.linkVerified&&c.linkSource!=="crm_contact_id").length,
    totalRecoveredLinks:orphan.candidates.filter(c=>c.linkVerified&&/domain/.test(String(c.linkSource||""))).length,
    rejectedUnconfirmed:orphan.candidates.filter(c=>!c.linkVerified||!/domain/.test(String(c.linkSource||""))).length};
  orphanDealIndex=new Map();
  for(const item of orphan.candidates){
   if(!item.linkVerified||!/domain/.test(String(item.linkSource||"")))continue;
   if(!orphanDealIndex.has(item.companyId))orphanDealIndex.set(item.companyId,[]);
   if(orphanDealIndex.get(item.companyId).length<120)orphanDealIndex.get(item.companyId).push(item);
  }
  console.log(JSON.stringify({component:"sales-audit",event:"unlinked-deal-reconciliation",...orphanMatchSummary}));
  const eligible=[];
  const accum=new Map();
  for(const d of deals.values()){
   const dealId=String(d.ID);
   const originalId=String(d.COMPANY_ID||"");
   const match=orphan.byDeal.get(dealId);
   const companyId=originalId&&originalId!=="0"?originalId:(match?.linkVerified&&/domain/.test(String(match.linkSource||""))?match.companyId:"");
   if(!allowed.has(companyId))continue;
   if(won(d))state.wonDeals++;
   const hist=viaHistory.get(dealId),current=stageMap.get(String(d.STAGE_ID||""));
   const shipped=Boolean(hist?.shipped||current?.kind==="shipped");
   const paid=Boolean(hist?.paid||current?.kind==="paid");
   const qualified=Boolean(hist?.qualified||current?.kind==="qualified");
   if(!shipped&&!paid&&!qualified)continue;
   if(qualified)state.qualifiedDeals++;
   if(shipped)state.shippedDeals++;
   if(paid)state.paidDeals++;
   if(!accum.has(companyId))accum.set(companyId,{shipped:false,paid:false,qualified:false,
    purchaseItems:[],purchaseAmount:null,purchaseCurrency:"",purchaseDealCount:0,
    purchaseBasis:"Одна из пяти согласованных стадий Bitrix24; сумма только из документов",
    documentCount:0,documentAmountsKnown:0,documentTotal:0,documentSources:[],stageEvidence:[],purchaseDeals:[],productEvidence:"pending"});
   const rec=accum.get(companyId);
   rec.shipped||=shipped;rec.paid||=paid;rec.qualified||=qualified;rec.purchaseDealCount++;
   for(const src of hist?.sources||[]){
    if(rec.stageEvidence.length<8&&!rec.stageEvidence.some(x=>x.code===src.code))
      rec.stageEvidence.push(src);
   }
   if(current&&rec.stageEvidence.length<8&&!rec.stageEvidence.some(x=>x.code===current.code))
    rec.stageEvidence.push({code:current.code,name:current.stageName,kind:current.kind,at:"Текущая стадия"});
   if(rec.purchaseDeals.length<40){
     const fromHistory=(hist?.sources||[]).map(x=>({name:x.name,at:x.at||"",source:"history"}));
     const atCurrent=current?[{name:current.stageName,at:"",source:"current"}]:[];
     const stages=[...fromHistory,...atCurrent].filter((x,i,a)=>a.findIndex(y=>y.name===x.name)===i).slice(0,6);
     rec.purchaseDeals.push({id:dealId,crmCompanyId:companyId,stages,linkSource:match?.linkSource||"direct_company",linkVerified:match?.linkVerified??true,productsStatus:"not_checked",documentStatus:"not_checked"});
   }
   eligible.push({id:dealId,companyId});
  }
  for(const rec of accum.values())rec.purchaseStatus="БЫЛА";
  state.companiesWithPurchaseEvidence=accum.size;
  // Product rows only for deals reaching shipment or payment stages.
  let n=0;
  const docAudit=require("./deal-document-amount");
  for(const deal of eligible){
   const rows=await productRows(deal.id),rec=accum.get(deal.companyId);
   const doc=await docAudit.forDeal(deal.id);
   const purchaseDeal=(rec.purchaseDeals||[]).find(x=>x.id===deal.id);
   if(purchaseDeal){purchaseDeal.documentStatus=doc.status;purchaseDeal.documentSource=doc.source||"";purchaseDeal.productsStatus=rows===null?"unavailable":rows.length?"available":"empty";}
   rec.documentCount+=(doc.documentCount||0);
   if(doc.amount!==null){rec.documentAmountsKnown++;rec.documentTotal+=doc.amount;
    if(rec.documentSources.length<12)rec.documentSources.push({dealId:deal.id,source:doc.source});}
   state.productRowsChecked++;
   if(rows===null)rec.productEvidence="unavailable";
   else{
    rec.productEvidence="crm_product_rows";
    for(const p of rows){
     const name=String(p.PRODUCT_NAME||p.NAME||"").trim();
     if(name&&!rec.purchaseItems.includes(name)&&rec.purchaseItems.length<35)rec.purchaseItems.push(name);
    }
   }
   if(++n%25===0)await sleep(180);
  }
  for(const rec of accum.values()){
   if(rec.documentAmountsKnown===rec.purchaseDealCount&&rec.documentAmountsKnown>0){
     rec.purchaseAmount=rec.documentTotal;rec.purchaseCurrency="RUB";
     rec.amountStatus="Сумма подтверждена счетами/договорами";
   }else{
     rec.purchaseAmount=null;rec.purchaseCurrency="";
     rec.amountStatus="Не удалось подтвердить суммы всех сделок документами";
   }
   delete rec.documentTotal;
  }
  // Keep previous verified positive evidence when a new audit is partial.
  summary=new Map([...summary,...accum]);
  purchaseCheckpoint.queue(summary);
  state.documentAudit=docAudit.stats();
  state.status=state.stageHistoryStatus==="complete"?"complete":"partial";
  state.finishedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"sales-audit",event:"fulfilment-audit-complete",
   status:state.status,scannedDeals:state.scannedDeals,orphanRecovered:orphanMatchSummary.totalRecoveredLinks||0,shippedDeals:state.shippedDeals,
   paidDeals:state.paidDeals,companiesWithEvidence:state.companiesWithPurchaseEvidence,
   stageHistoryStatus:state.stageHistoryStatus,productRowsChecked:state.productRowsChecked,documentAudit:state.documentAudit}));
 }catch(e){
  state.status="incomplete";state.error=String(e.message||e).slice(0,170);
  console.warn(JSON.stringify({component:"sales-audit",event:"audit-incomplete",
   error:state.error,scannedDeals:state.scannedDeals}));
 }finally{busy=false}
}
function get(id){
 const linked=(orphanDealIndex.get(String(id))||[]).map(d=>({id:d.dealId,crmCompanyId:d.companyId,title:d.title,linkSource:d.linkSource,linkVerified:d.linkVerified,url:"https://topsense.bitrix24.ru/crm/deal/details/"+encodeURIComponent(d.dealId)+"/"}));
 const record=summary.get(String(id))||purchaseCheckpoint.get(id);
 if(record){
  if(state.status==="complete")return {...record,linkedDeals:linked};
  if(record.shipped||record.paid||record.qualified)return {...record,linkedDeals:linked};
  return {...record,linkedDeals:linked,purchaseStatus:"ПРОВЕРЯЕТСЯ — аудит сделки продолжается"};
 }
 return {...fallback(id),linkedDeals:linked};
}
function stats(){return {...state,orphanDeals:orphanMatchSummary,companiesWithSuccessfulDeal:state.wonDeals,checkpoint:purchaseCheckpoint.stats()};}
module.exports={run,get,stats};

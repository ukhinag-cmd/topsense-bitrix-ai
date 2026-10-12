"use strict";
// Read-only CRM sales audit. "Purchase" here means successful CRM deal,
// not independently proven shipment or acceptance.
const state={status:"not_started",totalDeals:0,scannedDeals:0,wonDeals:0,productRowsChecked:0,error:null,startedAt:null,finishedAt:null};
let summary=new Map(),busy=false;
async function call(method,params){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Bitrix webhook not configured");
 const u=new URL(method+".json",base.endsWith("/")?base:base+"/");
 for(let a=0;a<2;a++){
  try{
   const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)});
   const j=await r.json();
   if(!r.ok||j.error)throw Error("Bitrix read error");
   return j;
  }catch(err){if(a)throw err;await new Promise(resolve=>setTimeout(resolve,650))}
 }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function valueOfDeal(d){
 const amount=Number(d.OPPORTUNITY);
 const currency=String(d.CURRENCY_ID||"RUB").trim().toUpperCase();
 return {amount:Number.isFinite(amount)&&amount>=0?amount:null,currency};
}
function won(d){
 const semantic=String(d.STAGE_SEMANTIC_ID||"").toUpperCase();
 return semantic==="S"||String(d.STAGE_ID||"").toUpperCase().endsWith("WON");
}
async function page(start){
 return call("crm.deal.list",{order:{ID:"ASC"},filter:{},select:["ID","COMPANY_ID","STAGE_ID","STAGE_SEMANTIC_ID","OPPORTUNITY","CURRENCY_ID"],start});
}
async function productRows(dealId){
 try{
  const r=await call("crm.deal.productrows.get",{id:Number(dealId)});
  return Array.isArray(r.result)?r.result:[];
 }catch{return null}
}
function statusRecord(id){
 const x=summary.get(String(id));
 if(x)return x;
 return {purchaseStatus:state.status==="complete"?"НЕ БЫЛО — выигранных сделок CRM не найдено":"ПРОВЕРКА СДЕЛОК",purchaseItems:[],purchaseAmount:null,purchaseCurrency:"",purchaseDealCount:0,purchaseBasis:state.status==="complete"?"Проверены стадии доступных сделок CRM":"Аудит сделок ещё не завершён"};
}
async function run(companies){
 if(busy)return;
 busy=true;state.status="scanning";state.startedAt=new Date().toISOString();state.error=null;
 try{
  const allowed=new Set((companies||[]).map(x=>String(x.id)));
  const first=await page(0);
  const initial=Array.isArray(first.result)?first.result:[];
  const total=Number(first.total||initial.length);
  if(total>75000)throw Error("Deal count above safety limit");
  state.totalDeals=total;
  let all=initial.slice();
  if(total>initial.length){
   const size=Math.max(1,initial.length||50),starts=[];
   for(let i=size;i<total;i+=size)starts.push(i);
   for(let j=0;j<starts.length;j+=3){
    const chunks=await Promise.all(starts.slice(j,j+3).map(page));
    chunks.forEach(c=>all.push(...(Array.isArray(c.result)?c.result:[])));
    state.scannedDeals=all.length;
    if(j%60===0)await sleep(300);
   }
  }else if(first.next!=null){
   let next=first.next,guard=0;
   while(next!=null&&guard++<1600){
    const p=await page(next);all.push(...(p.result||[]));next=p.next;
   }
  }
  const byId=new Map();
  for(const d of all){if(d?.ID)byId.set(String(d.ID),d)}
  if(byId.size<total)throw Error("Incomplete CRM deal scan; results not final");
  state.scannedDeals=byId.size;
  const done=[];
  for(const d of byId.values()){
   if(!won(d))continue;
   const id=String(d.COMPANY_ID||"");
   if(!id||id==="0"||!allowed.has(id))continue;
   if(!summary.has(id))summary.set(id,{purchaseStatus:"БЫЛА — успешная сделка в CRM",purchaseItems:[],purchaseAmount:null,purchaseCurrency:"",purchaseDealCount:0,purchaseBasis:"Успешная стадия сделки; отгрузка и документы не проверялись",currencies:{},productEvidence:"pending"});
   const rec=summary.get(id);
   rec.purchaseDealCount++;
   const {amount,currency}=valueOfDeal(d);
   if(amount!==null)rec.currencies[currency]=(rec.currencies[currency]||0)+amount;
   done.push({id:String(d.ID),companyId:id,opportunity:amount,currency});
  }
  state.wonDeals=done.length;
  for(const rec of summary.values()){
   const money=Object.entries(rec.currencies);
   if(money.length===1){rec.purchaseAmount=money[0][1];rec.purchaseCurrency=money[0][0]}
   else if(money.length>1){rec.purchaseAmount=null;rec.purchaseCurrency="Разные валюты"}
   delete rec.currencies;
  }
  // Read product lines from every won deal, if available; do not invent SKUs from deal title.
  let index=0;
  for(const d of done){
   const lines=await productRows(d.id);
   const rec=summary.get(d.companyId);
   state.productRowsChecked++;
   if(lines===null){rec.productEvidence="unavailable";continue}
   rec.productEvidence="crm_product_rows";
   for(const p of lines){
    const name=String(p.PRODUCT_NAME||p.NAME||"").trim();
    if(name&&!rec.purchaseItems.includes(name)&&rec.purchaseItems.length<30)rec.purchaseItems.push(name);
   }
   if(++index%35===0)await sleep(300);
  }
  state.status="complete";state.finishedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"sales-audit",status:"complete",companiesWithWonDeal:summary.size,wonDeals:state.wonDeals,scannedDeals:state.scannedDeals,productRowsChecked:state.productRowsChecked}));
 }catch(e){
  state.status="incomplete";state.error=String(e.message||e).slice(0,170);
  // Never declare a negative conclusion for an incomplete scan.
  console.warn(JSON.stringify({component:"sales-audit",status:"incomplete",error:state.error,scannedDeals:state.scannedDeals}));
 }finally{busy=false}
}
function get(id){
 const x=summary.get(String(id));
 if(x)return {...x,purchaseStatus:state.status==="complete"?x.purchaseStatus:"БЫЛА — найдена выигранная сделка; проверка не завершена"};
 return statusRecord(id);
}
function stats(){return{...state,companiesWithSuccessfulDeal:summary.size};}
module.exports={run,get,stats};

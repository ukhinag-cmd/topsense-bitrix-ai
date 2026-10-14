"use strict";
// Read-only Bitrix24 company requisites. RQ_INN is a candidate corporate
// identifier, not proof that an external financial report was checked.
const {innNumber}=require("./financial-2025");
const state={status:"not_started",updatedAt:null,rows:0,withInn:0,conflicts:0,error:null};
let map=new Map(),loading=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function validInn(v){
 const s=innNumber(v);if(!s)return "";
 const sum=(a,k)=>a.reduce((v,w,i)=>v+Number(s[i])*w,0)%11%10;
 if(s.length===10)return sum(s.slice(0,9),[2,4,10,3,5,9,4,6,8])===Number(s[9])?s:"";
 const tenth=sum(s.slice(0,10),[7,2,4,10,3,5,9,4,6,8]);
 const eleventh=sum(s.slice(0,11),[3,7,2,4,10,3,5,9,4,6,8]);
 return tenth===Number(s[10])&&eleventh===Number(s[11])?s:"";
}
async function page(start){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Read-only Bitrix connection not configured");
 const url=new URL("crm.requisite.list.json",base.endsWith("/")?base:base+"/");
 for(let i=0;i<2;i++){
  try{
   const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify({filter:{ENTITY_TYPE_ID:4},order:{ID:"ASC"},
     select:["ID","ENTITY_TYPE_ID","ENTITY_ID","RQ_INN"],start}),
    signal:AbortSignal.timeout(20000)});
   const data=await response.json();
   if(!response.ok||data.error||!Array.isArray(data.result))
    throw Error("Read-only requisite scan unavailable");
   return data;
  }catch(e){if(i)throw e;await sleep(950)}
 }
}
function consolidate(rows){
 const candidates=new Map();
 for(const r of rows){
  if(Number(r.ENTITY_TYPE_ID)!==4||!/^[1-9]\d*$/.test(String(r.ENTITY_ID||"")))continue;
  const id=String(r.ENTITY_ID),inn=validInn(r.RQ_INN);
  if(!candidates.has(id))candidates.set(id,new Set());
  if(inn)candidates.get(id).add(inn);
 }
 const out=new Map();let withInn=0,conflicts=0;
 for(const [id,ins] of candidates){
  if(ins.size===1){out.set(id,{status:"inn_recorded",inn:[...ins][0]});withInn++}
  else if(ins.size>1){out.set(id,{status:"inn_conflict",inn:""});conflicts++}
 }
 return {map:out,withInn,conflicts};
}
async function refresh(){
 if(loading)return;
 loading=true;state.status=state.updatedAt?"refreshing":"loading";
 try{
  const first=await page(0),found=[...first.result],total=Number(first.total??first.result.length);
  const size=Math.max(1,first.result.length);
  if(total>40000)throw Error("Too many CRM requisite rows");
  if(total>size){
   for(let start=size;start<total;start+=3*size){
    const starts=[start,start+size,start+2*size].filter(x=>x<total);
    const parts=await Promise.all(starts.map(page));
    for(const part of parts)found.push(...part.result);
   }
  }else if(first.next!=null){
   let pos=first.next,steps=0;
   while(pos!=null&&steps++<1000){
    const p=await page(pos);found.push(...p.result);pos=p.next;
   }
   if(pos!=null)throw Error("Incomplete requisite pagination");
  }
  const uniq=new Map(found.filter(x=>x?.ID).map(x=>[String(x.ID),x]));
  if(uniq.size<total)throw Error("Incomplete requisite snapshot");
  const result=consolidate([...uniq.values()]);
  map=result.map;state.status="ready";state.updatedAt=new Date().toISOString();
  state.rows=uniq.size;state.withInn=result.withInn;state.conflicts=result.conflicts;state.error=null;
  console.log(JSON.stringify({component:"topsense-requisites",event:"inn-coverage",
   requisiteRows:state.rows,companyIdsWithInn:state.withInn,conflicts:state.conflicts}));
 }catch(e){
  state.error=String(e.message||e).slice(0,140);state.status=state.updatedAt?"stale":"error";
  console.warn(JSON.stringify({component:"topsense-requisites",event:"scan-error",message:state.error}));
 }finally{loading=false}
}
function get(id){return map.get(String(id))||{status:"not_found",inn:""}}
function stats(){return {...state}}
module.exports={refresh,get,stats,validInn,consolidate};

"use strict";
// Read-only amount verification from invoices/contracts linked to an eligible deal.
// Never substitute CRM OPPORTUNITY for an invoice/contract sum.
const pdfParse=require("pdf-parse");
const MAX_BYTES=3*1024*1024;
let checked=0,withAmount=0,incomplete=0;
async function crm(method,params){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"").trim();
 if(!base)throw Error("Bitrix webhook missing");
 const url=new URL(method+".json",base.endsWith("/")?base:base+"/");
 const r=await fetch(url,{method:"POST",headers:{accept:"application/json","content-type":"application/json"},
  body:JSON.stringify(params),signal:AbortSignal.timeout(18000)});
 const j=await r.json().catch(()=>({}));
 if(!r.ok||j.error)throw Error("Read-only Bitrix request failed");
 return j.result;
}
function amountFromText(raw){
 const text=String(raw||"").replace(/\u00a0/g," ").replace(/\r/g,"\n");
 const lines=text.split(/\n+/).map(s=>s.replace(/\s+/g," ").trim()).filter(Boolean);
 const candidates=new Set();
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  // Only explicitly labelled totals, never line items or arbitrary numbers.
  const match=line.match(/(?:всего\s+(?:к\s+оплате|по\s+сч[её]ту)|итого\s+(?:к\s+оплате|с\s+ндс)|к\s+оплате|сумма\s+договора|общая\s+сумма\s+договора|всего\s+на\s+сумму|total\s+amount|amount\s+due)[^0-9\n]{0,80}([0-9][0-9 \u00a0\u202f]{0,17}(?:[,.][0-9]{2})?)(?:\s*(руб(?:лей|ля|\.|ль)?|₽|rub|rur))?/i);
  if(!match)continue;
  const n=Number(String(match[1]).replace(/[\s\u00a0\u202f]/g,"").replace(",","."));
  if(Number.isFinite(n)&&n>0&&n<100000000000)candidates.add(n);
 }
 return candidates.size===1?[...candidates][0]:null;
}
function candidateName(name){
 const s=String(name||"");
 return /(?:сч[её]т|invoice|договор|contract|контракт)/i.test(s)
   &&/\.(?:pdf|txt)$/i.test(s);
}
async function attachments(dealId){
 const arr=await crm("crm.activity.list",{
  order:{ID:"DESC"},filter:{OWNER_TYPE_ID:2,OWNER_ID:Number(dealId)},
  select:["ID","SUBJECT","FILES","STORAGE_ELEMENT_IDS"],start:0
 });
 const out=new Set();
 for(const a of Array.isArray(arr)?arr:[]){
  for(const f of Array.isArray(a.FILES)?a.FILES:[]){
   const id=Number(f.ID||f.id||0);if(id>0)out.add(id);
  }
  for(const id of Array.isArray(a.STORAGE_ELEMENT_IDS)?a.STORAGE_ELEMENT_IDS:[]){
   const n=Number(id);if(n>0)out.add(n);
  }
 }
 return [...out].slice(0,15);
}
async function download(meta){
 const base=new URL(process.env.BITRIX_WEBHOOK_BASE);
 const raw=String(meta.DOWNLOAD_URL||"");
 if(!raw||Number(meta.SIZE||0)>MAX_BYTES)return null;
 const url=new URL(raw,base.origin);
 if(url.hostname!==base.hostname||url.protocol!=="https:")return null;
 const r=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(16000)});
 if(!r.ok||r.status>=300||Number(r.headers.get("content-length")||0)>MAX_BYTES)return null;
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length>MAX_BYTES||b.length<20)return null;
 return b;
}
async function inspect(id){
 const meta=await crm("disk.file.get",{id:Number(id)});
 if(!meta)return null;
 const name=String(meta.NAME||"");
 if(!candidateName(name))return null;
 const buf=await download(meta);
 if(!buf)return {name,status:"unavailable"};
 let text="";
 try{
  if(/\.pdf$/i.test(name)){text=String((await pdfParse(buf))?.text||"")}
  else text=buf.toString("utf8");
 }catch{return {name,status:"unreadable"}}
 const amount=amountFromText(text);
 return {name,kind:/(?:сч[её]т|invoice)/i.test(name)?"invoice":"contract",amount,
  status:amount===null?"amount_not_clear":"amount_read"};
}
async function forDeal(dealId){
 checked++;
 try{
  const ids=await attachments(dealId);
  let known=0,unreadable=0;
  const docs=[];
  for(const id of ids){
   if(known>=5)break;
   try{
    const a=await inspect(id);
    if(a){known++;docs.push(a);if(a.status!=="amount_read")unreadable++}
   }catch{unreadable++}
  }
  const invoices=docs.filter(d=>d.kind==="invoice"&&d.amount!==null);
  const contracts=docs.filter(d=>d.kind==="contract"&&d.amount!==null);
  const pool=invoices.length?invoices:contracts;
  const amounts=[...new Set(pool.map(x=>x.amount))];
  if(amounts.length===1){
   withAmount++;
   return {amount:amounts[0],currency:"RUB",
    source:invoices.length?"Счёт":"Договор",status:"document_verified",
    documentCount:known,unreadable};
  }
  incomplete++;
  return {amount:null,currency:"",source:"",
    status:!ids.length?"no_documents_linked":amounts.length>1?"conflicting_document_totals":known?"no_clear_total":"document_unavailable",
    documentCount:known,unreadable};
 }catch{
  incomplete++;
  return {amount:null,currency:"",source:"",status:"document_scan_failed",documentCount:0,unreadable:0};
 }
}
function stats(){return {checked,withAmount,incomplete}}
module.exports={forDeal,stats,amountFromText};

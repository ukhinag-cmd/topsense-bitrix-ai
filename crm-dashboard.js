"use strict";
const crypto=require("crypto"),fs=require("fs"),path=require("path");
const state={status:"starting",updatedAt:null,error:null,companies:[],refreshing:false};
const sections=["Подрядчики","Предприятия","Интеграторы и проекты","Дистрибьюторы","Сервис и метрология","Конкуренты","Не определены"];
const freeDomains=new Set(["mail.ru","bk.ru","list.ru","inbox.ru","gmail.com","yandex.ru","ya.ru","yahoo.com","rambler.ru","outlook.com","hotmail.com","icloud.com","topsense.su","detector-gaza.ru"]);
const html=fs.readFileSync(path.join(__dirname,"crm-dashboard.html"),"utf8");
function write(res,status,body,type="application/json; charset=utf-8",headers={}) {
 const value=typeof body==="string"?body:JSON.stringify(body);
 res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY","content-security-policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",...headers});
 res.end(value);
}
function equals(a,b){const x=crypto.createHash("sha256").update(String(a)).digest(),y=crypto.createHash("sha256").update(String(b)).digest();return crypto.timingSafeEqual(x,y)}
function authorised(req){
 const pass=String(process.env.TOPSENSE_DASHBOARD_PASSWORD||"");
 if(pass.length<16)return false;
 try{
   const raw=req.headers.authorization||"";
   if(!raw.startsWith("Basic "))return false;
   const d=Buffer.from(raw.slice(6),"base64").toString("utf8"),idx=d.indexOf(":");
   return idx>0&&equals(d.slice(0,idx),"topsense")&&equals(d.slice(idx+1),pass);
 }catch{return false}
}
function value(x){if(Array.isArray(x))return x.map(value).filter(Boolean).join("; ");if(x&&typeof x==="object")return String(x.VALUE||x.value||"");return String(x||"")}
function domain(x){const m=value(x).match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);const d=m?m[1].toLowerCase():"";return d&&!freeDomains.has(d)?d:""}
function website(x){const raw=value(x).split(/[;,\s]+/)[0].trim();if(!raw)return "";try{const u=new URL(/^https?:\/\//i.test(raw)?raw:"https://"+raw);return ["https:","http:"].includes(u.protocol)?u.origin:""}catch{return ""}}
function category(name){
 const n=String(name||"").toLowerCase();
 if(/газоаналит|анкат|газоизмер|хроматэк|газсигнал/.test(n))return "Конкуренты";
 if(/асу.?тп|автоматизац|интеграт|автоматик|кипиа|кпиа/.test(n))return "Интеграторы и проекты";
 if(/ремонт|строй|монтаж|пусконалад|строитель|промфин|подряд|буров/.test(n))return "Подрядчики";
 if(/метролог|поверк|калибров|лаборатор|испытательн/.test(n))return "Сервис и метрология";
 if(/торг|снаб|дистриб|постав|трейд|комплект/.test(n))return "Дистрибьюторы";
 if(/нефт|газпром|лукойл|роснефт|газперераб|завод|комбинат|хим|металлург|горно|энергетик|цбк/.test(n))return "Предприятия";
 if(/проект|инжиниринг|проектир/.test(n))return "Интеграторы и проекты";
 return "Не определены";
}
function company(x){const id=String(x.ID||"");return {id,name:String(x.TITLE||""),category:category(x.TITLE),siteCandidate:website(x.WEB),corporateDomain:domain(x.EMAIL),crmUrl:"https://topsense.bitrix24.ru/crm/company/details/"+encodeURIComponent(id)+"/",modified:String(x.DATE_MODIFY||""),responsibleId:String(x.ASSIGNED_BY_ID||""),delivery:"Не проверено"}}
async function page(start){
 const base=String(process.env.BITRIX_WEBHOOK_BASE||"");
 if(!base)throw Error("Bitrix API not configured");
 const endpoint=new URL("crm.company.list.json",base.endsWith("/")?base:base+"/");
 for(let attempt=0;attempt<2;attempt++){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({order:{ID:"ASC"},filter:{},select:["ID","TITLE","WEB","EMAIL","DATE_MODIFY","ASSIGNED_BY_ID"],start}),signal:AbortSignal.timeout(18000)});
   const j=await r.json();
   if(!r.ok||j.error||!Array.isArray(j.result))throw Error(j.error_description||j.error||"Bad CRM response "+r.status);
   return j;
  }catch(e){if(attempt)throw e;await new Promise(resolve=>setTimeout(resolve,750))}
 }
}
async function refresh(){
 if(state.refreshing)return;
 state.refreshing=true;
 try{
  const first=await page(0),size=Math.max(1,first.result.length);
  const total=Number(first.total||size),parts=[first.result];
  if(total>6000)throw Error("CRM count exceeds safe limit");
  if(total>size){
    let starts=[];for(let offset=size;offset<total;offset+=size)starts.push(offset);
    for(let i=0;i<starts.length;i+=4){
     const pages=await Promise.all(starts.slice(i,i+4).map(page));
     pages.forEach(p=>parts.push(p.result));
    }
  }else if(first.next!=null){
    let next=first.next,j=0;while(next!=null&&j++<110){let p=await page(next);parts.push(p.result);next=p.next}
  }
  const map=new Map(parts.flat().filter(x=>x&&x.ID).map(x=>[String(x.ID),company(x)]));
  if(map.size<total)throw Error("Incomplete CRM snapshot "+map.size+"/"+total);
  state.companies=[...map.values()].sort((a,b)=>Number(a.id)-Number(b.id));
  state.status="ready";state.updatedAt=new Date().toISOString();state.error=null;
  console.log(JSON.stringify({component:"topsense-dashboard",event:"refresh-ok",count:map.size}));
 }catch(e){state.error=String(e.message||e).slice(0,160);state.status=state.companies.length?"stale":"error";console.warn(JSON.stringify({component:"topsense-dashboard",event:"refresh-error",error:state.error}));}
 finally{state.refreshing=false}
}
function data(known){
 const registry=new Map();
 for(const x of (typeof known==="function"?known():[])){
  if(x&&x.companyId&&["confirmed","rejected"].includes(x.verificationStatus))registry.set(String(x.companyId),x);
 }
 const records=state.companies.map(c=>{
  const r=registry.get(c.id);
  if(!r)return c;
  const type=String(r.contractorType||"").slice(0,160);
  let group=c.category;
  if(r.verificationStatus==="confirmed")group="Подрядчики";
  else if(/завод|комбинат|потребител|эксплуатир|теплоснабж/i.test(type))group="Предприятия";
  return {...c,category:group,type,siteVerified:String(r.website||""),strategy:String(r.strategicReason||"").slice(0,260),verification:"Проверено по реестру подрядчиков"};
 });
 const counts=Object.fromEntries(sections.map(v=>[v,0]));
 records.forEach(c=>counts[c.category]=(counts[c.category]||0)+1);
 return {ok:true,status:state.status,error:state.error,updatedAt:state.updatedAt,total:records.length,confirmed:records.filter(x=>x.type).length,counts,companies:records};
}
function route(req,res,pathname,known){
 if(!/^\/(contractors|dashboard|intel|company-intel)(\/|$)/.test(pathname))return false;
 if(!authorised(req)){write(res,401,"Доступ к аналитике требует авторизации","text/plain; charset=utf-8",{"www-authenticate":'Basic realm="TOP-SENSE CRM", charset="UTF-8"'});return true}
 if(req.method!=="GET"){write(res,405,{error:"Read-only"});return true}
 if(!state.refreshing&&(!state.updatedAt||Date.now()-Date.parse(state.updatedAt)>30*60*1000))refresh().catch(()=>{});
 if(["/intel/api","/dashboard/status","/contractors/status","/dashboard/contractors/status"].includes(pathname)){write(res,200,data(known));return true}
 if(["/contractors","/dashboard","/dashboard/contractors","/company-intel","/intel"].includes(pathname)){write(res,200,html,"text/html; charset=utf-8");return true}
 write(res,404,{error:"Not found"});return true;
}
module.exports={route,refresh,data};

"use strict";
const crypto=require("crypto"),fs=require("fs"),path=require("path");
const state={status:"starting",updatedAt:null,error:null,companies:[],refreshing:false,pilot:new Map(),pilotUpdatedAt:null,pilotLoading:false};
const ORG_TYPES=require("./company-types").types;
const sections=["Подрядчики","Конечные потребители","Сервис и метрология","Партнёрские продажи","Проектные продажи","Конкуренты","Смежные организации","Не определены"];
const freeDomains=new Set(["mail.ru","bk.ru","list.ru","inbox.ru","gmail.com","yandex.ru","ya.ru","yahoo.com","rambler.ru","outlook.com","hotmail.com","icloud.com","topsense.su","detector-gaza.ru"]);
const html=fs.readFileSync(path.join(__dirname,"crm-dashboard.html"),"utf8");
function write(res,status,body,type="application/json; charset=utf-8",headers={}) {
 const value=typeof body==="string"?body:JSON.stringify(body);
 res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY","content-security-policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",...headers});
 res.end(value);
}
function equals(a,b){const x=crypto.createHash("sha256").update(String(a)).digest(),y=crypto.createHash("sha256").update(String(b)).digest();return crypto.timingSafeEqual(x,y)}
function sessionKey(){return String(process.env.TOPSENSE_DASHBOARD_PASSWORD||"")}
function cookieValid(req){
 const key=sessionKey();if(key.length<16)return false;
 const raw=String(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("ts_crm_auth="));
 if(!raw)return false;
 const token=raw.slice("ts_crm_auth=".length),parts=token.split(".");
 if(parts.length!==2||!/^[0-9]+$/.test(parts[0]))return false;
 const ts=Number(parts[0]),age=Date.now()-ts;
 if(!Number.isSafeInteger(ts)||age<0||age>8*3600*1000)return false;
 const sig=crypto.createHmac("sha256",key).update(parts[0]).digest("hex");
 return equals(parts[1],sig);
}
function authorised(req){
 const pass=sessionKey();if(pass.length<16)return false;
 if(cookieValid(req))return true;
 try{
   const raw=req.headers.authorization||"";
   if(!raw.startsWith("Basic "))return false;
   const d=Buffer.from(raw.slice(6),"base64").toString("utf8"),idx=d.indexOf(":");
   return idx>0&&equals(d.slice(0,idx),"topsense")&&equals(d.slice(idx+1),pass);
 }catch{return false}
}
function loginPage(error){
 const note=error?"<p style='color:#b84132'>Проверьте логин и пароль.</p>":"";
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — вход</title><style>
 body{margin:0;min-height:100vh;background:#f3f7fa;font:16px system-ui;color:#16364c;display:grid;place-items:center}
 main{max-width:400px;width:calc(100% - 38px);background:white;border:1px solid #dfeaf0;box-shadow:0 12px 40px #16364c17;border-radius:20px;padding:32px}
 h1{font-size:27px;margin:0 0 9px}p{color:#66808e;font-size:14px;line-height:1.5}
 label{font-size:12px;font-weight:700;display:block;margin-top:17px}
 input{padding:14px;border:1px solid #cddce5;border-radius:10px;width:100%;box-sizing:border-box;margin-top:7px;font:inherit}
 button{background:#135b6c;color:white;border:0;border-radius:10px;padding:14px;width:100%;margin-top:22px;font:700 15px system-ui}
 </style></head><body><main><h1>ТОП-СЕНС</h1><p>Закрытая аналитика клиентской базы</p>${note}
 <form method="POST" action="/intel/login"><label>Логин<input name="username" value="topsense" required></label>
 <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
 <button type="submit">Открыть дашборд</button></form></main></body></html>`;
}
function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]))}
function initialHtml(payload){
 const subset=payload.companies.slice(0,12);

 let text=html;
 // Two independent dimensions: commercial dashboard and detailed organization type.
 // Keep all approved types visible, including those without verified assignments.
 const groups=[...new Set(ORG_TYPES.map(t=>t.family))];
 const groupHtml=groups.map(f=>{
   const items=ORG_TYPES.filter(t=>t.family===f);
   return '<details style="border-top:1px solid #315269;padding:6px 0"><summary style="cursor:pointer;padding:9px;color:#d7e8f0;font-size:12px">'+escapeHtml(f)+' · '+items.length+'</summary>'+
     items.map(t=>'<div style="font-size:11px;color:#a9c5d1;padding:7px 10px 8px 17px;line-height:1.35" title="'+escapeHtml(t.description)+'">'+escapeHtml(t.name)+'</div>').join("")+'</details>';
 }).join("");
 text=text.replace('<nav id="nav"></nav>',
   '<nav id="nav"></nav><div class="subbrand" style="margin-top:24px">45 типов организаций · полный справочник</div><div style="padding-bottom:20px">'+groupHtml+'</div>');
 text=text.replace('const categories=["Обзор","Подрядчики","Предприятия","Интеграторы и проекты","Дистрибьюторы","Сервис и метрология","Конкуренты","Не определены"];',
   'const categories=["Обзор","Подрядчики","Конечные потребители","Проектные продажи","Партнёрские продажи","Сервис и метрология","Конкуренты","Смежные организации","Не определены"];');
 const cards=subset.map(c=>{
   const verified=Boolean(c.type);
   return '<article class="item"><div class="top"><div class="itemname">'+escapeHtml(c.name)+'</div><span class="num">CRM '+escapeHtml(c.id)+'</span></div>'+
   '<div class="labels"><span class="flag '+(verified?'verified':'')+'">'+(verified?'Подтверждено':'Ожидает проверки')+'</span><span class="flag">'+escapeHtml(c.category)+'</span></div>'+
   '<div class="itemdesc">'+escapeHtml(c.type||'Классификация по названию — предварительная')+'</div>'+
   '<div class="links"><a href="'+escapeHtml(c.crmUrl)+'" target="_blank" rel="noopener noreferrer">Открыть в Битрикс24 ↗</a></div></article>'
 }).join("");
 const metrics=[["total",payload.total],["verified",payload.confirmed],["sites",payload.companies.filter(x=>x.siteCandidate).length],["pending",payload.total-payload.confirmed]];
 for(const [id,val] of metrics){
   text=text.replace('id="'+id+'">—</div>','id="'+id+'">'+Number(val).toLocaleString("ru-RU")+'</div>');
 }
 text=text.replace('id="cards"></div>','id="cards">'+(cards||'<div class="empty">Компании загружаются</div>')+'</div>');
 text=text.replace('id="count">—</span>','id="count">'+payload.total+' компаний</span>');
 return text;
}
function value(x){if(Array.isArray(x))return x.map(value).filter(Boolean).join("; ");if(x&&typeof x==="object")return String(x.VALUE||x.value||"");return String(x||"")}
function domain(x){const m=value(x).match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);const d=m?m[1].toLowerCase():"";return d&&!freeDomains.has(d)?d:""}
function website(x){const raw=value(x).split(/[;,\s]+/)[0].trim();if(!raw)return "";try{const u=new URL(/^https?:\/\//i.test(raw)?raw:"https://"+raw);return ["https:","http:"].includes(u.protocol)?u.origin:""}catch{return ""}}
function category(name){
 const n=String(name||"").toLowerCase();
 if(/газоаналит|анкат|газоизмер|хроматэк|газсигнал/.test(n))return "Конкуренты";
 if(/асу.?тп|автоматизац|интеграт|автоматик|кипиа|кпиа/.test(n))return "Проектные продажи";
 if(/ремонт|строй|монтаж|пусконалад|строитель|промфин|подряд|буров/.test(n))return "Подрядчики";
 if(/метролог|поверк|калибров|лаборатор|испытательн/.test(n))return "Сервис и метрология";
 if(/торг|снаб|дистриб|постав|трейд|комплект/.test(n))return "Партнёрские продажи";
 if(/нефт|газпром|лукойл|роснефт|газперераб|завод|комбинат|хим|металлург|горно|энергетик|цбк/.test(n))return "Конечные потребители";
 if(/проект|инжиниринг|проектир/.test(n))return "Проектные продажи";
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

// Pull the authorized, private model-classification checkpoint from the existing store.
// This creates no OpenAI calls and never writes to the CRM.
async function loadPilot(){
 if(state.pilotLoading)return;
 const endpoint=String(process.env.GOOGLE_SHEET_STORE_URL||"");
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"");
 if(!endpoint||!secret)return;
 state.pilotLoading=true;
 try{
  const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify({action:"load",secret}),signal:AbortSignal.timeout(18000)});
  const d=await r.json();
  if(!r.ok||d.ok===false)throw Error("private AI store read error");
  const entries=Array.isArray(d.rows)?d.rows:[];
  const x=new Map();
  for(const e of entries){
    if(!String(e.key||"").startsWith("pilot:v1:result:"))continue;
    const item=e.payload||{};
    if(item.companyId&&item.recordType==="topsense-pilot-result")x.set(String(item.companyId),item);
  }
  state.pilot=x;state.pilotUpdatedAt=new Date().toISOString();
  console.log(JSON.stringify({component:"topsense-dashboard",event:"ai-results-loaded",count:x.size}));
 }catch(error){
  console.warn(JSON.stringify({component:"topsense-dashboard",event:"ai-results-unavailable",error:String(error.message).slice(0,100)}));
 }finally{state.pilotLoading=false}
}
function commercialFromOrgType(t){
 const x=ORG_TYPES.find(z=>z.name===t);if(!x)return "";
 if(x.family==="Интеграторы"||x.family==="Проектирование")return "Проектные продажи";
 if(x.family==="Подрядчики")return "Подрядчики";
 if(x.family==="Торговля")return "Партнёрские продажи";
 if(x.family==="Сервис")return "Сервис и метрология";
 if(x.family==="Эксплуатация")return "Конечные потребители";
 if(x.family==="Смежные")return "Смежные организации";
 if(x.family==="Производители")return t.includes("газоаналитических")?"Конкуренты":"Проектные продажи";
 return "";
}
function data(known){
 const registry=new Map();
 for(const x of (typeof known==="function"?known():[])){
  if(x&&x.companyId&&["confirmed","rejected"].includes(x.verificationStatus))registry.set(String(x.companyId),x);
 }
 const records=state.companies.map(c=>{
  const r=registry.get(c.id);
  const ai=state.pilot.get(c.id);
  if(!r){
    if(!ai)return c;
    const orgType=String(ai.primaryType||"");
    const validType=ORG_TYPES.some(x=>x.name===orgType)&&ai.status==="classified";
    return {...c,
      category:validType?commercialFromOrgType(orgType)||c.category:c.category,
      type:validType?orgType:"",
      organizationType:validType?orgType:"",
      aiExplanation:String(ai.clientType||"").slice(0,180),
      siteVerified:ai.status==="classified"?String(ai.website||""):"",
      verification:ai.status==="classified"?"AI — требует проверки":String(ai.status||"").slice(0,50),
      aiStatus:String(ai.status||""),
      strategy:String(ai.proposedStrategy||"").slice(0,240),
      evidence:ai.source?[String(ai.source)]:[],
      delivery:"Не подтверждена"
    };
  }
  const type=String(r.contractorType||"").slice(0,160);
  let group=c.category;
  if(r.verificationStatus==="confirmed")group="Подрядчики";
  else if(/завод|комбинат|потребител|эксплуатир|теплоснабж/i.test(type))group="Конечные потребители";
  return {...c,category:group,type,organizationType:type,verificationStatus:r.verificationStatus,siteVerified:String(r.website||""),strategy:String(r.strategicReason||"").slice(0,260),verification:"Проверено по реестру подрядчиков"};
 });
 const counts=Object.fromEntries(sections.map(v=>[v,0]));
 records.forEach(c=>counts[c.category]=(counts[c.category]||0)+1);
 return {ok:true,status:state.status,error:state.error,updatedAt:state.updatedAt,total:records.length,confirmed:records.filter(x=>x.type).length,aiResults:state.pilot.size,aiLastChecked:state.pilotUpdatedAt,counts,organizationTypes:ORG_TYPES,organizationTypeCount:ORG_TYPES.length,companies:records};
}
function route(req,res,pathname,known){
 if(!/^\/(contractors|dashboard|intel|company-intel)(\/|$)/.test(pathname))return false;
 if(pathname==="/intel/login"&&req.method==="POST"){
   let body="",length=0;
   req.on("data",chunk=>{
     length+=chunk.length;
     if(length>4096){req.destroy();return}
     body+=chunk.toString("utf8");
   });
   req.on("end",()=>{
     const p=new URLSearchParams(body),username=p.get("username")||"",password=p.get("password")||"";
     const key=sessionKey();
     if(key.length>=16&&equals(username,"topsense")&&equals(password,key)){
       const ts=String(Date.now()),sig=crypto.createHmac("sha256",key).update(ts).digest("hex");
       res.writeHead(303,{"location":"/contractors","set-cookie":"ts_crm_auth="+ts+"."+sig+"; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax","cache-control":"no-store"});
       res.end();return;
     }
     write(res,401,loginPage(true),"text/html; charset=utf-8");
   });
   return true;
 }
 if(!authorised(req)){
   if(req.method==="GET"&&!pathname.endsWith("/api")&&!pathname.endsWith("/status")){
     write(res,200,loginPage(false),"text/html; charset=utf-8");return true;
   }
   write(res,401,{error:"Авторизация необходима"});return true;
 }
 if(req.method!=="GET"){write(res,405,{error:"Read-only"});return true}
 if(!state.refreshing&&(!state.updatedAt||Date.now()-Date.parse(state.updatedAt)>30*60*1000))refresh().catch(()=>{});
 if(!state.pilotLoading&&(!state.pilotUpdatedAt||Date.now()-Date.parse(state.pilotUpdatedAt)>65*1000))loadPilot().catch(()=>{});
 if(["/intel/api","/dashboard/status","/contractors/status","/dashboard/contractors/status"].includes(pathname)){write(res,200,data(known));return true}
 if(["/contractors","/dashboard","/dashboard/contractors","/company-intel","/intel"].includes(pathname)){write(res,200,initialHtml(data(known)),"text/html; charset=utf-8");return true}
 write(res,404,{error:"Not found"});return true;
}
// Preload the read-only snapshot when the dashboard module is first requested.
setTimeout(() => refresh().catch(() => {}), 1100);
setTimeout(() => loadPilot().catch(() => {}), 1500);
module.exports={route,refresh,data};

"use strict";
// Read-only triage of previously attempted paid research. No model calls,
// CRM writes, reservation resets, or automatic legal-identity changes.
const attempts=new Map();
let loadedAt=null;
const esc=s=>String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const digits=x=>/^[1-9]\d*$/.test(String(x||""));
function ingest(rows){
 attempts.clear();
 for(const row of rows||[]){
  const key=String(row?.key||"");
  const m=/^pilot:v([1234]):(result|reservation):(\d+)$/.exec(key);
  if(!m)continue;
  const id=m[3],version=Number(m[1]),kind=m[2];
  if(!digits(id))continue;
  const old=attempts.get(id)||{version:0,result:null,hasReservation:false};
  if(version>old.version){
   attempts.set(id,{version,result:kind==="result"?row.payload||{}:null,
    hasReservation:kind==="reservation"});
  }else if(version===old.version){
   if(kind==="result")old.result=row.payload||{};
   else old.hasReservation=true;
   attempts.set(id,old);
  }
 }
 loadedAt=new Date().toISOString();
 return attempts.size;
}
function category(entry){
 if(!entry)return "never_attempted";
 if(entry.hasReservation&&!entry.result)return "reservation_without_result";
 const status=String(entry.result?.status||"").toLowerCase();
 if(status==="review")return "review";
 if(status==="classified")return "previously_classified";
 if(/error|timeout|failed/.test(status))return "error";
 return entry.hasReservation?"reservation_without_result":"other_attempt";
}
function inspect(companies){
 const taxonomy=require("./client-taxonomy");
 const ledger=require("./classification-ledger");
 const completed=require("./client-finalization");
 const profiler=require("./website-profiler");
 const totals={review:0,reservation_without_result:0,error:0,
  previously_classified:0,other_attempt:0,never_attempted:0,
  already_qualified:0,provisional_prior_type:0,requires_identity_review:0,with_new_correspondence:0,
  verified_site_evidence:0,awaiting_independent_evidence:0};
 const items=[];
 for(const c of companies||[]){
  const ids=[...new Set((Array.isArray(c.crmIdList)&&c.crmIdList.length?c.crmIdList:[c.id])
   .map(String).filter(digits))];
  if(!ids.length||c.companyCardMissing)continue; // Historical deal-only lane is separate.
  const matches=ids.map(id=>({id,entry:attempts.get(id)})).filter(x=>x.entry);
  if(!matches.length)continue;
  const current=matches.sort((a,b)=>b.entry.version-a.entry.version)[0];
  const cat=category(current.entry);
  const isTyped=taxonomy.known(c.organizationType);
  const isActuallyFrozen=isTyped&&(
   c.classificationFrozen===true||
   c.verificationStatus==="confirmed"||
   taxonomy.known(c.verifiedOrgType)||
   ids.some(id=>completed.isComplete(id)||(ledger.get(id)?.rank||0)>=4));
  // Previous "typed" counts included name-only and AI-provisional guesses.
  // Such cases still need original correspondence research.
  if(isActuallyFrozen){
   totals.already_qualified++;
   continue;
  }
  if(isTyped)totals.provisional_prior_type++;
  // Status cards must count only unfinished cases, not historical results
  // for companies whose type is already verified and frozen.
  if(!(cat in totals))totals.other_attempt++;
  else totals[cat]++;
  const sites=ids.map(id=>profiler.get(id));
  const verified=sites.some(site=>site?.status==="site_profiled"&&taxonomy.known(site.siteType));
  const identityConflict=Boolean(c.companyIdentityReviewRequired)||
    sites.some(site=>site?.status==="site_identity_unclear")||
    (c.duplicateReviewRequired===true);
  const newMail=Boolean(c.hasNewCorrespondence);
  if(verified)totals.verified_site_evidence++;
  if(identityConflict)totals.requires_identity_review++;
  if(newMail)totals.with_new_correspondence++;
  if(!verified&&!newMail)totals.awaiting_independent_evidence++;
  const score=(newMail?120:0)+(verified?90:0)+(identityConflict?25:0)+
   ((c.dealEvidence||[]).length?15:0)+(cat==="reservation_without_result"?10:0);
  items.push({id:current.id,name:String(c.name||"").slice(0,180),
   category:cat,score,hasNewCorrespondence:newMail,
   siteEvidenceVerified:verified,identityReviewRequired:identityConflict,
   next:verified?"Проверить соответствие юридическому лицу и закрепить подтверждённый тип":
    newMail?"Изучить новые письма и документы сделки":
    identityConflict?"Сверить ИНН, название и юридическую принадлежность сайта":
    cat==="reservation_without_result"?"Сверить резервацию с историей API, не повторять оплату":
    cat==="error"?"Разобрать ошибку и проверить уже имеющиеся документы":
    "Найти независимое подтверждение деятельности"});
 }
 items.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,"ru"));
 return {loadedAt,total:items.length,totals,items};
}
function render(companies){
 const s=inspect(companies),t=s.totals,worker=require("./qualification-review-processor").stats();
 const card=(label,value)=>'<div style="border:1px solid #d7e2e9;border-radius:14px;padding:18px;background:#fff">'+
   '<div style="font-size:13px;color:#627b89">'+esc(label)+'</div><strong style="font-size:28px">'+esc(value)+'</strong></div>';
 const rows=s.items.slice(0,60).map(item=>
  '<article style="background:#fff;border:1px solid #d7e2e9;border-radius:12px;padding:14px 17px">'+
  '<div style="font-size:15px;font-weight:700">'+esc(item.name)+'</div>'+
  '<div style="font-size:12px;color:#607b89;margin-top:5px">CRM ID '+esc(item.id)+' · '+esc(item.category)+'</div>'+
  '<p style="font-size:13px;margin:10px 0 0">'+esc(item.next)+'</p></article>').join("");
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<title>ТОП-СЕНС — очередь квалификации</title></head>'+
  '<body style="margin:0;background:#f2f6f9;font-family:system-ui;color:#16364c"><main style="max-width:1100px;margin:35px auto;padding:0 18px">'+
  '<a href="/contractors" style="color:#166981">← Главный дашборд</a>'+
  '<h1>Очередь проверки квалификации</h1><p>Это отдельная бесплатная очередь проверки ранее исследованных предприятий. Типы компаний автоматически не меняются; новые запросы OpenAI и записи в Битрикс24 не выполняются.</p>'+
  '<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px">'+
  card("Нуждаются в проверке",s.total)+card("AI-результат review",t.review)+
  card("Резервация без результата",t.reservation_without_result)+card("С ошибками",t.error)+
  card("Есть подтверждённые данные сайта",t.verified_site_evidence)+
  card("Появилась новая переписка",t.with_new_correspondence)+
  card("Сделок направлено на проверку",worker.queued)+card("CRM-групп проверено",worker.checked)+
  card("Этапов чтения завершено",worker.checkpointed)+
  card("Досье с сохранёнными доказательствами",worker.dossiersPersisted||0)+'</section>'+
  '<h2 style="margin-top:35px">Приоритетные задания</h2>'+
  '<p style="color:#627b89;font-size:13px">Показаны первые 60; остальные сохраняются в общей очереди. Для смены типа требуется самостоятельное доказательство.</p>'+
  '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:11px">'+(rows||'<p>Нет заданий.</p>')+'</div></main></body></html>';
}
module.exports={ingest,inspect,render,category};

"use strict";
// One-time read-only handoff of the historical CRM-less backlog.
// Contains only metadata already available in deal list snapshots: no message
// bodies, phone numbers, attachments, private API tokens or credentials.
const discovery=require("./crm-unlinked-discovery");
const text=x=>String(x??"");
function snapshot(scope="unresolved"){
 const valid=scope==="all"?"all":"unresolved";
 const rows=discovery.unlinkedRecords();
 if(rows===null)return {ready:false,scope:valid,reason:
  "Полная выгрузка пока не готова: сервер восстанавливает историю CRM-сделок после перезапуска."};
 const selected=rows.filter(r=>valid==="all"||r.identityCandidates.length!==1);
 const identityKnown=rows.filter(r=>r.identityCandidates.length===1).length;
 const inspected=selected.filter(r=>r.inspectedThisProcess).length;
 return {ready:true,scope:valid,total:rows.length,
  exported:selected.length,identityKnown,inspectedThisProcess:inspected,
  latestFullHistoryAt:discovery.stats().updatedAt,rows:selected};
}
function safeCsvCell(input){
 let value=text(input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g," ").slice(0,520);
 // A deal title is untrusted spreadsheet input. Never allow formula execution
 // when an exported file is opened in Excel/Google Sheets.
 if(/^[\s]*[=+\-@]/u.test(value))value="'"+value;
 return '"'+value.replace(/"/g,'""')+'"';
}
function csv(snapshotValue){
 if(!snapshotValue?.ready)throw Error("Complete historical scan not ready");
 const header=["DEAL_ID","CRM_DEAL_URL","DEAL_TITLE","CREATED_AT","STAGE_ID",
  "CONTACT_ID","IDENTITY_STATUS","IDENTITY_CANDIDATE",
  "CANDIDATE_SOURCE","EMAIL_REVIEWED_THIS_SERVER_RUN",
  "FULL_HISTORY_SCAN_AT"];
 const records=snapshotValue.rows.slice().sort((a,b)=>Number(a.id)-Number(b.id));
 const body=records.map(r=>{
  const names=r.identityCandidates||[];
  const status=names.length===1?"identity_candidate_unverified":
   names.length>1?"conflicting_candidates":"identity_unresolved";
  return [r.id,"https://topsense.bitrix24.ru/crm/deal/details/"+
    encodeURIComponent(r.id)+"/",r.title,r.createdAt,r.stageId,
   r.contactId,status,names.map(n=>n.name).join(" | "),
   names.map(n=>n.reason).join(" | "),r.inspectedThisProcess?"yes":"no",
   snapshotValue.latestFullHistoryAt].map(safeCsvCell).join(",");
 }).join("\r\n");
 return "\ufeff"+header.map(safeCsvCell).join(",")+"\r\n"+body+"\r\n";
}
function summary(source){
 if(!source?.ready)return {ready:false,reason:source?.reason||"Historical CRM scan not ready"};
 return {ready:true,scope:source.scope,totalCrmLessDeals:source.total,
  includedDeals:source.exported,alreadyHasIdentityCandidate:source.identityKnown,
  emailsExaminedThisServerProcess:source.inspectedThisProcess,
  snapshotAt:source.latestFullHistoryAt,
  note:"A deal without COMPANY_ID is not proof of a missing legal company. No persistent global mark of 'never previously examined' exists yet; identity statuses are candidates and require first-email verification."};
}
module.exports={snapshot,csv,summary,safeCsvCell};

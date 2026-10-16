"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs");
const discovery=require("./crm-unlinked-discovery");
const exportApi=require("./deal-only-handoff-export");
test("Unlinked export refuses to claim a complete historical snapshot before an audit",()=>{
 assert.equal(exportApi.snapshot().ready,false);
});
test("Handoff CSV contains every unresolved/ambiguous CRM-less deal with stable CRM links",()=>{
 const deals=[
  {ID:"1101",TITLE:"Заявка на газоанализатор CH4",COMPANY_ID:"",DATE_CREATE:"2026-01-05"},
  {ID:"1102",TITLE:"ООО «Промышленная Безопасность» запрос КП",COMPANY_ID:"0",DATE_CREATE:"2026-01-06"},
  {ID:"1103",TITLE:"Заявка на О2",COMPANY_ID:"123",DATE_CREATE:"2026-01-07"},
  {ID:"1104",TITLE:"ООО «Первый Комбинат» / ООО «Второй Комбинат»",COMPANY_ID:"",DATE_CREATE:"2026-01-08"},
  {ID:"1105",TITLE:"=2+3",COMPANY_ID:"",DATE_CREATE:"2026-01-09"}
 ];
 discovery.ingest(deals,{complete:true});
 const unknown=exportApi.snapshot("unresolved");
 assert.equal(unknown.ready,true);
 assert.equal(unknown.total,4);
 assert.equal(unknown.exported,3);
 assert.deepEqual(unknown.rows.map(d=>d.id).sort(),["1101","1104","1105"]);
 const csv=exportApi.csv(unknown);
 assert.equal(csv.match(/https:\/\/topsense.bitrix24.ru\/crm\/deal\/details\//g).length,3);
 assert.ok(csv.includes('"\'=2+3"'),"Dangerous title must be non-executable text");
 assert.ok(!csv.includes('"1103"'),"A deal linked to a CRM company is excluded");
 assert.ok(!csv.includes('"1102"'),"Identified title is in separate optional full export");
 assert.equal(csv.split("\r\n").length,5);
 const all=exportApi.snapshot("all");
 assert.equal(all.exported,4);
 assert.equal(exportApi.summary(all).alreadyHasIdentityCandidate,1);
});
test("Existing core company classification continues but historical deal-only research is opt-in",()=>{
 for(const path of ["crm-dashboard.js","crm-sales-audit.js","deal-only-client-registry.js"]){
  const code=fs.readFileSync(path,"utf8");
  assert.match(code,/TOPSENSE_DEAL_ONLY_RESEARCH_ENABLED/);
  assert.match(code,/\|\|"0"/);
 }
});

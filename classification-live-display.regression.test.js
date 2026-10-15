"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const overview=require("./client-overview");
const list=require("./client-segments");
function fixture(typed){
 return {ok:true,status:"ready",updatedAt:"2026-10-15T11:30:00Z",
  companies:[],sourceCrmCount:1670,crmCardTotal:1670,virtualCustomerTotal:1559,
  classificationDisplay:{total:1560,typed:712,untyped:848,provisional:true,
   source:"last_complete_crm_population_changed",completedAt:"2026-10-15T09:40:21Z"},
  classificationLive:{ready:true,provisional:true,total:1559,typed,
   untyped:1559-typed,recoveredCandidates:2129,checkedAt:"2026-10-15T11:30:00Z"},
  siteCrawl:{checkedSites:201,queued:925,byStatus:{}},
  duplicateStats:{groupedCount:0,reviewGroupCount:0},
  incomingLeads:{pending:0},researchCompletion:{completed:0},
  paidClassification:{},counts:{},organizationTypes:[],
  classificationCensusReady:false,
  classificationCensusStore:{},requisites:{},taxonomy:{total:49}};
}
test("main headline rises as CRM classification progresses even with unfinished site scan",()=>{
 const html=overview.render(fixture(715),"Обзор").replace(/[\u00a0\u202f]/g," ");
 assert.match(html,/Тип определён<\/div><div class="metric-num"[^>]*>715<\/div>/);
 assert.match(html,/715 из 1 559/);
 assert.match(html,/Последний завершённый снимок: 712 из 1 560/);
 assert.match(html,/45\.9%/); // denominator is CRM virtual company count, not deal-only candidates
 const later=overview.render(fixture(716),"Обзор").replace(/[\u00a0\u202f]/g," ");
 assert.match(later,/Тип определён<\/div><div class="metric-num"[^>]*>716<\/div>/);
});
test("company list uses live total without silently folding potential deals into CRM company census",()=>{
 const html=list.html(fixture(715)).replace(/[\u00a0\u202f]/g," ");
 assert.match(html,/715 из 1 559/);
 assert.match(html,/2 129 компаний-кандидатов из сделок/);
});
test("when live reading is not ready, dashboard falls back to saved historical checkpoint",()=>{
 const payload=fixture(715);payload.classificationLive.ready=false;
 const html=overview.render(payload,"Обзор").replace(/[\u00a0\u202f]/g," ");
 assert.match(html,/Тип определён<\/div><div class="metric-num"[^>]*>712<\/div>/);
});

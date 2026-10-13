"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {consolidate}=require("./crm-duplicates");
function company(id,name,{email="",domain="",phone="",opf="",inn="",sale=false}={}){
 return {id:String(id),name,crmEmails:email?[email]:[],contactEmails:[],
  corporateDomain:domain,crmPhones:phone?[phone]:[],
  finance2025:{inn},crmUrl:"https://example.invalid/company/"+id,
  saleInfo:{purchaseStatus:sale?"БЫЛА":"НЕ БЫЛО",purchaseItems:sale?["ТС310"]:[],
   purchaseAmount:sale?100000:null,purchaseCurrency:sale?"RUB":"",purchaseDealCount:sale?1:0}};
}
function single(cards){const x=consolidate(cards);assert.equal(x.companies.length,1);assert.equal(x.duplicates.length,1);assert.equal(x.duplicates[0].count,cards.length);return x.companies[0]}
test("Short four-letter company with one domain, both ООО",()=>{
 const x=single([company(1,'ООО "ЭЛИС"',{email:"a@elis.ru"}),company(2,'ООО "Элис',{email:"b@elis.ru"})]);
 assert.deepEqual(x.crmIdList,["1","2"]);
});
test("Long distinctive name with one missing OPF and no email/domain: preliminary analytical merge",()=>{
 const x=single([company(1,"МАКСИНВЕСТ"),company(2,'ООО "МАКСИНВЕСТ"')]);
 assert.equal(x.duplicateConfidence,"exact_distinctive_name_provisional");
 assert.equal(x.name,"МАКСИНВЕСТ, ООО");
});
test("Industry abbreviation ИТЦ versus full name with shared corporate domain",()=>{
 const x=single([
  company(1,'ООО "Инженерно-Технический Центр СИГМА"',{email:"one@itc-sigma.ru"}),
  company(2,'ООО ИТЦ Сигма',{email:"two@itc-sigma.ru",sale:true})]);
 assert.equal(x.saleInfo.purchaseStatus,"БЫЛА");
 assert.equal(x.saleInfo.purchaseAmount,100000);
 assert.equal(x.crmEmails.length,2);
});
test("Short three-letter identity supported by same domain",()=>{
 single([company(1,"ИТК",{email:"one@itk.ru"}),company(2,"ИТК",{email:"two@itk.ru"})]);
});
test("Same group domain across different legal entities is not a duplicate",()=>{
 const x=consolidate([company(1,"Промышленный холдинг СЕВЕР",{email:"one@sever.ru"}),
  company(2,"Металлургия СЕВЕР",{email:"two@sever.ru"})]);
 assert.equal(x.duplicates.length,0);
 assert.equal(x.companies.length,2);
});
test("Conflicting OPFs must not cause a merge",()=>{
 const x=consolidate([company(1,'ООО "ТЕХПРОЕКТСЕРВИС"',{email:"a@techserv.ru"}),
  company(2,'АО "ТЕХПРОЕКТСЕРВИС"',{email:"b@techserv.ru"})]);
 assert.equal(x.duplicates.length,0);
});
test("Conflicting INNs prevent merging even with same name and domain",()=>{
 const x=consolidate([company(1,'ООО "ТЕХПРОЕКТСЕРВИС"',{email:"a@techserv.ru",inn:"7700000001"}),
  company(2,'ООО "ТЕХПРОЕКТСЕРВИС"',{email:"b@techserv.ru",inn:"7700000002"})]);
 assert.equal(x.duplicates.length,0);
});
test("Different domains for the same name must not be automatically merged",()=>{
 const x=consolidate([company(1,"ТЕХИНЖПРОЕКТ",{domain:"techone.ru"}),
  company(2,"ТЕХИНЖПРОЕКТ",{domain:"techtwo.ru"})]);
 assert.equal(x.duplicates.length,0);
});
test("Counts preserve every CRM card without double counting virtual clients",()=>{
 const data=[company(1,"ООО СПЕЦИНЖСЕРВИС",{email:"a@spinc.ru"}),
  company(2,"СПЕЦИНЖСЕРВИС",{email:"b@spinc.ru"}),
  company(3,"НЕФТЕГАЗТРЕЙД",{domain:"ngtrade.ru"})];
 const x=consolidate(data);
 assert.equal(x.stats.rawCompanyCount,3);
 assert.equal(x.stats.customerCardCount,2);
 assert.equal(x.stats.groupedCrmCardCount,2);
 assert.equal(x.stats.groupedCount,1);
});

"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const src=fs.readFileSync(path.join(__dirname,"crm-dashboard.js"),"utf8");
const overview=require("./client-overview");
function companyFromSource(){
 const module={exports:{}},names={};
 const requireMock=p=>{
  if(p==="crypto")return require("node:crypto");
  if(p==="fs")return {readFileSync:()=>""};
  if(p==="path")return {join:()=>"/test"};
  if(p==="./company-types")return require("./company-types");
  if(p==="./company-email-domains")return require("./company-email-domains");
  if(p==="./staff-evidence")return{fromCompany:()=>null};
  if(p==="./financial-2025")return{fromCompany:()=>({year:2025,amountRUB:null})};
  throw Error("Unexpected import "+p);
 };
 vm.runInNewContext(src+"\nmodule.exports.__testCompany=company;",{
  require:requireMock,module,exports:module.exports,process:{env:{}},
  URL,URLSearchParams,__dirname:"/test",setTimeout:()=>0,setInterval:()=>0,console:{log:()=>{},warn:()=>{}},
  Buffer
 },{filename:"crm-dashboard.js"});
 return module.exports.__testCompany;
}
const source=companyFromSource();
const company=(id,title,phone,email)=>source({ID:String(id),TITLE:title,
  PHONE:phone?[{VALUE:phone}]:[],EMAIL:email?[{VALUE:email}]:[]});
test("CRM #114 selects organization-specific Gazprom Neft subdomain by matching company name and phone",()=>{
 const c=company(114,"АВТОМАТИКА-СЕРВИС","+7 (3812) 27-77-27","AS-Mosk_dir@gazprom-neft.ru");
 assert.equal(c.siteCandidate,"https://avsv.gazprom-neft.ru/");
 assert.equal(c.corporateGroup,"ПАО Газпром нефть");
 assert.equal(c.verifiedOrgType,""); // independent references alone do not imply website crawled
 const site=overview.companyWebsiteDetails(c);
 assert.equal(site.url,"https://avsv.gazprom-neft.ru/");
 assert.equal(site.verified,false);
 const html=overview.render({companies:[{...c,organizationType:"Интегратор АСУ ТП"}]},"Обзор");
 assert.ok(html.includes("avsv.gazprom-neft.ru"));
 assert.ok(html.includes("отдельное юридическое лицо"));
});
test("A shared holding-company email domain cannot masquerade as each subsidiary's official website",()=>{
 const base=company(86,"ГАЗПРОМНЕФТЬ-БМ","+7 (812) 493-25-66","bitum@gazprom-neft.ru");
 assert.equal(base.corporateDomain,"gazprom-neft.ru");
 assert.equal(base.siteCandidate,"");
 assert.equal(overview.companyWebsiteDetails(base).url,"");
});
test("Wrong company name or phone does not attach the individually researched subdomain",()=>{
 for(const c of [
  company(114,"ЧУЖАЯ КОМПАНИЯ","+7 (3812) 27-77-27","info@gazprom-neft.ru"),
  company(114,"АВТОМАТИКА-СЕРВИС","+7 (495) 123-45-67","info@gazprom-neft.ru")
 ]){
  assert.equal(c.siteCandidate,"");
  assert.equal(overview.companyWebsiteDetails(c).url,"");
 }
});
test("A candidate site remains provisional until first-party company identity is checked",()=>{
 const c=company(114,"АВТОМАТИКА-СЕРВИС","+7 (3812) 27-77-27","info@gazprom-neft.ru");
 const site=overview.companyWebsiteDetails(c);
 assert.equal(site.candidate,true);
 assert.equal(site.verified,false);
});

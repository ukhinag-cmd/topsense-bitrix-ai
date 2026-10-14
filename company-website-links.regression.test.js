"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const overview=require("./client-overview");
const segments=require("./client-segments");
const type="Промышленный генподрядчик";
const data=(site)=>({companies:[{id:"4022",name:"ООО Инженерная компания",organizationType:type,category:"Подрядчики",
 siteProfileUrl:site,crmIdList:["4022"],crmUrl:"https://topsense.bitrix24.ru/crm/company/details/4022/",saleInfo:{}}],status:"ready",crmCardTotal:1});
test("Studied website makes the company name a direct external website link",()=>{
 const html=overview.render(data("https://example.org"),"Обзор",type,1);
 assert.ok(html.includes('class="companyWebsite" href="https://example.org/"'));
 assert.ok(html.includes("ООО Инженерная компания ↗</a>"));
 assert.ok(html.includes("Открыть в Bitrix24 ↗"));
});
test("Missing or unsafe website leaves plain company name and CRM link",()=>{
 for(const raw of ["","javascript:alert(1)","data:text/html,<script>alert(1)</script>","https://user:pw@evil.example/","http://localhost:8080"]){
  const html=overview.render(data(raw),"Обзор",type,1);
  assert.ok(!html.includes('class="companyWebsite"'),"Site should not be a link: "+raw);
  assert.ok(html.includes("ООО Инженерная компания"));
  assert.ok(html.includes("Открыть в Bitrix24 ↗"));
 }
});
test("The detailed client page also links the name to its known site",()=>{
 const html=segments.html(data("https://example.org"));
 assert.ok(html.includes("https://example.org/"));
 assert.ok(html.includes("Карточка Bitrix24"));
 assert.ok(html.includes("Перейти на сайт компании"));
});

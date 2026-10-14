"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const content=fs.readFileSync(path.join(__dirname,"pilot4.js"),"utf8");
test("Malformed paid response is checkpointed once; remaining companies continue; restart never recharges",async()=>{
 const rows=new Map(),logs=[];
 const type="Интегратор АСУ ТП";
 const companies=Array.from({length:1000},(_,i)=>({id:String(50000+i),organizationType:type,name:"already typed"}));
 companies[0]={id:"822",organizationType:"",name:"Malformed Response"};
 companies[1]={id:"823",organizationType:"",name:"Valid Response"};
 const env={TOPSENSE_PAID_CLASSIFICATION_ENABLED:"1",TOPSENSE_ANALYTICS_READONLY:"1",
  TOPSENSE_PAID_CLASSIFICATION_BUDGET_USD:"75",GOOGLE_SHEET_STORE_URL:"https://private.test",
  GOOGLE_SHEET_STORE_SECRET:"test-only",OPENAI_API_KEY:"test-only",BITRIX_WEBHOOK_BASE:"https://bitrix.test/"};
 let modelCalls=0;
 const json=data=>({ok:true,status:200,json:async()=>data});
 async function mockFetch(url,options={}){
  const u=String(url);
  if(u==="https://private.test"){
   const req=JSON.parse(options.body);
   if(req.action==="load")return json({ok:true,rows:[...rows].map(([key,payload])=>({key,payload}))});
   if(req.action==="upsert"){for(const r of req.rows)rows.set(r.key,r.payload);return json({ok:true})}
   throw Error("Unexpected store action");
  }
  if(u.startsWith("https://bitrix.test/crm.company.get.json")){
   const id=new URL(u).searchParams.get("ID");
   return json({result:{ID:id,TITLE:id==="822"?"Malformed Response":"Valid Response",WEB:[],EMAIL:[]}});
  }
  if(u==="https://api.openai.com/v1/responses"){
   modelCalls++;
   const req=JSON.parse(options.body);
   const invalid=String(req.input).includes("Malformed Response");
   const result={siteOwnership:"confirmed",primaryType:type,officialWebsite:"",additionalTypes:[],
    clientType:"",activities:"",companyStructure:"",topSenseFit:"",proposedStrategy:"",confidence:"high",reason:""};
   return json({output:[{content:[{type:"output_text",text:invalid?"":JSON.stringify(result)}]}],
    usage:{input_tokens:100,output_tokens:100}});
  }
  throw Error("Unexpected URL "+u);
 }
 const m={exports:{}};
 function mockRequire(p){
  if(p==="dns")return{promises:{lookup:async()=>[{address:"1.1.1.1"}]}};
  if(p==="net")return{isIP:()=>0};
  if(p==="./company-types")return{types:[{name:type}]};
  if(p==="./crm-dashboard")return{data:()=>({status:"ready",companies})};
  throw Error("Unexpected import "+p);
 }
 const context={module:m,exports:m.exports,require:mockRequire,process:{env},
  fetch:mockFetch,URL,AbortSignal,setTimeout:fn=>{fn();return 0;},
  console:{log:x=>logs.push(JSON.parse(x)),error:x=>logs.push(x)}};
 vm.runInNewContext(content,context,{filename:"pilot4.js"});
 const first=await m.exports.runPilot();
 assert.equal(first.status,"batch_complete");
 assert.equal(first.processed,2);
 assert.equal(first.errors,1);
 assert.equal(first.aiCalls,2);
 assert.equal(rows.get("pilot:v4:result:822").status,"api_or_storage_error");
 assert.equal(rows.get("pilot:v4:result:823").status,"classified");
 assert.ok(rows.has("pilot:v4:reservation:822"));
 assert.ok(rows.has("pilot:v4:reservation:823"));
 const second=await m.exports.runPilot();
 assert.equal(second.status,"queue_drained");
 assert.equal(modelCalls,2);
 assert.ok(logs.some(x=>x.event==="classification-error-recorded"));
});

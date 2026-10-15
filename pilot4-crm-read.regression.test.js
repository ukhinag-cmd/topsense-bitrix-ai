"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const code=fs.readFileSync(path.join(__dirname,"pilot4.js"),"utf8");
test("A timed-out CRM company is deferred before paid reservation; next companies continue",async()=>{
 const registry=Array.from({length:1000},(_,i)=>({id:String(60000+i),name:"already typed",organizationType:"Интегратор АСУ ТП"}));
 registry[0]={id:"1914",name:"Timeout CRM",organizationType:""};
 registry[1]={id:"1915",name:"Good CRM A",organizationType:""};
 registry[2]={id:"1916",name:"Good CRM B",organizationType:""};
 const entries=new Map(),events=[],modelIds=[],env={
  TOPSENSE_PAID_CLASSIFICATION_ENABLED:"1",TOPSENSE_ANALYTICS_READONLY:"1",TOPSENSE_PAID_CLASSIFICATION_BUDGET_USD:"75",
  OPENAI_API_KEY:"TEST-KEY",GOOGLE_SHEET_STORE_URL:"https://private-store.test",
  GOOGLE_SHEET_STORE_SECRET:"TEST-SECRET",BITRIX_WEBHOOK_BASE:"https://bitrix.test/"};
 let crmAvailable=false;
 const json=data=>({ok:true,status:200,json:async()=>data});
 async function fetchMock(url,options={}){
  const target=String(url);
  if(target==="https://private-store.test"){
   const body=JSON.parse(options.body);
   if(body.action==="load")return json({ok:true,rows:[...entries].map(([key,payload])=>({key,payload}))});
   if(body.action==="upsert"){
    for(const row of body.rows||[])entries.set(row.key,row.payload);
    return json({ok:true});
   }
   throw Error("unexpected storage action");
  }
  if(target.startsWith("https://bitrix.test/crm.company.get.json")){
   const id=new URL(target).searchParams.get("ID");
   if(id==="1914"&&!crmAvailable)throw Error("The operation was aborted due to timeout");
   return json({result:{ID:id,TITLE:"Company "+id,WEB:[],EMAIL:[]}});
  }
  if(target==="https://api.openai.com/v1/responses"){
   const body=JSON.parse(options.body);const id=/Company (\d+)/.exec(body.input)?.[1];
   modelIds.push(id);
   const response={siteOwnership:"confirmed",officialWebsite:"",primaryType:"Интегратор АСУ ТП",
    additionalTypes:[],clientType:"",activities:"",companyStructure:"",topSenseFit:"",
    proposedStrategy:"",confidence:"high",reason:""};
   return json({output:[{content:[{type:"output_text",text:JSON.stringify(response)}]}],
    usage:{input_tokens:100,output_tokens:100}});
  }
  throw Error("unexpected URL "+target);
 }
 const mockRequire=x=>{
  if(x==="dns")return{promises:{lookup:async()=>[{address:"1.1.1.1"}]}};
  if(x==="net")return{isIP:()=>0};
  if(x==="./company-types")return{types:[{name:"Интегратор АСУ ТП"}]};
  if(x==="./client-finalization")return{ingest:()=>0,isComplete:()=>false};
  if(x==="./client-taxonomy")return require("./client-taxonomy");
  if(x==="./crm-dashboard")return{data:()=>({status:"ready",companies:registry})};
  throw Error("Unexpected import "+x);
 };
 const module={exports:{}};
 const ctx={module,exports:module.exports,process:{env},require:mockRequire,
  fetch:fetchMock,URL,AbortSignal,setTimeout:fn=>{fn();return 0;},
  console:{log:x=>events.push(JSON.parse(x)),error:x=>events.push(x)}};
 vm.runInNewContext(code,ctx,{filename:"pilot4.js"});
 const first=await module.exports.runPilot();
 assert.equal(first.status,"batch_complete");assert.equal(first.processed,2);
 assert.equal(first.deferredCrmReads,1);assert.equal(first.aiCalls,2);
 assert.equal(entries.has("pilot:v4:reservation:1914"),false);
 assert.equal(entries.has("pilot:v4:result:1914"),false);
 assert.deepEqual(modelIds.sort(),["1915","1916"]);
 assert.ok(events.some(e=>e.event==="crm-read-deferred"&&e.id==="1914"));
 // In a later cycle, only the formerly unavailable CRM ID may be charged.
 crmAvailable=true;
 const second=await module.exports.runPilot();
 assert.equal(second.status,"batch_complete");assert.equal(second.aiCalls,1);
 assert.deepEqual(modelIds.sort(),["1914","1915","1916"]);
 assert.ok(Number(second.committedUsd)<=75);
});

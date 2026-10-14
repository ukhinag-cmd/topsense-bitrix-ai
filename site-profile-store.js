"use strict";
// Free, read-only website evidence is checkpointed in the EXISTING private
// Google Sheet store. No Bitrix mutations and no AI calls are made here.
const crypto=require("crypto");
const PREFIX="site-profile:v1:";
const TTL_MS=21*24*60*60*1000;
const statuses=new Set(["site_profiled","site_read_no_clear_type","site_read_ambiguous_type","site_identity_unclear"]);
const pending=new Map();
let timer=null,writing=false,loadedRows=0,storedRows=0,writeErrors=0,lastError="";

function configured(){
 return Boolean(String(process.env.GOOGLE_SHEET_STORE_URL||"").trim()&&String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim());
}
function inputUrl(c){
 if(c&&c.siteCandidate)return c.siteCandidate;
 if(c&&/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(c.corporateDomain||""))return "https://"+c.corporateDomain;
 return "";
}
function fingerprint(c){
 let host="";
 try{host=new URL(inputUrl(c)).hostname.toLowerCase().replace(/^www\./,"")}catch{}
 if(!host||!c?.id)return "";
 const identity=[
  String(c.id),
  String(c.name||"").toLocaleLowerCase("ru-RU").replace(/ё/g,"е").replace(/\s+/g," ").trim(),
  host,
  String(c.siteSource||"")
 ];
 return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function acceptable(profile){
 return Boolean(profile&&statuses.has(profile.status)&&
  (profile.status!=="site_profiled"||String(profile.siteType||"").trim()));
}
function fresh(row,now=Date.now()){
 if(!row||row.recordType!=="topsense-site-profile"||!acceptable(row.profile))return false;
 const timestamp=Date.parse(String(row.checkedAt||""));
 return Number.isFinite(timestamp)&&timestamp<=now&&now-timestamp<=TTL_MS&&
  /^[0-9a-f]{64}$/.test(String(row.fingerprint||""));
}
async function request(action,rows){
 const url=String(process.env.GOOGLE_SHEET_STORE_URL||"").trim();
 const secret=String(process.env.GOOGLE_SHEET_STORE_SECRET||"").trim();
 const body={action,secret};
 if(rows)body.rows=rows;
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
  body:JSON.stringify(body),redirect:"follow",signal:AbortSignal.timeout(20000)});
 const result=await response.json();
 if(!response.ok||result?.ok===false)throw Error("Existing private store request failed");
 return result;
}
async function load(){
 const map=new Map();
 if(!configured())return map;
 try{
  const response=await request("load");
  for(const row of (Array.isArray(response.rows)?response.rows:[])){
   const key=String(row?.key||"");
   const p=row?.payload;
   if(!key.startsWith(PREFIX)||!fresh(p))continue;
   const id=key.slice(PREFIX.length);
   if(!/^\d+$/.test(id)||String(p.companyId)!==id)continue;
   map.set(id,p);
  }
  loadedRows=map.size;lastError="";
 }catch(e){lastError="load_error";writeErrors++;console.warn(JSON.stringify({component:"site-profile-store",event:"restore-unavailable"}))}
 return map;
}
function restored(c,row,now=Date.now()){
 return fresh(row,now)&&row.fingerprint===fingerprint(c)?{...row.profile,restoredFromStore:true}:null;
}
function serialise(profile){
 return {status:profile.status,source:String(profile.source||"").slice(0,160),
  url:String(profile.url||"").slice(0,600),
  siteTitle:String(profile.siteTitle||"").slice(0,300),
  siteDescription:String(profile.siteDescription||"").slice(0,600),
  siteHeadings:(profile.siteHeadings||[]).slice(0,18).map(s=>String(s).slice(0,230)),
  sitePageCount:Number(profile.sitePageCount||0),
  sitePagesVisited:(profile.sitePagesVisited||[]).slice(0,6).map(s=>String(s).slice(0,600)),
  siteContactPages:(profile.siteContactPages||[]).slice(0,6).map(s=>String(s).slice(0,600)),
  siteActivityReason:String(profile.siteActivityReason||"").slice(0,260),
  siteType:profile.siteType||null,
  siteConfidence:String(profile.siteConfidence||"").slice(0,160),
  checkedAt:String(profile.checkedAt||new Date().toISOString())};
}
function schedule(ms=15000){
 if(timer||!configured())return;
 timer=setTimeout(()=>{timer=null;flush().catch(()=>{})},ms);
 if(typeof timer.unref==="function")timer.unref();
}
function queue(c,profile){
 if(!configured()||!acceptable(profile))return;
 const fp=fingerprint(c);
 if(!fp)return;
 const id=String(c.id);
 pending.set(PREFIX+id,{key:PREFIX+id,payload:{
  recordType:"topsense-site-profile",companyId:id,fingerprint:fp,
  checkedAt:String(profile.checkedAt||new Date().toISOString()),profile:serialise(profile)
 }});
 schedule();
}
async function flush(){
 if(!configured()||writing||!pending.size)return;
 writing=true;
 const rows=[...pending.values()].slice(0,20);
 for(const row of rows)pending.delete(row.key);
 try{
  await request("upsert",rows);
  storedRows+=rows.length;lastError="";
 }catch(e){
  writeErrors+=rows.length;lastError="save_error";
  // Failed batch is not discarded; keep newest evidence on conflicting keys.
  for(const row of rows)if(!pending.has(row.key))pending.set(row.key,row);
  console.warn(JSON.stringify({component:"site-profile-store",event:"checkpoint-unavailable",rows:rows.length}));
 }finally{
  writing=false;
  if(pending.size)schedule(lastError?60000:15000);
 }
}
function stats(){return {configured:configured(),cacheRowsLoaded:loadedRows,siteProfilesStored:storedRows,
 writeErrors,pendingWrites:pending.size,lastError};}
module.exports={configured,inputUrl,fingerprint,fresh,restored,load,queue,flush,stats};

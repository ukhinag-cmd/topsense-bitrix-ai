"use strict";
// Match the ORIGINAL inbound sender's corporate mail domain to the
// actual website host. CRM requisites, legal name and manager-entered
// company website are not prerequisites for customer type research.
const {extract}=require("./company-email-domains");
const s=v=>String(v||"").trim().toLowerCase().replace(/\.$/,"");
function senderDomain(raw){
 const v=s(raw).replace(/^www\./,"");
 if(!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(v))return "";
 return extract("original-sender@"+v).includes(v)?v:"";
}
function websiteDomain(raw){
 try{
  const u=new URL(String(raw||""));
  if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.port)return "";
  return s(u.hostname).replace(/^www\./,"");
 }catch{return ""}
}
function matches(sender,website){
 const a=senderDomain(sender),b=websiteDomain(website);
 return Boolean(a&&a===b);
}
module.exports={senderDomain,websiteDomain,matches};

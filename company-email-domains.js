"use strict";
// Public domain candidates only: never infer legal identity from email alone.
const freeDomains=new Set([
 "mail.ru","bk.ru","list.ru","inbox.ru","gmail.com","yandex.ru","ya.ru",
 "yahoo.com","rambler.ru","outlook.com","hotmail.com","icloud.com",
 "topsense.su","detector-gaza.ru"
]);
function flatten(input){
 if(Array.isArray(input))return input.flatMap(flatten);
 if(input&&typeof input==="object")return flatten(input.VALUE??input.value??"");
 return [String(input??"")];
}
function extract(input){
 const domains=[];
 for(const value of flatten(input)){
  for(const match of value.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)){
   const host=match[1].toLowerCase();
   if(host.includes("..")||freeDomains.has(host)||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host))continue;
   if(!domains.includes(host))domains.push(host);
  }
 }
 return domains;
}
function ranked(emails){
 const counts=new Map();
 for(const email of emails||[]){
  for(const host of extract(email))counts.set(host,(counts.get(host)||0)+1);
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
}
module.exports={extract,ranked};

"use strict";
// User-supplied leads are NEVER authoritative sites. The research worker
// cross-checks them against live read-only CRM requisites/contact evidence
// before promoting the candidate into analytics. Never write CRM here.
const candidates=new Map([
 ["38",{url:"https://is-16.su/",origin:"Пользователь 2026-10-15"}]
]);
function get(companyId){return candidates.get(String(companyId))||null}
module.exports={get};

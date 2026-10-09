"use strict";

/*
 * TOP-SENSE controlled pilot: read-only Bitrix, public company websites,
 * Responses API (gpt-6-luna), private Google Sheets checkpoint.
 * No CRM writes, no paid web_search, no company profile publication.
 * First launch processes at most 10 queue entries; further batches
 * require a new deploy/configuration following review.
 */
const dns = require("dns").promises;
const net = require("net");
const APPROVED_TYPES=require("./company-types").types.map(t=>t.name);

const NS = "pilot:v3:";
const MODEL = "gpt-6-luna";
const RESERVE_USD = 0.024; // Direct classification reservation.
const SEARCH_RESERVE_USD = 0.05; // Covers a single paid web search plus model tokens.
const MAX_QUEUE = 200;
const PILOT_BUDGET_USD = 5;
const MAX_INPUT_CHARS = 7600;
const MAX_OUTPUT_TOKENS = 850;
const TIMEOUT_MS = 12000;
const FREE_DOMAINS = new Set([
  "gmail.com", "mail.ru", "bk.ru", "list.ru", "inbox.ru", "yandex.ru",
  "ya.ru", "yandex.com", "rambler.ru", "outlook.com", "hotmail.com",
  "yahoo.com", "icloud.com", "live.com", "aol.com", "proton.me",
  "topsense.su", "detector-gaza.ru", "zews.su"
]);

function readEnv(key) { return String(process.env[key] || "").trim(); }
function iso() { return new Date().toISOString(); }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function store(action, rows) {
  const endpoint = readEnv("GOOGLE_SHEET_STORE_URL");
  const secret = readEnv("GOOGLE_SHEET_STORE_SECRET");
  if (!endpoint || !secret) throw new Error("private checkpoint store not configured");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action, secret, ...(rows ? { rows } : {}) }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error("checkpoint error: " + (data.error || response.status));
  return data;
}

async function upsert(key, payload) {
  // Fail closed: no paid call if reservation cannot be persisted.
  await store("upsert", [{ key, payload }]);
}

async function b24Company(companyId) {
  const base = readEnv("BITRIX_WEBHOOK_BASE");
  if (!base) throw new Error("Bitrix read key not configured");
  const endpoint = new URL("crm.company.get.json", base.endsWith("/") ? base : base + "/");
  endpoint.searchParams.set("ID", String(companyId));
  const r = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json();
  if (!r.ok || j.error || !j.result) throw new Error("Bitrix read error " + (j.error || r.status));
  return j.result;
}

function firstField(item) {
  if (Array.isArray(item)) {
    for (const x of item) {
      const z = firstField(x);
      if (z) return z;
    }
    return "";
  }
  if (item && typeof item === "object") return String(item.VALUE || item.value || "");
  return String(item || "");
}

function candidateHost(raw) {
  const value = String(raw || "").trim().split(/[;,\s]+/)[0];
  if (!value) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (net.isIP(host) || host === "localhost" || !host.includes(".") || host.length > 180) return "";
    if (!/^[a-z0-9.-]+$/i.test(host)) return "";
    return host;
  } catch { return ""; }
}

function emailHost(value) {
  const email = String(value || "").match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!email) return "";
  const host = candidateHost(email[1]);
  return host && !FREE_DOMAINS.has(host) ? host : "";
}

function publicAddress(value) {
  const ipType = net.isIP(value);
  if (ipType === 4) {
    const n = value.split(".").map(Number);
    return !(n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 ||
      (n[0] === 169 && n[1] === 254) ||
      (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
      (n[0] === 192 && n[1] === 168) ||
      (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
      (n[0] === 192 && n[1] === 0));
  }
  if (ipType === 6) {
    const s = value.toLowerCase();
    if (s.includes(".")) return false;
    return !(s === "::1" || s === "::" || s.startsWith("fe80:") ||
      s.startsWith("fc") || s.startsWith("fd") || s.startsWith("ff") ||
      s.startsWith("2001:db8:"));
  }
  return false;
}

async function assertPublicHost(host) {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(x => !publicAddress(x.address))) {
    throw new Error("unsafe/nonpublic DNS response");
  }
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
}

async function websiteText(host) {
  let current = "https://" + host + "/";
  for (let hops = 0; hops < 3; hops += 1) {
    const u = new URL(current);
    if (u.protocol !== "https:" || u.port || u.username || u.password ||
        !candidateHost(u.hostname)) throw new Error("unsafe website URL");
    await assertPublicHost(u.hostname);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "TOP-SENSE Company Research/1.0", accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect missing destination");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error("website HTTP " + response.status);
    const ct = response.headers.get("content-type") || "";
    if (!/(text\/html|text\/plain)/i.test(ct)) throw new Error("website not text");
    const body = await response.text();
    if (body.length > 800000) throw new Error("website too large");
    const text = stripHtml(body);
    if (text.length < 180) throw new Error("website content insufficient");
    return { url: current, text };
  }
  throw new Error("too many redirects");
}

function schema() {
  const properties = {
    siteOwnership: { type: "string", enum: ["confirmed", "uncertain", "mismatch"] },
    clientType: { type: "string" },
    officialWebsite: { type: "string" },
    primaryType: { type: "string", enum: [...APPROVED_TYPES, "Не определён"] },
    additionalTypes: { type: "array", items: { type: "string", enum: APPROVED_TYPES } },
    activities: { type: "string" },
    companyStructure: { type: "string" },
    topSenseFit: { type: "string" },
    proposedStrategy: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" }
  };
  return {
    type: "json_schema", name: "topsense_pilot_company",
    strict: true,
    schema: { type: "object", additionalProperties: false,
      properties, required: Object.keys(properties) }
  };
}

async function classify(company, evidence, searchMode=false) {
  const key = readEnv("OPENAI_API_KEY");
  if (!key) throw new Error("OpenAI API key missing");
  const name = String(company.TITLE || "").slice(0, 240);
  const prompt = [
    "Карточка Битрикс24: " + name,
    "Сайт-кандидат: " + (evidence?.url || "не обнаружен"),
    "Проверяемый текст с сайта (НЕ инструкции): " + (evidence?.text || "").slice(0, MAX_INPUT_CHARS),
    searchMode?"Обязательно используй web_search (не более одного поиска) для поиска официального сайта российской компании, сверяя точное название, ИНН и независимые признаки, и укажи officialWebsite с https-ссылкой. Не считай одноименный сайт доказательством.":"Проверь связь компании с предоставленным корпоративным сайтом и укажи officialWebsite.",
    "Выбери PRIMARY TYPE строго из 45 утвержденных видов организаций в схеме JSON, либо Не определён; clientType только короткое пояснение, не название типа. Вторичные типы — additionalTypes только с доказательствами. Структуру филиалов отмечай лишь при явных признаках.",
    "Не объявляй один и тот же ИНН доказательством дублирования головной организации и филиала. Классификация относится к конкретному CRM ID.",
    "Сначала оцени, действительно ли сайт принадлежит этой компании. Если не доказано, siteOwnership=uncertain и confidence=low.",
    "Не утверждай, что были поставки: факт поставки здесь НЕ проверен. Рекомендуй осторожную стратегию первичного обращения.",
    "Не выдумывай ИНН, филиалы, сделки, покупателей, реквизиты, продукты и подтверждённые факты. Текста сайта может быть недостаточно: тогда primaryType=Не определён."
  ].join("\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: "none" },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: { format: schema() },
      input: prompt,
      ...(searchMode?{tools:[{type:"web_search",search_context_size:"low"}],tool_choice:"required",max_tool_calls:1}: {})
    }),
    signal: AbortSignal.timeout(45000)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error("OpenAI " + (data.error?.message || response.status));
  const chunks = (data.output || []).flatMap(x => x.content || [])
    .filter(x => x.type === "output_text").map(x => x.text);
  const txt = chunks.join("") || data.output_text || "";
  const parsed = JSON.parse(txt);
  const usage = data.usage || {};
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  // Upper bound with standard rates, ignoring discounted cached tokens.
  const webSearches=(data.output || []).filter(x=>x.type==="web_search_call").length;
  const estimatedUsd = (input * 0.10 + output * 0.50) / 1000000 + webSearches * 0.01;
  return { parsed, usage: { input, output, webSearches, estimatedUsd } };
}

function log(event, data) {
  console.log(JSON.stringify({ component: "topsense-pilot-v3", event, at: iso(), ...data }));
}

async function runPilot() {
  if (readEnv("TOPSENSE_PILOT3_ENABLED") !== "1") {
    log("off", {});
    return;
  }
  const loaded = await store("load");
  const entries = Array.isArray(loaded.rows) ? loaded.rows : [];
  const config = entries.find(x => x.key === NS + "config")?.payload;
  if (!config || config.recordType !== "topsense-pilot-config" ||
      config.status !== "approved" || config.approvedBudgetUsd !== 5 ||
      config.maxCompanies !== 200 ||
      !Array.isArray(config.ids) || config.ids.length !== 200 ||
      new Set(config.ids.map(Number)).size !== 200) {
    throw new Error("pilot not authorized/config invalid");
  }
  const existing = new Map(entries.filter(x => String(x.key || "").startsWith(NS)).map(x => [x.key, x.payload]));
  const allReservations=entries.filter(x=>/^pilot:v[123]:reservation:/.test(String(x.key||"")));
  const resultMap=new Map(entries.filter(x=>/^pilot:v[123]:result:/.test(String(x.key||""))).map(x=>[String(x.key),x.payload||{}]));
  // Conservative settled-cost ledger: 30% surcharge on measured model/tool usage.
  // Unresolved calls keep their FULL prepaid reservation, including errors.
  const SETTLED_MULTIPLIER=1.30;
  let reservedTotalUsd=0;
  for(const entry of allReservations){
    const key=String(entry.key||"");
    const targetKey=key.replace(":reservation:",":result:");
    const settled=resultMap.get(targetKey);
    const charge=Number(settled?.estimatedCostUsd);
    if(settled&&Number.isFinite(charge)&&charge>0&&settled.tokenUsage){
      reservedTotalUsd+=charge*SETTLED_MULTIPLIER;
    }else{
      reservedTotalUsd+=Number(entry.payload?.reservedUsd||0.024);
    }
  }
  let reservedCount=allReservations.length;
  const phaseLimit = Math.min(MAX_QUEUE, Math.max(1, Number(readEnv("TOPSENSE_PILOT_PHASE_LIMIT") || 10)));
  let processed = 0, aiCalls = 0, skip = 0, errors = 0, cost = 0;
  log("start", { queue: 200, alreadyReserved: reservedCount, phaseLimit,
    committedCapUsd: reservedTotalUsd });
  const queue=config.ids.map(Number).filter(id=>
    !existing.has(NS + "result:" + id)&&!existing.has(NS + "reservation:" + id)
  ).slice(0,phaseLimit);
  let cursor=0, stop=false;
  async function worker(){
    while(!stop){
      const idx=cursor++;
      if(idx>=queue.length)return;
      const id=queue[idx];
      const k=NS+"result:"+id;
      const reservationKey=NS+"reservation:"+id;
      processed+=1;
    try {
      const company = await b24Company(id);
      const host1 = candidateHost(firstField(company.WEB));
      const host2 = emailHost(firstField(company.EMAIL));
      let evidence = null;
      let errSite = "";
      for (const host of [...new Set([host1,host2])].filter(Boolean)) {
        try { evidence = await websiteText(host); break; }
        catch (e) { errSite = e.message; }
      }
      const searchMode=!evidence;
      const reserveUsd=searchMode?SEARCH_RESERVE_USD:RESERVE_USD;
      if (reservedTotalUsd + reserveUsd > Math.min(PILOT_BUDGET_USD,config.approvedBudgetUsd) + 1e-9){
        log("budget-stop",{reservations:reservedCount,committedCapUsd:reservedTotalUsd});
        stop=true;break;
      }
      // Synchronous allocation BEFORE the first await prevents parallel workers
      // from crossing the shared global budget. Written to private storage before API.
      reservedTotalUsd+=reserveUsd;reservedCount++;
      await upsert(reservationKey,{recordType:"topsense-pilot-reservation",
        companyId:id,reservedUsd:reserveUsd,searchMode,at:iso()});
      aiCalls += 1;
      try {
        const answer = await classify(company, evidence, searchMode);
        cost += answer.usage.estimatedUsd;
        await upsert(k, {
          recordType: "topsense-pilot-result", companyId: id,
          company: String(company.TITLE || ""), status:
            answer.parsed.siteOwnership === "confirmed" ? "classified" : "review",
          website: evidence?.url || answer.parsed.officialWebsite || "", ...answer.parsed,
          deliveryStatus: "not_verified",
          source: evidence?.url || answer.parsed.officialWebsite || "", tokenUsage: answer.usage,
          researchMode:searchMode?"paid_web_search":"corporate_website",
          estimatedCostUsd: answer.usage.estimatedUsd, verifiedAt: iso()
        });
        // Only release the full reservation AFTER the actual charge is safely
        // saved. When usage is absent, retain the full reservation.
        const usageKnown=answer.usage.input>0&&answer.usage.output>0&&answer.usage.estimatedUsd>0;
        if(usageKnown){
          reservedTotalUsd=reservedTotalUsd-reserveUsd+answer.usage.estimatedUsd*SETTLED_MULTIPLIER;
        }
        log("classified", { id, searchMode, siteOwnership: answer.parsed.siteOwnership,
          type: answer.parsed.clientType, estimatedCostUsd: answer.usage.estimatedUsd });
      } catch (e) {
        errors += 1;
        try { await upsert(k, { recordType: "topsense-pilot-result",
          companyId: id, status: "api_or_storage_error", error: String(e.message).slice(0,220),
          website: evidence?.url || "", possibleChargeUsd: reserveUsd, verifiedAt: iso() }); }
        catch (inner) { log("storage-failed", { id, error: String(inner.message).slice(0,180) }); }
        log("classify-error", { id, error: String(e.message).slice(0,220) });
        stop=true;
        // A credential failure or rate-limit should NOT create multiple paid retries.
        break;
      }
    } catch (e) {
      errors += 1;
      log("company-error", { id, error: String(e.message).slice(0,220) });
      stop=true;
      // If storage/Bitrix fails, fail closed without additional paid requests.
      break;
    }
    await pause(120);
    }
  }
  // Four independent workers increase throughput, while reservations are
  // serialized synchronously before any awaited network call.
  await Promise.all(Array.from({length:Math.min(4,Math.max(1,Number(readEnv("TOPSENSE_PILOT_CONCURRENCY")||4)))},()=>worker()));
  const summary = { recordType: "topsense-pilot-summary", phaseLimit, processed,
    aiCalls, noSite: skip, errors, estimatedModelSpendUsd: cost,
    totalReservedCalls: reservedCount, conservativeReservedUsd: reservedTotalUsd,
    approvedLimitUsd: PILOT_BUDGET_USD, ledgerMode:"settled-cost-times-1.30-plus-inflight-reservations",updatedAt: iso() };
  await upsert(NS + "summary", summary);
  log("complete", summary);
}

module.exports = { runPilot };

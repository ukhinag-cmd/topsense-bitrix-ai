const SALES = {
  startedAt: new Date().toISOString(),
  lastEventAt: null,
  // Receipt and read-only processing are distinct: HTTP 200 does not
  // prove a CRM read completed. Track outcomes without storing payloads.
  lastProcessedEventAt: null,
  lastFailedEventAt: null,
  lastIgnoredEventAt: null,
  lastSyncAt: null,
  // A bounded page scan is incomplete until Bitrix stops returning next.
  syncPartial: false,
  syncCursor: 0,
  syncSince: null,
  // Track IDs through every bounded page, including resumed timer ticks.
  syncSeenIds: new Set(),
  // Total from an earlier Bitrix page is a scan-wide invariant. A shrinking
  // result set can shift offset pages and silently omit a deal.
  syncExpectedTotal: null,
  // Preserve DATE_MODIFY/ID ordering across pages and scheduled scan ticks.
  syncLastSortKey: null,
  lastError: null,
  // Track failed stage metadata independently of the most recent error.
  // Sync/event/store failures can overwrite lastError before the next retry.
  stageLookupFailed: false,
  // Track stage errors independently of event/sync/store errors so recovery
  // of one operation cannot falsely certify incomplete stage metadata.
  stageErrors: new Map(),
  stageCategoriesLoaded: new Set(),
  // Successful dictionaries also become stale when an admin edits a pipeline.
  stageLoadedAt: new Map(),
  stageCategoriesPending: new Set(),
  stageRequests: new Map(),
  syncing: false,
  deals: new Map(),
  managers: new Map(),
  managerLookupVersions: new Map(),
  stages: new Map(),
  dirty: new Set(),
  dirtyVersions: new Map(),
  flushing: false,
  flushTimer: null,
  syncTimer: null,
};

const SALES_PREFIX = "sales:deal:";
const MAX_HISTORY = 40;
const MAX_ALERTS = 8;
const DEAL_SYNC_LOOKBACK_DAYS = 45;
// Bitrix's unscheduled-activity sentinel is 9999-12-31 local time. When
// normalized to UTC, the same value can fall on 9999-12-30. Interpret both
// as missing Next Step rather than granting a fictitious future activity.
const NO_DEADLINE_FROM = Date.parse("9999-12-30T00:00:00Z");
// Bitrix stage edits do not necessarily update any deal's DATE_MODIFY.
// Poll successful dictionaries periodically rather than freezing them forever.
const STAGE_CACHE_TTL_MS = 30 * 60 * 1000;
// Render hosts may run in UTC, but TOP-SENS business dates are Moscow-local.
// Do not let the host's timezone shift Next Step days or score audit times.
// An optional IANA zone can be supplied for a different business locale.
const SALES_DISPLAY_TIME_ZONE = (() => {
  const configured = String(process.env.SALES_TIME_ZONE || "").trim() || "Europe/Moscow";
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: configured }); return configured; }
  catch { return "Europe/Moscow"; }
})();

function bitrixBaseUrl() {
  const raw = String(process.env.BITRIX_WEBHOOK_BASE || "").trim();
  if (!raw) throw new Error("BITRIX_WEBHOOK_BASE is not configured");
  // A Bitrix outbound webhook embeds its credential in the URL path.
  // Reject unencrypted or credential-bearing URLs before any CRM read.
  let base;
  try { base = new URL(raw); }
  catch { throw new Error("Invalid Bitrix webhook URL"); }
  if (base.protocol !== "https:" || base.username || base.password ||
      base.search || base.hash) {
    throw new Error("Insecure Bitrix webhook URL");
  }
  return raw.endsWith("/") ? raw : raw + "/";
}

function bitrixOrigin() {
  try { return new URL(bitrixBaseUrl()).origin; } catch { return "https://topsense.bitrix24.ru"; }
}

const READ_ONLY_BITRIX_METHODS = new Set([
  "crm.status.list",
  "user.get",
  "crm.deal.get",
  "crm.activity.get",
  "crm.deal.list",
]);

// A resolved transport can supply a non-JSON-shaped object: JSON.stringify
// silently drops hidden pagination keys (total/next) and replaces sparse array
// slots with null. A partial CRM page could then look complete. Verify the
// structural properties before cloning it within the credential-redaction
// boundary. This accepts ordinary JSON arrays/objects from any realm.
// Snapshot REST data without invoking toJSON hooks on untrusted objects.
// JSON.parse(JSON.stringify(response)) could turn a real CRM deal page into
// a forged empty page if a transport supplied a custom toJSON method.
function copyBitrixJson(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  // Parsed JSON cannot contain functions, symbols, undefined or BigInts.
  if (typeof value !== "object") throw new Error("Invalid Bitrix JSON value");
  if (ancestors.has(value)) throw new Error("Invalid Bitrix JSON cycle");
  const isArray = Array.isArray(value);
  const keys = Object.keys(value);
  // Parsed JSON has no hidden or symbol properties; only an array's length
  // can be non-enumerable. Reject hidden pagination markers before copying.
  if (Reflect.ownKeys(value).length !== keys.length + (isArray ? 1 : 0))
    throw new Error("Invalid Bitrix JSON hidden properties");
  if (isArray && (keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))))
    throw new Error("Invalid Bitrix JSON array");
  ancestors.add(value);
  const copy = isArray ? [] : Object.create(null);
  for (const key of keys) copy[key] = copyBitrixJson(value[key], ancestors);
  ancestors.delete(value);
  return copy;
}

async function bitrixRaw(method, params = {}) {
  // POST is the Bitrix REST transport; the REST method itself must be read-only.
  // Prevent accidental CRM writes if a future caller adds a mutating method.
  if (!READ_ONLY_BITRIX_METHODS.has(method)) {
    throw new Error("Read-only Bitrix method blocked");
  }
  const url = new URL(method + ".json", bitrixBaseUrl());
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(params),
      // The Bitrix webhook credential is in the URL path. Do not follow
      // redirects that might forward CRM data outside the configured origin.
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Fetch/redirect/timeout exceptions may contain the credential-bearing
    // Bitrix URL. Never expose their raw message in Sales health or logs.
    throw new Error("Bitrix REST " + method + " transport failed");
  }
  let payload;
  let responseOk;
  let safeStatus;
  try {
    // Even after fetch resolves, response.json/ok/status accessors and fields
    // within a custom transport's resolved JSON can throw exceptions bearing
    // the credential embedded in the Bitrix URL. Snapshot the entire JSON
    // response while still inside a redaction boundary. Do not return
    // accessor-bearing objects that bitrixCall or event handlers could read.
    responseOk = response.ok === true;
    const status = response.status;
    safeStatus = Number.isInteger(status) && status >= 100 && status <= 599
      ? status : "unknown";
    // A native fetch Response exposes the raw JSON text. JSON.parse alone
    // silently keeps the last duplicate object property, so an intermediary
    // could return {"result":[...],"result":[]} and falsely certify a
    // complete CRM read or overwrite a deal's score/history. Inspect the
    // actual wire response before trusting its parsed object. Mock-only
    // transports that implement json() without text() remain supported.
    let rawPayload;
    if (typeof response.text === "function") {
      const rawText = await response.text();
      rawPayload = JSON.parse(rawText);
      if (hasDuplicateJsonObjectKeys(rawText)) {
        throw new Error("Ambiguous Bitrix REST JSON keys");
      }
    } else {
      rawPayload = await response.json();
    }
    payload = copyBitrixJson(rawPayload);
  } catch {
    throw new Error("Bitrix REST " + method + " response read failed");
  }
  if (!responseOk || payload?.error) {
    // Remote error codes/descriptions are untrusted and may include a token.
    // Only the validated numeric HTTP status is safe diagnostic context.
    throw new Error("Bitrix REST " + method + " failed (HTTP " + safeStatus + ")");
  }
  // HTTP 200 with an HTML/JSON intermediary response is not a successful
  // Bitrix REST read. Treat a missing result as an error, not as an empty deal.
  if (!payload || typeof payload !== "object" ||
      !Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error("Invalid Bitrix REST response (missing result)");
  }
  return payload;
}

async function bitrixCall(method, params = {}) {
  return (await bitrixRaw(method, params)).result;
}

function storeConfigured() {
  return Boolean(
    String(process.env.GOOGLE_SHEET_STORE_URL || "").trim() &&
    String(process.env.GOOGLE_SHEET_STORE_SECRET || "").trim()
  );
}

// JSON.parse silently keeps only the last occurrence of a duplicate key.
// A CRM/Sheet intermediary could return {"ok":false,"ok":true}
// and make us discard unsaved score history. Inspect the original, syntactically
// valid JSON (including Unicode-escaped key aliases) before trusting any
// read or persistence acknowledgement. This is a lexical scan, not eval.
function hasDuplicateJsonObjectKeys(json) {
  const stack = [];
  for (let i = 0; i < json.length; i += 1) {
    const char = json[i];
    if (char === '"') {
      const start = i;
      for (i += 1; i < json.length; i += 1) {
        if (json[i] === '\\') { i += 1; continue; }
        if (json[i] === '"') break;
      }
      const container = stack[stack.length - 1];
      if (container?.kind === "object" && container.expectKey) {
        const name = JSON.parse(json.slice(start, i + 1));
        if (container.keys.has(name)) return true;
        container.keys.add(name);
        container.expectKey = false;
      }
    } else if (char === "{") {
      stack.push({ kind: "object", expectKey: true, keys: new Set() });
    } else if (char === "[") {
      stack.push({ kind: "array" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && stack[stack.length - 1]?.kind === "object") {
      stack[stack.length - 1].expectKey = true;
    }
  }
  return false;
}

async function storeRequest(action, rows = null) {
  if (!storeConfigured()) return null;
  const body = {
    action,
    secret: String(process.env.GOOGLE_SHEET_STORE_SECRET || "").trim(),
  };
  if (rows) body.rows = rows;
  // Fetch automatically repeats a POST (including its JSON secret) after
  // HTTP 307/308. A compromised store endpoint could redirect that request
  // to an unrelated host. Follow safe 301/302/303 redirects explicitly as
  // credential-free GETs (Google Apps Script redirects to googleusercontent).
  let configuredUrl;
  try {
    configuredUrl = new URL(String(process.env.GOOGLE_SHEET_STORE_URL || "").trim());
  } catch {
    throw new Error("Invalid Sales store URL");
  }
  // The Google Sheet store secret is sent in the initial POST body. Unlike
  // redirect handling, this first request was not checked for HTTPS and
  // could disclose the secret if the endpoint was misconfigured as HTTP.
  // Reject URL userinfo too: credentials must never live in a store URL.
  if (configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password) {
    throw new Error("Insecure Sales store URL");
  }
  let targetUrl = configuredUrl;
  let options = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  };
  let response;
  let responseStatus;
  let responseOk;
  for (let hops = 0; hops < 5; hops += 1) {
    try {
      response = await fetch(targetUrl, options);
    } catch {
      // Transport failures are untrusted: some clients include request URLs
      // and other credentials in their exception text.
      throw new Error("Sales store transport failed");
    }
    // A transport can resolve a response whose metadata getters then throw
    // secret-bearing errors. Keep all response access inside redaction guards.
    try {
      responseStatus = response.status;
      responseOk = response.ok === true;
    } catch {
      throw new Error("Sales store response metadata read failed");
    }
    if (![301, 302, 303, 307, 308].includes(responseStatus)) break;
    // Never replay the store secret in a POST, even to the same origin.
    if (responseStatus === 307 || responseStatus === 308) {
      throw new Error("Unsafe Sales store POST redirect blocked");
    }
    let location;
    try { location = response.headers?.get?.("location"); }
    catch { throw new Error("Sales store redirect header read failed"); }
    if (!location) throw new Error("Sales store redirect missing Location");
    let nextUrl;
    try { nextUrl = new URL(location, targetUrl); }
    catch { throw new Error("Invalid Sales store redirect URL"); }
    const googleScriptRedirect = targetUrl.hostname === "script.google.com" &&
      nextUrl.hostname === "script.googleusercontent.com";
    // Avoid using this credentialed integration as an arbitrary URL fetcher.
    // Google Apps Script is the only accepted cross-origin redirect.
    if (nextUrl.protocol !== "https:" || nextUrl.username || nextUrl.password ||
        (nextUrl.origin !== targetUrl.origin && !googleScriptRedirect)) {
      throw new Error("Untrusted Sales store redirect blocked");
    }
    targetUrl = nextUrl;
    options = {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    };
  }
  if ([301, 302, 303, 307, 308].includes(responseStatus)) {
    throw new Error("Sales store redirect limit exceeded");
  }
  let text;
  try { text = await response.text(); }
  catch { throw new Error("Sales store response read failed"); }
  let payload;
  try {
    payload = JSON.parse(text);
    // A conflicting duplicate "ok" or "rows" must not certify persistence
    // or make a partial stored history appear complete.
    if (hasDuplicateJsonObjectKeys(text)) throw new Error("Ambiguous store JSON keys");
  } catch { throw new Error("Invalid Sales store response"); }
  // HTTP 200 alone is not an acknowledgement: redirects, login pages or
  // malformed JSON must never cause pending score history to be discarded.
  if (!responseOk || !payload || typeof payload !== "object" ||
      Array.isArray(payload) ||
      // A legacy load may omit ok, but a present marker is a contract:
      // false, null, strings and objects cannot certify restored history.
      // HTTP 200 with {ok:"false",rows:[]} must not appear healthy.
      (Object.prototype.hasOwnProperty.call(payload, "ok") && payload.ok !== true)) {
    // Store-provided errors can echo its shared secret or sensitive URLs.
    // Report the failure without copying untrusted response fields.
    throw new Error("Sales store response failed");
  }
  // Existing read-only load responses may have rows without an ok flag.
  // Writes are different: never clear dirty history without explicit ok:true.
  if (action === "load") {
    if (!Array.isArray(payload.rows)) throw new Error("Invalid Sales store load response");
  } else if (payload.ok !== true) {
    throw new Error("Sales store write was not acknowledged");
  }
  return payload;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Preserve the *decimal* value supplied by Bitrix before converting a money
// string to an IEEE-754 Number. MAX_SAFE_INTEGER checks alone miss amounts
// such as "5000000000000000.50" (converted to 5000000000000000) and tiny
// nonzero values that underflow to zero. Normalize digits and decimal exponent
// without constructing enormous BigInts or expanding scientific notation.
// This also accepts harmless spellings such as "300.10" and "3.001e2".
function decimalFingerprint(value) {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? "";
  const digits = ((match[2] || "") + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  const exponent = Number(match[5] || 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(exponent)) return null;
  return (match[1] === "-" ? "-" : "") + significant + "e" + exponent;
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function dateValue(value) {
  if (typeof value === "string") {
    // Date.parse is permissive: "1" becomes January 2001 and an impossible
    // 2026-02-30 becomes March 2. Neither is an authentic Bitrix date.
    // Accept ISO dates and Bitrix/ISO datetimes (including explicit offsets),
    // then verify the Gregorian calendar before comparing CRM versions,
    // scoring stale contact, or hydrating persisted history.
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
        (match[4] !== undefined &&
          (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) ||
        // Date.parse accepts fictitious offsets such as +23:59. Bitrix
        // datetimes represent actual civil time zones (UTC offset <= 14h).
        // Reject impossible zones before they can shift score history,
        // DATE_MODIFY ordering, contact risk or Next Step dates.
        (match[7] !== undefined &&
          (Number(match[8]) > 14 || Number(match[9]) > 59 ||
           (Number(match[8]) === 14 && Number(match[9]) !== 0)))) return null;
  }
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

// Unix epoch (0 ms) is a valid CRM timestamp, not a missing date.
// Preserve it in age diagnostics, score provenance and overdue actions.
function daysSince(value) {
  const t = dateValue(value);
  return t !== null ? Math.max(0, (Date.now() - t) / 86400000) : null;
}

function isoOrNull(value) {
  const t = dateValue(value);
  return t !== null ? new Date(t).toISOString() : null;
}

// Bitrix DATE_MODIFY can include precision finer than JavaScript Date's
// millisecond resolution. Preserve that precision when ordering snapshots.
function compareBitrixTimestamp(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  if (ta < tb) return -1;
  if (ta > tb) return 1;

  const subMillisecond = value => {
    const match = value.match(/[T ]\d{2}:\d{2}:\d{2}(?:\.(\d+))?/i);
    return (match?.[1] || "").slice(3).replace(/0+$/, "");
  };
  const fa = subMillisecond(a);
  const fb = subMillisecond(b);
  const width = Math.max(fa.length, fb.length);
  const aa = fa.padEnd(width, "0");
  const bb = fb.padEnd(width, "0");
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

// DATE_MODIFY orders CRM versions, but a delayed CRM update can arrive after
// an already-recorded time-based score observation. Keep history chronological
// without changing the authoritative sourceUpdatedAt or inventing CRM changes.
function chronologicalHistoryAt(candidateAt, previousAt, observedAt = candidateAt) {
  const previous = dateValue(previousAt);
  const candidate = dateValue(candidateAt);
  if (previous === null || (candidate !== null && candidate >= previous)) return candidateAt;
  const observed = dateValue(observedAt);
  return observed !== null && observed >= previous ? observedAt : previousAt;
}

function stageCategoryId(value) {
  return value == null || value === false || value === "" ? "0" : String(value);
}

function stageKey(categoryId, stageId) {
  // STATUS_ID is only unique within a deal pipeline, not across pipelines.
  return stageCategoryId(categoryId) + ":" + String(stageId || "");
}

// Keep the CRM's directly supplied semantic separate from a value inferred
// from the stage dictionary. Reusing the inferred result as a direct field
// freezes a deal's outcome after a verified stage dictionary correction.
function sourceStageSemanticForRefresh(snapshot) {
  if (typeof snapshot.sourceStageSemantic === "string") {
    if (snapshot.sourceStageSemantic) return snapshot.sourceStageSemantic;
    // When a persisted classification came from a verified stage dictionary,
    // an outage on the next startup must not silently turn a won/lost deal
    // into an unknown open deal. Keep the last verified inference until this
    // pipeline's dictionary is loaded again. Once verified, use its current
    // semantics (including a genuinely missing stage) instead of stale data.
    return SALES.stageCategoriesLoaded.has(stageCategoryId(snapshot.categoryId))
      ? "" : snapshot.semantic;
  }
  // Older persisted snapshots predate sourceStageSemantic. A verified
  // pipeline dictionary is authoritative even when the old stage has been
  // deleted: retaining its last inferred S/F would fabricate a closed deal.
  // Only preserve the old inference while that pipeline is still unverified.
  return SALES.stageCategoriesLoaded.has(stageCategoryId(snapshot.categoryId))
    ? "" : snapshot.semantic;
}

function stageSemantic(deal) {
  const direct = String(deal.STAGE_SEMANTIC_ID || "").trim().toUpperCase();
  if (direct) return direct;
  const stage = SALES.stages.get(stageKey(deal.CATEGORY_ID, deal.STAGE_ID));
  return String(stage?.semantics || "").toUpperCase();
}

function isOpenSemantic(semantic) {
  return semantic !== "S" && semantic !== "F";
}

function money(value, currency = "RUB") {
  const code = String(currency || "RUB").trim().toUpperCase();
  const amount = num(value);
  // Bitrix can provide legitimate kopeks and even smaller decimal values.
  // Rounding to whole units rewrites the displayed deal, history and alerts.
  const fingerprint = decimalFingerprint(String(amount));
  const exponent = fingerprint?.includes("e") ? Number(fingerprint.split("e").pop()) : 0;
  const decimalPlaces = Math.max(0, -exponent);
  // Intl supports at most 20 decimal places. Preserve tiny nonzero amounts
  // explicitly rather than rendering them as zero currency.
  if (decimalPlaces > 20) return String(amount) + " " + code;
  const options = {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(2, decimalPlaces),
  };
  const formatted = new Intl.NumberFormat("ru-RU", options).format(amount);
  if (!/^[A-Z]{3}$/.test(code)) return formatted + " " + code;
  try {
    return new Intl.NumberFormat("ru-RU", {
      ...options, style: "currency", currency: code,
    }).format(amount);
  } catch {
    return formatted + " " + code;
  }
}

function shortDate(value) {
  const t = dateValue(value);
  if (t === null) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: SALES_DISPLAY_TIME_ZONE }).format(new Date(t));
}

function shortDateTime(value) {
  const t = dateValue(value);
  if (t === null) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: SALES_DISPLAY_TIME_ZONE,
  }).format(new Date(t));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadStagesForCategory(category) {
  try {
    // Bitrix has one independent stage dictionary per pipeline. Category 0
    // uses DEAL_STAGE, while every other category uses DEAL_STAGE_<id>.
    if (!/^(0|[1-9][0-9]*)$/.test(category) || !Number.isSafeInteger(Number(category))) {
      throw new Error("Invalid Bitrix stage category");
    }
    const entityId = category === "0" ? "DEAL_STAGE" : "DEAL_STAGE_" + category;
    const result = await bitrixCall("crm.status.list", {
      filter: { ENTITY_ID: entityId },
      order: { SORT: "ASC" },
    });
    // Keep the last known-good stage semantics on partial/malformed reads.
    // Clearing the live cache before validating the response could make a
    // new deal appear less qualified or more risky for no CRM reason.
    if (!Array.isArray(result)) throw new Error("Invalid Bitrix stage list response");
    const stages = new Map();
    for (const row of result) {
      // A list may be an array but still contain malformed stage records.
      // Validate every ID before replacing the known-good cache atomically.
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.STATUS_ID !== "string" || !row.STATUS_ID.trim() ||
          (row.ENTITY_ID != null && row.ENTITY_ID !== entityId)) {
        throw new Error("Invalid Bitrix stage metadata row");
      }
      // Bitrix deal stages often supply the real semantic in EXTRA.SEMANTICS
      // (process/success/failure) while top-level SEMANTICS is null.
      // Validate both fields before accepting a stage dictionary: otherwise
      // an array in EXTRA could coerce to a false "won" classification.
      if ((row.NAME != null && typeof row.NAME !== "string") ||
          (row.SEMANTICS != null && typeof row.SEMANTICS !== "string") ||
          (row.EXTRA != null && (typeof row.EXTRA !== "object" || Array.isArray(row.EXTRA))) ||
          (row.EXTRA?.SEMANTICS != null && typeof row.EXTRA.SEMANTICS !== "string")) {
        throw new Error("Invalid Bitrix stage metadata value");
      }
      // A stage with neither a short marker nor EXTRA semantics has no
      // verified outcome. Bitrix uses explicit SEMANTICS:null for process,
      // so absent is not equivalent to null. Reject the whole refresh rather
      // than replacing a trusted pipeline cache with unknown semantics and
      // silently changing Prospect/Risk Score while reporting healthy stages.
      if (row.SEMANTICS === undefined && row.EXTRA?.SEMANTICS == null) {
        throw new Error("Missing Bitrix stage semantics");
      }
      const semanticMap = { process: "P", success: "S", failure: "F", apology: "F" };
      const extraSemantic = String(row.EXTRA?.SEMANTICS || "").trim().toLowerCase();
      const mappedSemantic = Object.prototype.hasOwnProperty.call(semanticMap, extraSemantic)
        ? semanticMap[extraSemantic] : "";
      const shortSemantic = String(row.SEMANTICS || "").trim().toUpperCase();
      // Bitrix crm.status.list uses an explicit null short semantic for a
      // process stage. If optional EXTRA is missing, null still means "P";
      // when EXTRA exists, its outcome must agree with the short marker.
      const shortProcess = Object.prototype.hasOwnProperty.call(row, "SEMANTICS") &&
        row.SEMANTICS === null;
      // A present but blank short semantic is not Bitrix's documented
      // process marker (explicit null). Likewise an empty/whitespace-only
      // EXTRA.SEMANTICS does not establish any stage outcome. Keep the last
      // verified dictionary instead of silently rescoring deals as unknown.
      // A present-but-blank semantic marker is malformed even when the
      // other marker appears valid. Do not borrow a plausible P/S/F value
      // and silently replace the last verified pipeline classification.
      if ((typeof row.SEMANTICS === "string" && !row.SEMANTICS.trim()) ||
          (typeof row.EXTRA?.SEMANTICS === "string" && !row.EXTRA.SEMANTICS.trim())) {
        throw new Error("Blank Bitrix stage semantic marker");
      }
      if (!shortProcess && !shortSemantic && !mappedSemantic) {
        throw new Error("Missing Bitrix stage semantics");
      }
      if ((extraSemantic && !mappedSemantic) ||
          (shortSemantic && !["P", "S", "F"].includes(shortSemantic)) ||
          (shortSemantic && mappedSemantic && shortSemantic !== mappedSemantic) ||
          // The short null marker explicitly means a process stage. A long
          // success/failure alongside it is contradictory, not an accepted
          // closed outcome: keep the last verified stage cache instead.
          (shortProcess && mappedSemantic && mappedSemantic !== "P")) {
        throw new Error("Conflicting or unknown Bitrix stage semantics");
      }
      const stageId = row.STATUS_ID.trim();
      if (stages.has(stageId)) throw new Error("Duplicate Bitrix stage metadata ID");
      stages.set(stageId, {
        name: row.NAME || stageId,
        semantics: shortSemantic || mappedSemantic || (shortProcess ? "P" : ""),
      });
    }
    // An empty refresh is not proof that all previously verified stages
    // vanished. Transient empty REST results would otherwise erase their
    // names/semantics and silently reclassify active Dashboard deals.
    // Initial empty responses are still supported for backward compatibility.
    const prefix = category + ":";
    if (stages.size === 0 && [...SALES.stages.keys()].some(key => key.startsWith(prefix))) {
      throw new Error("Empty Bitrix stage metadata refresh");
    }
    // Replace only this pipeline's entries; malformed reads retain every
    // previously verified dictionary, including other pipelines.
    const updated = new Map(
      [...SALES.stages].filter(([key]) => !key.startsWith(prefix))
    );
    for (const [stageId, value] of stages) updated.set(prefix + stageId, value);
    SALES.stages = updated;
    SALES.stageCategoriesLoaded.add(category);
    SALES.stageLoadedAt.set(category, Date.now());
    SALES.stageCategoriesPending.delete(category);
    SALES.stageErrors.delete(category);
    SALES.stageLookupFailed = SALES.stageCategoriesPending.size > 0;
    // A different pipeline may still have a failed stage dictionary.
    if (SALES.lastError?.source === "stages") {
      SALES.lastError = SALES.stageErrors.values().next().value || null;
    }
  } catch (error) {
    SALES.stageCategoriesPending.add(category);
    SALES.stageLookupFailed = true;
    const stageError = { at: new Date().toISOString(), source: "stages", message: String(error.message || error) };
    SALES.stageErrors.set(category, stageError);
    SALES.lastError = stageError;
  }
}

async function loadStages(categoryId = "0") {
  const category = stageCategoryId(categoryId);
  // Coalesce simultaneous events referring to one previously unseen pipeline.
  // Otherwise late responses could overwrite the newer verified stage cache.
  const inFlight = SALES.stageRequests.get(category);
  if (inFlight) return inFlight;
  const request = loadStagesForCategory(category);
  SALES.stageRequests.set(category, request);
  try { await request; }
  finally { SALES.stageRequests.delete(category); }
}

async function ensureStageCategory(categoryId) {
  const category = stageCategoryId(categoryId);
  // Preserve the original default-pipeline retry cadence: start() and sync
  // refresh category 0. An event must not retry a failed startup lookup and
  // hide the stage health error before the scheduled sync can recover it.
  if (category === "0") return;
  if (!SALES.stageCategoriesLoaded.has(category) || SALES.stageCategoriesPending.has(category)) {
    await loadStages(category);
  }
}

async function managerName(id) {
  const key = String(id || "");
  // Bitrix uses 0 (as a string or number) for an unassigned deal.
  // It is not a user ID: never display #0 or issue user.get for it.
  if (!key || key === "0") return "—";
  if (SALES.managers.has(key)) return SALES.managers.get(key);

  // Concurrent event handlers can resolve user.get out of order. Only the
  // most recently started lookup may populate the shared manager cache.
  const lookupVersion = (SALES.managerLookupVersions.get(key) || 0) + 1;
  SALES.managerLookupVersions.set(key, lookupVersion);
  try {
    const users = await bitrixCall("user.get", { ID: Number(key) });
    // Bitrix may return a malformed/partial user list. A different user's
    // name must never be attributed to the deal's assigned manager.
    // A malformed user.get response may repeat the requested identity with
    // contradictory names. Taking the first match would display and cache an
    // arbitrary manager. Require exactly one verified matching record; a
    // duplicate remains retryable rather than poisoning the manager cache.
    const matchingUsers = Array.isArray(users)
      ? users.filter(candidate => candidate && typeof candidate === "object" &&
          !Array.isArray(candidate) && validDealId(candidate.ID) &&
          String(candidate.ID) === key)
      : [];
    const user = matchingUsers.length === 1 ? matchingUsers[0] : null;
    // user.get display fields must be scalar strings, just like the user ID.
    // String coercion otherwise turns ['Impostor'] into a believable manager
    // name and permanently caches a malformed identity for this manager.
    // Bitrix may return false/null for an unset text field; keep it empty.
    if (user && ["NAME", "LAST_NAME", "EMAIL"].some(field =>
        user[field] != null && user[field] !== false && typeof user[field] !== "string")) {
      return "#" + key;
    }
    const name = user
      ? [user.NAME, user.LAST_NAME].filter(Boolean).join(" ").trim() || String(user.EMAIL || "").trim()
      : "";
    // Do not cache an error or a missing/mismatched user as "#id".
    // Otherwise a temporary user.get failure poisons the dashboard forever.
    if (!name) return "#" + key;
    if (SALES.managerLookupVersions.get(key) === lookupVersion) {
      SALES.managers.set(key, name);
    }
    // A slow older lookup must not overwrite a newer lookup's name.
    return SALES.managers.get(key) || name;
  } catch {
    return "#" + key;
  }
}

function qualificationStatus(deal) {
  return String(deal.UF_CRM_AI_QUAL_STATUS || "").trim();
}

function clientType(deal) {
  return String(deal.UF_CRM_AI_CLIENT_TYPE || "").trim();
}

// A valid REST envelope may still contain a malformed or unrelated deal.
// Never silently acknowledge a webhook or mark a paginated scan complete
// if a row lacks a usable ID (or crm.deal.get returned a different deal).
function validDealId(value) {
  // JSON arrays such as ["42"] stringify to a legitimate-looking CRM ID.
  // Only canonical scalar IDs can identify a deal, activity or manager.
  if (typeof value !== "string" && typeof value !== "number") return false;
  const id = String(value);
  return /^[1-9]\d{0,14}$/.test(id) && Number.isSafeInteger(Number(id));
}

// CRM event and sync provenance must be an unambiguous datetime. JavaScript
// interprets an offset-free ISO timestamp in the host timezone (UTC in CI,
// potentially different on Render) and a date-only value as UTC midnight.
// Both can change version ordering, Risk Score or scheduled Next Step without
// any real Bitrix change. Bitrix REST datetime examples include Z/UTC offset.
// Keep dateValue's legacy date-only support for persisted/other display data.
function timezoneQualifiedCrmDateTime(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function validateDealRow(deal, expectedId = null) {
  if (!deal || typeof deal !== "object" || Array.isArray(deal) ||
      !validDealId(deal.ID) ||
      (expectedId !== null && String(deal.ID) !== String(expectedId))) {
    throw new Error("Invalid Bitrix deal record");
  }
  // ASSIGNED_BY_ID identifies the accountable manager. A malformed array
  // such as ['9'] becomes '9' in JavaScript and can attribute a deal to an
  // unrelated user.get identity. Accept only canonical scalar Bitrix IDs,
  // while preserving the CRM's empty/zero representations for unassigned.
  const assignedId = deal.ASSIGNED_BY_ID;
  if (assignedId != null && assignedId !== "" && assignedId !== false) {
    const scalar = typeof assignedId === "string" || typeof assignedId === "number";
    const canonical = String(assignedId) === "0" ||
      (validDealId(assignedId) && String(assignedId) === String(Number(assignedId)));
    if (!scalar || !canonical) {
      throw new Error("Invalid Bitrix deal ASSIGNED_BY_ID");
    }
  }
  // Bitrix monetary values are numeric strings (or numbers). Invalid
  // non-empty amounts must not silently become zero via num(): doing so
  // would falsify Prospect/Risk Score, pipeline totals and score history.
  // An absent/empty opportunity remains a legitimate zero-value deal.
  const opportunity = deal.OPPORTUNITY;
  if (opportunity != null && opportunity !== "") {
    const decimal = typeof opportunity === "string" &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(opportunity.trim());
    const amount = typeof opportunity === "number"
      ? opportunity : decimal ? Number(opportunity.trim()) : NaN;
    // IEEE-754 values above MAX_SAFE_INTEGER can silently round an exact
    // CRM price (9007199254740993 -> 9007199254740992) or overflow totals.
    // Never turn an untrustworthy amount into a score/history observation.
    const validAmount = Number.isFinite(amount) &&
      Math.abs(amount) <= Number.MAX_SAFE_INTEGER &&
      // A finite Number below MAX_SAFE_INTEGER can still silently discard
      // the fractional cents or all of a tiny nonzero decimal input.
      // Compare normalized decimal values, not IEEE-754 binary equality.
      (typeof opportunity !== "string" ||
        decimalFingerprint(opportunity.trim()) === decimalFingerprint(String(amount)));
    if (!validAmount) {
      throw new Error("Invalid Bitrix deal OPPORTUNITY amount");
    }
  }
  // These AI qualification fields are single-value text fields. Coercing
  // an array such as ["Квалифицировано"] to a string would fabricate an
  // affirmative qualification and inflate Prospect Score. Bitrix may use
  // false for an empty custom field; preserve that supported empty value.
  for (const field of ["UF_CRM_AI_QUAL_STATUS", "UF_CRM_AI_CLIENT_TYPE"]) {
    const value = deal[field];
    if (value != null && value !== false && typeof value !== "string") {
      throw new Error("Invalid Bitrix deal " + field + " value");
    }
  }
  // Bitrix deal titles, lead sources and pipeline categories are scalar
  // metadata. Coercing ['WEB'] or ['0'] would forge a believable value and
  // persist it in the Dashboard/score history. Keep empty Bitrix sentinels.
  for (const field of ["TITLE", "SOURCE_ID"]) {
    const value = deal[field];
    if (value != null && value !== false && typeof value !== "string") {
      throw new Error("Invalid Bitrix deal " + field + " value");
    }
  }
  const category = deal.CATEGORY_ID;
  if (category != null && category !== false && category !== "") {
    const scalar = typeof category === "string" || typeof category === "number";
    const text = scalar ? String(category) : "";
    if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new Error("Invalid Bitrix deal CATEGORY_ID");
    }
  }
  // Bitrix stage and currency fields are single-value strings. If an
  // intermediary returns ['S'] or ['RUB'], JavaScript string coercion would
  // otherwise invent a closed-won deal or count foreign money as RUB.
  // Unlike optional custom fields, false is not a valid stage/currency ID:
  // treating it as empty can silently default the currency to RUB.
  for (const field of ["STAGE_ID", "STAGE_SEMANTIC_ID", "CURRENCY_ID"]) {
    const value = deal[field];
    if (value != null && typeof value !== "string") {
      throw new Error("Invalid Bitrix deal " + field + " value");
    }
  }
  // A scalar Bitrix semantic must still be a recognized P/S/F outcome.
  // Otherwise an unknown direct value overrides a verified stage dictionary,
  // causing false open/risk classification while the sync looks healthy.
  // Normalize harmless whitespace and casing consistently with scoreDeal.
  const directSemantic = deal.STAGE_SEMANTIC_ID;
  if (typeof directSemantic === "string" && directSemantic.trim() &&
      !["P", "S", "F"].includes(directSemantic.trim().toUpperCase())) {
    throw new Error("Invalid Bitrix deal STAGE_SEMANTIC_ID");
  }
  // A nonzero deal amount without an explicit currency cannot safely be
  // treated as RUB. Earlier code defaulted blank/missing CURRENCY_ID to RUB,
  // which could invent RUB totals and size-based Prospect/Risk Score bonuses.
  // Keep zero-value deals compatible with Bitrix's optional currency field.
  if (Number(opportunity || 0) !== 0 &&
      (typeof deal.CURRENCY_ID !== "string" || !deal.CURRENCY_ID.trim())) {
    throw new Error("Missing Bitrix deal CURRENCY_ID for nonzero opportunity");
  }
  // DATE_MODIFY is the source-version key for ordering updates and
  // reconciling CRM reads with persisted history. A missing/blank version
  // must fail closed even when an otherwise valid deal ID was returned:
  // treating it as a new deal invents a version, while an existing deal
  // would silently acknowledge an update that could not be applied.
  if (typeof deal.DATE_MODIFY !== "string" || !deal.DATE_MODIFY.trim()) {
    throw new Error("Missing Bitrix deal DATE_MODIFY timestamp");
  }
  // Source timestamps, unlike planned Next Step dates, are observations of
  // events that already happened. A far-future CRM version would make later
  // legitimate updates look stale; a future contact hides risk indefinitely.
  // Allow 10 minutes of clock skew, as for snapshots loaded from the store.
  const latestPlausible = Date.now() + 10 * 60 * 1000;
  for (const field of ["DATE_MODIFY", "DATE_CREATE", "LAST_ACTIVITY_TIME", "MOVED_TIME"]) {
    const value = deal[field];
    if (value == null || value === "") continue;
    const timestamp = timezoneQualifiedCrmDateTime(value) ? dateValue(value) : null;
    // An unparseable observed date can silently erase stale-contact risk,
    // and a malformed DATE_MODIFY can bypass source-version ordering.
    // Reject malformed fields as well as dates too far in the future.
    if (timestamp === null || timestamp > latestPlausible) {
      throw new Error("Invalid Bitrix deal " + field + " timestamp");
    }
  }
  // A CRM deal cannot be modified before it was created. Accepting such
  // a read would give it an impossible stage-entry age, pollute Risk/Next
  // Step and produce a snapshot that fails validation on the next restart.
  // DATE_CREATE may be absent on legacy responses, but if supplied it must
  // not be later than the authoritative DATE_MODIFY source version.
  // Date.parse/dateValue keep only milliseconds. Bitrix can return more
  // fractional digits, and a same-millisecond update may actually predate
  // its creation. Reuse the source-version comparator's full precision.
  if (deal.DATE_CREATE && compareBitrixTimestamp(deal.DATE_CREATE, deal.DATE_MODIFY) > 0) {
    throw new Error("Invalid Bitrix deal DATE_CREATE chronology");
  }
  // A newer change to the deal must not predate its last stage move. Trust
  // MOVED_TIME only when it describes a possible transition within the
  // deal's lifetime; otherwise fail closed before altering Risk/history.
  if (deal.MOVED_TIME &&
      (compareBitrixTimestamp(deal.MOVED_TIME, deal.DATE_MODIFY) > 0 ||
       (deal.DATE_CREATE && compareBitrixTimestamp(deal.MOVED_TIME, deal.DATE_CREATE) < 0))) {
    throw new Error("Invalid Bitrix deal MOVED_TIME chronology");
  }
  // Future scheduled actions are legitimate, but a malformed non-empty
  // activity date would otherwise erase the verified Next Step and inflate
  // Risk Score. Do not impose the past-observation clock limit on plans.
  for (const field of ["ACTIVITY_TIME", "NEXT_ACTIVITY_TIME"]) {
    const value = deal[field];
    if (value == null || value === "") continue;
    if (!timezoneQualifiedCrmDateTime(value) || dateValue(value) === null) {
      throw new Error("Invalid Bitrix deal " + field + " timestamp");
    }
  }
  return deal;
}

// A successful REST envelope is not proof that crm.activity.get returned
// the requested activity. Reject malformed/mismatched owners rather than
// silently losing a webhook or reading an unrelated deal.
function validateActivityRow(activity, expectedId) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity) ||
      // Missing ID is not proof that this is the requested activity.
      // Never follow OWNER_ID for an unidentifiable activity response.
      !validDealId(activity.ID) || String(activity.ID) !== String(expectedId)) {
    throw new Error("Invalid Bitrix activity record");
  }
  const ownerTypeValue = activity.OWNER_TYPE_ID;
  const ownerType = (typeof ownerTypeValue === "string" || typeof ownerTypeValue === "number")
    ? String(ownerTypeValue) : "";
  if (!/^[1-9]\d*$/.test(ownerType) || !Number.isSafeInteger(Number(ownerType))) {
    throw new Error("Invalid Bitrix activity owner type");
  }
  if (ownerType === "2" && !validDealId(activity.OWNER_ID)) {
    throw new Error("Invalid Bitrix activity deal owner");
  }
  return activity;
}

// Bitrix crm.activity.list uses 9999-12-31 for an activity without a
// deadline. A legacy/extended deal response may carry that sentinel in an
// activity-time field; it must not appear as a future Next Step, increase
// Prospect Score, or suppress Risk Score. Neither optional deal field has
// established priority: when both contain real dates, use the earliest
// candidate, including an overdue date, rather than the first array slot.
// Activity-list verification is still required for a trusted Next Step.
function scheduledActivityTime(deal) {
  return [deal.ACTIVITY_TIME, deal.NEXT_ACTIVITY_TIME].reduce((earliest, value) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
        Date.parse(value) >= NO_DEADLINE_FROM) return earliest;
    return earliest === null || Date.parse(value) < Date.parse(earliest) ? value : earliest;
  }, null);
}

function scoreDeal(deal, previous) {
  const semantic = stageSemantic(deal);
  const stageSemanticKnown = semantic === "P" || semantic === "S" || semantic === "F";
  const open = isOpenSemantic(semantic);
  const amount = num(deal.OPPORTUNITY);
  const currency = String(deal.CURRENCY_ID || "RUB").trim().toUpperCase();
  const amountIsRub = currency === "RUB";
  // DATE_CREATE is the authoritative CRM creation timestamp. BEGINDATE is
  // the separately planned start date, not proof of when this deal existed.
  // Falling back to a historical BEGINDATE falsely adds deal-age Risk Score.
  const createdAt = deal.DATE_CREATE || null;
  const modifiedAt = deal.DATE_MODIFY || null;
  const lastActivityAt = deal.LAST_ACTIVITY_TIME || null;
  const nextActivityAt = scheduledActivityTime(deal);
  const lastAge = daysSince(lastActivityAt);
  const dealAge = daysSince(createdAt);
  const nextTs = dateValue(nextActivityAt);
  const hasNext = nextTs !== null && nextTs > Date.now() - 5 * 60 * 1000;
  const nextOverdue = nextTs !== null && nextTs < Date.now() - 5 * 60 * 1000;
  const qual = qualificationStatus(deal);
  // Only an affirmative qualification status earns the full scoring bonus.
  // A status such as "Не квалифицировано" must not match a substring search.
  const qualificationConfirmed = /^квалифицировано$/i.test(qual);
  const type = clientType(deal);
  const stageId = String(deal.STAGE_ID || "");
  const nowIso = new Date().toISOString();

  // Bitrix exposes the last actual stage transition separately from edits.
  // Prefer that verified CRM timestamp; older snapshots and portals without
  // MOVED_TIME retain their explicit DATE_MODIFY estimate.
  let stageEnteredAt = deal.MOVED_TIME ||
    previous?.stageEnteredAt || deal.DATE_MODIFY || deal.DATE_CREATE || nowIso;
  // Pipeline IDs scope stage IDs: moving between pipelines counts as
  // entering a new stage even when both pipelines call that stage "NEW".
  // Otherwise stale stage age can add 15-25 phantom Risk Score points.
  if (previous && (previous.stageId !== stageId ||
      (previous.categoryId != null && previous.categoryId !== stageCategoryId(deal.CATEGORY_ID)))) {
    // A delayed webhook/sync can reveal a stage move that occurred days ago.
    // DATE_MODIFY is the latest verified time that the move could have
    // happened; using observation time would erase overdue stage-age risk.
    // CRM versions are validated before scoreDeal is called for live rows.
    stageEnteredAt = isoOrNull(deal.MOVED_TIME) || isoOrNull(deal.DATE_MODIFY) || nowIso;
  }
  const stageAge = daysSince(stageEnteredAt);

  let prospect = 0;
  if (open && stageSemanticKnown) prospect += 10;
  if (amount > 0) prospect += 15;
  // Monetary thresholds are calibrated in RUB. Never compare a foreign-currency
  // nominal amount to RUB thresholds without an explicit exchange-rate source.
  if (amountIsRub && amount >= 50000) prospect += 10;
  if (amountIsRub && amount >= 200000) prospect += 10;
  if (amountIsRub && amount >= 1000000) prospect += 5;
  if (type) prospect += 10;
  if (qualificationConfirmed) prospect += 20;
  else if (qual) prospect += 8;
  if (hasNext) prospect += 15;
  if (lastAge !== null && lastAge <= 3) prospect += 10;
  else if (lastAge !== null && lastAge <= 7) prospect += 5;
  // Bitrix prefixes the initial NEW stage with the pipeline identifier
  // (e.g. C7:NEW). A new deal in a custom pipeline has not progressed.
  if (stageId && !/^(?:C[0-9]+:)?NEW$/i.test(stageId)) prospect += 5;
  prospect = clamp(prospect);

  let risk = 0;
  if (open) {
    // Missing stage semantics must not make the deal look safer or more promising.
    if (!stageSemanticKnown) risk += 20;
    if (!hasNext) risk += 30;
    if (nextOverdue) risk += 15;
    if (lastAge === null) risk += 15;
    else if (lastAge > 14) risk += 35;
    else if (lastAge > 7) risk += 25;
    else if (lastAge > 3) risk += 12;
    if (dealAge !== null && dealAge > 60) risk += 18;
    else if (dealAge !== null && dealAge > 30) risk += 10;
    if (stageAge !== null && stageAge > 20) risk += 25;
    else if (stageAge !== null && stageAge > 10) risk += 15;
    if (amountIsRub && amount >= 500000) risk += 8;
  }
  risk = clamp(risk);

  const qualificationIssue = open && (
    (prospect >= 60 && !qual) ||
    (prospect >= 65 && !qualificationConfirmed) ||
    (amountIsRub && amount >= 100000 && !type)
  );

  let nextStep = "";
  if (!stageSemanticKnown) {
    nextStep = "Проверить стадию — семантика Bitrix не определена";
  } else if (!open) {
    nextStep = semantic === "S" ? "Сделка завершена успешно" : "Сделка закрыта без продажи";
  } else if (nextOverdue) {
    nextStep = "Просрочено следующее действие — перепланировать";
  } else if (!hasNext) {
    nextStep = "Назначить следующее действие";
  } else if (risk >= 60) {
    nextStep = "РОП: проверить риск и план закрытия";
  } else {
    nextStep = "Следующее действие: " + shortDate(nextActivityAt);
  }

  const stage = SALES.stages.get(stageKey(deal.CATEGORY_ID, stageId));
  return {
    semantic,
    stageSemanticKnown,
    open,
    amount,
    createdAt: isoOrNull(createdAt),
    modifiedAt: isoOrNull(modifiedAt),
    lastActivityAt: isoOrNull(lastActivityAt),
    nextActivityAt: isoOrNull(nextActivityAt),
    stageEnteredAt: isoOrNull(stageEnteredAt) || nowIso,
    stageAgeDays: stageAge === null ? null : Math.round(stageAge * 10) / 10,
    dealAgeDays: dealAge === null ? null : Math.round(dealAge * 10) / 10,
    lastActivityAgeDays: lastAge === null ? null : Math.round(lastAge * 10) / 10,
    hasNext,
    nextOverdue,
    prospectScore: prospect,
    riskScore: risk,
    qualificationIssue,
    qualificationStatus: qual,
    clientType: type,
    stageName: stage?.name || stageId || "—",
    nextStep,
  };
}

function addAlert(snapshot, previous, {
  allowWonTransition = true,
  allowScoreTransitions = true,
  allowWarningTransitions = true,
} = {}) {
  const alerts = Array.isArray(previous?.alerts) ? previous.alerts.slice(-MAX_ALERTS) : [];
  const now = new Date().toISOString();

  const push = (type, title, detail) => {
    if (alerts.some(a => a.type === type && a.title === title && (Date.now() - dateValue(a.at)) < 6 * 3600000)) return;
    // Notifications are audit observations: later CRM renames or reassignment
    // must not rewrite who owned the deal or what it was called at alert time.
    alerts.push({
      at: now, type, title, detail,
      titleDeal: snapshot.title, manager: snapshot.manager,
      amount: snapshot.amount, currency: snapshot.currency,
    });
  };

  // First observation of a historical won deal is not a newly won deal.
  // Emit transition alerts only when a previous trusted snapshot exists.
  if (allowWonTransition && snapshot.semantic === "S" && previous && previous.semantic !== "S") {
    push("success", "Сделка успешно закрыта", money(snapshot.amount, snapshot.currency));
  }
  // An already-promising historical deal is visible in the prospects
  // queue, but first observation is not evidence of a fresh score increase.
  // Emit a prospect alert only for an observed crossing of the threshold.
  if (allowScoreTransitions && snapshot.open && previous && snapshot.prospectScore >= 70 && num(previous.prospectScore) < 70) {
    push("prospect", "Перспективная сделка", "Score " + snapshot.prospectScore + " · " + money(snapshot.amount, snapshot.currency));
  }
  // A high initial risk is visible in the attention queue, but it is not
  // evidence that a deal has just *entered* the red zone.
  if (allowScoreTransitions && snapshot.open && previous && snapshot.riskScore >= 60 && num(previous.riskScore) < 60) {
    push("risk", "Сделка вошла в красную зону", "Risk " + snapshot.riskScore + " · " + snapshot.nextStep);
  }
  if (allowWarningTransitions && snapshot.open && !snapshot.hasNext && previous?.hasNext !== false) {
    push("warning", "Нет следующего действия", snapshot.nextStep);
  }
  if (allowWarningTransitions && snapshot.qualificationIssue && !previous?.qualificationIssue) {
    push("warning", "Проверить квалификацию", "Высокий потенциал при неполной квалификации");
  }

  return alerts.slice(-MAX_ALERTS);
}

async function snapshotDeal(deal, source = "event") {
  if (!deal?.ID) return null;
  const id = String(deal.ID);
  const initiallyObserved = SALES.deals.get(id) || null;
  const rawVersion = deal.DATE_MODIFY == null ? "" : String(deal.DATE_MODIFY).trim();
  const incomingVersion = rawVersion && Number.isFinite(Date.parse(rawVersion)) ? rawVersion : "";
  const manager = await managerName(deal.ASSIGNED_BY_ID);

  // Re-read after the asynchronous manager lookup. Another event or sync may
  // have stored a newer snapshot while this request was waiting.
  const latest = SALES.deals.get(id) || null;
  // Older Sheet snapshots can explicitly store sourceUpdatedAt: null.
  // An absent source version is not permission to overwrite the trusted
  // displayed version with an older CRM response; use updatedAt as fallback.
  const latestVersion = latest ? (latest.sourceUpdatedAt || latest.updatedAt) : "";
  // A resolved user name is independent of a deal's DATE_MODIFY version.
  // Permit an identity-checked metadata correction without applying any
  // other fields from an equal-version (possibly stale) deal response.
  const trustedManagerName = latest &&
    String(deal.ASSIGNED_BY_ID || "") === latest.managerId &&
    SALES.managers.get(latest.managerId) === manager;
  const refreshManagerLabel = () => {
    if (!trustedManagerName || manager === latest.manager) return latest;
    const updated = { ...latest, manager };
    SALES.deals.set(id, updated);
    markDirty(id);
    return updated;
  };
  let activityOnlyRefresh = false;
  let activityContactAdvanced = false;
  let activityNextAdvanced = false;
  if (latest) {
    // An unversioned or malformed response must never replace an existing row.
    if (!incomingVersion) return latest;
    if (latestVersion) {
      const order = compareBitrixTimestamp(incomingVersion, latestVersion);
      if (order === 0 && (source === "activity" || source === "sync")) {
        // Bitrix may update contact or schedule without changing the deal's
        // DATE_MODIFY. A missed activity webhook must be recoverable through
        // scheduled read-only sync. Accept strictly newer contact/next times
        // from either source, but never regress values or borrow unversioned
        // title, money or stage fields from an equal-version read.
        // An earlier reschedule needs a newer source version to disambiguate.
        const incomingLast = dateValue(deal.LAST_ACTIVITY_TIME);
        const currentLast = dateValue(latest.lastActivityAt);
        const incomingNext = dateValue(scheduledActivityTime(deal));
        const currentNext = dateValue(latest.nextActivityAt);
        activityContactAdvanced = incomingLast !== null &&
          (currentLast === null || incomingLast > currentLast);
        activityNextAdvanced = incomingNext !== null &&
          (currentNext === null || incomingNext > currentNext);
        if (activityContactAdvanced || activityNextAdvanced) {
          activityOnlyRefresh = true;
        } else {
          return refreshManagerLabel();
        }
      } else if (order === 0) {
        return refreshManagerLabel();
      } else if (order === null || order < 0) {
        // Incomparable or stale CRM deal fields must never overwrite a row.
        return latest;
      }
    }
  }

  const previous = latest || initiallyObserved;
  if (activityOnlyRefresh) {
    // Only the activity fields may change at this source version. Preserve
    // the authoritative deal fields from the existing snapshot, even if the
    // asynchronous activity fetch returns stale title, amount or stage data.
    deal = {
      ID: latest.dealId,
      TITLE: latest.title,
      ASSIGNED_BY_ID: latest.managerId,
      SOURCE_ID: latest.sourceId,
      CATEGORY_ID: latest.categoryId,
      STAGE_ID: latest.stageId,
      STAGE_SEMANTIC_ID: sourceStageSemanticForRefresh(latest),
      OPPORTUNITY: latest.amount,
      CURRENCY_ID: latest.currency,
      DATE_CREATE: latest.createdAt,
      DATE_MODIFY: incomingVersion,
      // Scheduled activities do not necessarily imply customer contact.
      // Preserve the most recent known timestamp if this fetch is stale.
      LAST_ACTIVITY_TIME: activityContactAdvanced ? deal.LAST_ACTIVITY_TIME : latest.lastActivityAt,
      // At an unchanged source version only a strictly later scheduled time
      // can be trusted; blank/older values cannot erase the known Next Step.
      ACTIVITY_TIME: activityNextAdvanced ?
        scheduledActivityTime(deal) : latest.nextActivityAt,
      UF_CRM_AI_CLIENT_TYPE: latest.clientType,
      UF_CRM_AI_QUAL_STATUS: latest.qualificationStatus,
    };
  }
  const scored = scoreDeal(deal, previous);
  const row = {
    kind: "salesDeal",
    dealId: id,
    title: String(deal.TITLE || ("Сделка #" + id)),
    managerId: String(deal.ASSIGNED_BY_ID || ""),
    manager: activityOnlyRefresh && !trustedManagerName ? latest.manager : manager,
    sourceId: String(deal.SOURCE_ID || ""),
    categoryId: String(deal.CATEGORY_ID || "0"),
    stageId: String(deal.STAGE_ID || ""),
    // An absent direct semantic must stay absent across temporal re-scoring:
    // the authoritative pipeline stage dictionary may later be corrected.
    // Same-version activity refreshes may temporarily borrow a previously
    // verified inferred outcome while the Bitrix stage dictionary is down.
    // That fallback is for scoring only; it is not a direct CRM semantic.
    // Keep the original provenance so a later verified dictionary can
    // correct the outcome without waiting for DATE_MODIFY to change.
    sourceStageSemantic: activityOnlyRefresh
      ? (typeof latest.sourceStageSemantic === "string" ? latest.sourceStageSemantic : "")
      : String(deal.STAGE_SEMANTIC_ID || "").trim().toUpperCase(),
    currency: String(deal.CURRENCY_ID || "RUB").trim().toUpperCase(),
    updatedAt: isoOrNull(incomingVersion) || new Date().toISOString(),
    sourceUpdatedAt: incomingVersion || null,
    observedAt: new Date().toISOString(),
    observedFrom: source,
    ...scored,
  };

  const history = Array.isArray(previous?.scoreHistory) ? previous.scoreHistory.slice(-MAX_HISTORY) : [];
  const last = history[history.length - 1];
  if (
    !last ||
    last.stageId !== row.stageId ||
    // Closed-won and closed-lost outcomes may have identical score values
    // and the same stage ID. Losing such a transition corrupts audit history.
    (previous && previous.semantic !== row.semantic) ||
    // Record a pipeline move even when stage ID, amount and scores are equal.
    // Previous snapshots may lack categoryId, so keep them compatible.
    (previous?.categoryId != null && previous.categoryId !== row.categoryId) ||
    last.prospectScore !== row.prospectScore ||
    last.riskScore !== row.riskScore ||
    num(last.amount) !== row.amount ||
    last.currency !== row.currency ||
    // A true CRM manager transfer is itself a significant audit change.
    // Use the identity, not a mutable display-name lookup, as the trigger.
    (previous && previous.managerId !== row.managerId)
  ) {
    history.push({
      // For an activity-only refresh the CRM DATE_MODIFY is unchanged; use
      // observation time for this new history entry, not the old deal version.
      at: chronologicalHistoryAt(
        activityOnlyRefresh ? row.observedAt : row.updatedAt, last?.at, row.observedAt
      ),
      titleDeal: row.title,
      categoryId: row.categoryId,
      stageId: row.stageId,
      semantic: row.semantic,
      stageName: row.stageName,
      manager: row.manager,
      amount: row.amount,
      currency: row.currency,
      prospectScore: row.prospectScore,
      riskScore: row.riskScore,
    });
  }
  row.scoreHistory = history.slice(-MAX_HISTORY);
  // An unchanged deal DATE_MODIFY can accompany a legitimate contact/Next
  // Step refresh. If a separately refreshed stage dictionary also changed
  // the inferred outcome, that classification is an audit correction, not
  // evidence of a newly won deal or a fresh score/qualification transition.
  // Preserve genuine contact-only alerts when stage meaning did not change.
  const correctedStageWithoutDealVersion =
    activityOnlyRefresh && previous && previous.semantic !== row.semantic;
  row.alerts = addAlert(row, previous, {
    allowWonTransition: !correctedStageWithoutDealVersion,
    allowScoreTransitions: !correctedStageWithoutDealVersion,
    allowWarningTransitions: !correctedStageWithoutDealVersion,
  });

  const changed = !previous || [
    "title","managerId","sourceId","categoryId","stageId","semantic","sourceStageSemantic","stageSemanticKnown","amount","currency","sourceUpdatedAt",
    "prospectScore","riskScore","qualificationIssue","qualificationStatus",
    "clientType","lastActivityAt","nextActivityAt","hasNext","nextOverdue",
    "stageEnteredAt","nextStep"
  ].some(key => String(previous?.[key] ?? "") !== String(row?.[key] ?? "")) ||
    JSON.stringify(previous?.alerts || []) !== JSON.stringify(row.alerts || []);

  SALES.deals.set(id, row);
  if (changed) markDirty(id);
  return row;
}

function scheduleFlush() {
  if (SALES.flushTimer) return;
  SALES.flushTimer = setTimeout(() => {
    SALES.flushTimer = null;
    flushDirty().catch(error => {
      SALES.lastError = { at: new Date().toISOString(), source: "sales-store", message: String(error.message || error) };
      if (SALES.dirty.size) scheduleFlush();
    });
  }, 2500);
}

function markDirty(id) {
  const key = String(id);
  SALES.dirty.add(key);
  SALES.dirtyVersions.set(key, (SALES.dirtyVersions.get(key) || 0) + 1);
  scheduleFlush();
}

async function flushDirty() {
  if (!storeConfigured() || !SALES.dirty.size) return;
  if (SALES.flushing) {
    scheduleFlush();
    return;
  }

  SALES.flushing = true;
  try {
    const ids = Array.from(SALES.dirty).slice(0, 50);
    const versions = new Map(ids.map(id => [id, SALES.dirtyVersions.get(id) || 0]));
    const rows = ids
      .map(id => SALES.deals.get(id))
      .filter(Boolean)
      .map(row => ({ key: SALES_PREFIX + row.dealId, payload: row }));

    if (!rows.length) {
      ids.forEach(id => {
        if ((SALES.dirtyVersions.get(id) || 0) === versions.get(id)) {
          SALES.dirty.delete(id);
          SALES.dirtyVersions.delete(id);
        }
      });
      return;
    }

    await storeRequest("upsert", rows);
    // A transient store failure must not leave Dashboard health permanently red
    // once an explicitly acknowledged retry has persisted the pending history.
    // Do not mask errors from other independent Sales operations.
    if (SALES.lastError?.source === "sales-store") SALES.lastError = null;
    ids.forEach(id => {
      // A new event may dirty the same deal while this request is in flight.
      // Clear only the exact version that was successfully persisted.
      if ((SALES.dirtyVersions.get(id) || 0) === versions.get(id)) {
        SALES.dirty.delete(id);
        SALES.dirtyVersions.delete(id);
      }
    });
  } finally {
    SALES.flushing = false;
    if (SALES.dirty.size) scheduleFlush();
  }
}

// Stored snapshots are useful for continuity, but unlike CRM reads they are
// not authoritative. A valid sales:deal:<id> key alone cannot guarantee that
// an older/corrupt Sheet payload is safe to render or use in score totals.
function validPersistedSnapshot(row) {
  // scoreDeal uses whole-point rules only. A fractional Sheet score is
    // not a legitimate Sales observation, even when its forged audit tail
    // agrees with the displayed snapshot.
    const scoreValid = score => typeof score === "number" &&
    Number.isInteger(score) && score >= 0 && score <= 100;
  const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  // Present persisted metadata must match the scalar types emitted by Sales.
  // An object with a non-callable toString can crash the Dashboard's temporal
  // refresh, and arrays can spoof a qualification or history label.
  // Missing optional fields from older snapshots remain supported.
  const optionalText = value => value == null || typeof value === "string";
  const optionalFlag = value => value == null || typeof value === "boolean";
  // A poisoned Sheet row with a far-future CRM source version would make
  // every legitimate crm.deal.get read look stale, freezing the dashboard.
  // Permit normal clock skew while rejecting impossible persisted versions.
  const plausibleVersion = value => {
    const timestamp = dateValue(value);
    return timestamp !== null && timestamp <= Date.now() + 10 * 60 * 1000;
  };
  // A stored future contact or stage date would make Risk Score look safer
  // indefinitely; a future alert time suppresses subsequent warnings.
  // Only planned nextActivityAt may legitimately be in the future.
  // Sales persists these provenance fields as absolute ISO instants.
  // A timezone-free or date-only Sheet value can shift contact/stage age,
  // observed chronology and scheduled Next Step after a host timezone change.
  // Preserve omitted/null legacy fields, but never interpret ambiguous dates.
  const optionalPastDate = value => value == null ||
    (timezoneQualifiedCrmDateTime(value) && plausibleVersion(value));
  const optionalScheduledDate = value => value == null ||
    (timezoneQualifiedCrmDateTime(value) && dateValue(value) !== null);

  if (!record(row) || row.kind !== "salesDeal" ||
      typeof row.title !== "string" || typeof row.manager !== "string" ||
      typeof row.stageId !== "string" || typeof row.semantic !== "string" ||
      // Stage IDs are scoped by the canonical Bitrix pipeline number. A
      // persisted "07", " 7 " or unknown category can miss pipeline 7's
      // verified stage dictionary, spuriously changing Risk/Next Step.
      // Missing category remains valid for older stored snapshots.
      (row.categoryId != null &&
        (typeof row.categoryId !== "string" ||
         !/^(0|[1-9][0-9]*)$/.test(row.categoryId) ||
         !Number.isSafeInteger(Number(row.categoryId)))) ||
      // Only P/S/F are recognized Bitrix outcomes. An empty semantic is
      // legitimate until stage metadata is verified; arbitrary persisted
      // values must not be treated as a valid open/closed classification.
      !["", "P", "S", "F"].includes(row.semantic) ||
      (row.sourceStageSemantic != null &&
        !["", "P", "S", "F"].includes(row.sourceStageSemantic)) ||
      // When Bitrix supplies a direct P/S/F outcome, scoreDeal uses it as
      // authoritative even if the stage dictionary disagrees. A saved row
      // claiming a different semantic is corrupt: hydration would expose
      // one classification and a timed refresh would silently reverse it.
      (typeof row.sourceStageSemantic === "string" &&
        row.sourceStageSemantic !== "" &&
        row.semantic !== row.sourceStageSemantic) ||
      // The known flag is derived, not an independent source of truth.
      // Preserve older snapshots that do not carry this optional field.
      (row.stageSemanticKnown != null &&
        row.stageSemanticKnown !== (row.semantic !== "")) ||
      // Stored manager IDs must obey the same canonical identity rule as
      // live ASSIGNED_BY_ID. A Sheet row with "07" or " 7 " must not
      // masquerade as a different Bitrix manager after a restart.
      // Empty/zero still represents an unassigned manager; legacy rows may
      // omit the manager ID entirely.
      (row.managerId != null && row.managerId !== "" && row.managerId !== "0" &&
        (typeof row.managerId !== "string" || !validDealId(row.managerId))) ||
      typeof row.currency !== "string" ||
      // Live CRM reads require an explicit currency for nonzero amounts.
      // Apply that same rule to untrusted Sheet snapshots: otherwise timed
      // rescoring defaults an empty CURRENCY_ID to RUB, incorrectly adding
      // RUB-based Prospect/Risk points to a currencyless persisted deal.
      (row.amount !== 0 && !row.currency.trim()) ||
      typeof row.nextStep !== "string" ||
      typeof row.open !== "boolean" || row.open !== isOpenSemantic(row.semantic) ||
      typeof row.hasNext !== "boolean" || typeof row.qualificationIssue !== "boolean" ||
      typeof row.amount !== "number" || !Number.isFinite(row.amount) ||
      Math.abs(row.amount) > Number.MAX_SAFE_INTEGER ||
      !scoreValid(row.prospectScore) || !scoreValid(row.riskScore) ||
      // A CRM version must include an explicit Z/UTC offset. Date-only and
      // offset-free values parse in the host's timezone, so a forged Sheet
      // snapshot could suppress a real newer Bitrix update after restart.
      // Sales writes normalized UTC updatedAt and a timezone-qualified
      // Bitrix DATE_MODIFY in sourceUpdatedAt; legacy null sources remain.
      !timezoneQualifiedCrmDateTime(row.updatedAt) || !plausibleVersion(row.updatedAt) ||
      (row.sourceUpdatedAt != null &&
        (!timezoneQualifiedCrmDateTime(row.sourceUpdatedAt) ||
         !plausibleVersion(row.sourceUpdatedAt))) ||
      // Sales never records an authoritative CRM source version later than
      // its displayed update time. Old snapshots may record a later local
      // observation, so only reject the impossible reverse ordering.
      // Compare millisecond instants: Bitrix can supply sub-ms precision,
      // while updatedAt is normalized to a JavaScript ISO timestamp.
      (row.sourceUpdatedAt != null &&
        dateValue(row.sourceUpdatedAt) > dateValue(row.updatedAt)) ||
      !optionalPastDate(row.createdAt) ||
      // The creation instant must not postdate any stored CRM version.
      // Otherwise hydration accepts a deal that could not have existed at
      // its claimed update, then timed refresh derives contradictory risk
      // and persisted history. Older rows may omit optional source dates.
      (row.createdAt != null &&
        ["updatedAt", "sourceUpdatedAt", "modifiedAt"].some(field =>
          row[field] != null && dateValue(row.createdAt) > dateValue(row[field]))) ||
      !optionalPastDate(row.modifiedAt) ||
      // DATE_MODIFY cannot outrun the authoritative CRM source version.
      // updatedAt can be a later local observation, not a new CRM change.
      // Legacy snapshots without a source version still use updatedAt.
      (row.modifiedAt != null &&
        dateValue(row.modifiedAt) > dateValue(row.sourceUpdatedAt || row.updatedAt)) ||
      !optionalPastDate(row.lastActivityAt) ||
      !optionalPastDate(row.stageEnteredAt) ||
      // A stage transition must be observable in the deal's DATE_MODIFY.
      // A later stored stage date can erase weeks of stage-age Risk Score
      // while the recorded source version remains unchanged. The local
      // updatedAt observation alone is not proof of a CRM stage transition.
      (row.stageEnteredAt != null &&
        dateValue(row.stageEnteredAt) > dateValue(row.sourceUpdatedAt || row.updatedAt)) ||
      // The recorded stage cannot have started before the deal existed.
      // A poisoned older stage date otherwise adds phantom stage-age Risk
      // points on every timed dashboard refresh, even without CRM changes.
      // Preserve older Sheet rows that do not know the creation date.
      (row.createdAt != null && row.stageEnteredAt != null &&
        dateValue(row.stageEnteredAt) < dateValue(row.createdAt)) ||
      !optionalPastDate(row.observedAt) ||
      !optionalScheduledDate(row.nextActivityAt) ||
      // Bitrix uses 9999-12-31 (sometimes 9999-12-30 UTC after timezone
      // normalization) as its "no deadline" sentinel. The live CRM parser
      // excludes it; do not let an untrusted Sheet row resurrect that value
      // as a planned activity and inflate the score after a restart.
      (row.nextActivityAt != null && dateValue(row.nextActivityAt) >= NO_DEADLINE_FROM) ||
      // scoreDeal derives scheduled/overdue flags from the same activity
      // instant. A missing (null or omitted) date cannot truthfully justify
      // either flag, nor can both flags ever be true. Legacy rows without
      // date and without either flag remain loadable.
      (row.nextActivityAt == null && (row.hasNext || row.nextOverdue === true)) ||
      (row.hasNext && row.nextOverdue === true) ||
      // A deadline still in the future cannot have been overdue or missing
      // at any earlier saved observation. A past deadline with old scheduled
      // flags remains valid: time passing is not evidence of Sheet corruption.
      (row.nextActivityAt != null && dateValue(row.nextActivityAt) > Date.now() &&
        (!row.hasNext || row.nextOverdue === true)) ||
      !Array.isArray(row.scoreHistory) || row.scoreHistory.length > MAX_HISTORY ||
      !Array.isArray(row.alerts) || row.alerts.length > MAX_ALERTS ||
      ["managerId", "sourceId", "categoryId", "stageName",
        "sourceStageSemantic", "qualificationStatus", "clientType", "observedFrom"].some(
        field => !optionalText(row[field])) ||
      ["stageSemanticKnown", "nextOverdue"].some(
        field => !optionalFlag(row[field]))) {
    return false;
  }

  // A malformed nested array can otherwise break Dashboard.status(), while
  // unlimited history/alerts can expand the read-only JSON response without
  // bounds. These shapes are exactly what Sales writes on a successful save.
  // The append path assumes the final history entry is the newest one.
  // A store row with otherwise plausible, but out-of-order, timestamps can
  // break the score timeline after the next webhook or temporal refresh.
  // Preserve equal-millisecond observations; reject reversed sequences.
  if (!row.scoreHistory.every((entry, index) =>
    record(entry) && typeof entry.at === "string" &&
    // Sales emits absolute observation instants. An unzoned Sheet datetime
    // would be parsed in the host timezone and misorder the audit trail.
    timezoneQualifiedCrmDateTime(entry.at) && plausibleVersion(entry.at) &&
    // Score observations cannot predate the deal that was scored. A poisoned
    // Sheet audit row otherwise creates a fictitious pre-creation history.
    (row.createdAt == null || dateValue(entry.at) >= dateValue(row.createdAt)) &&
    typeof entry.amount === "number" && Number.isFinite(entry.amount) &&
    Math.abs(entry.amount) <= Number.MAX_SAFE_INTEGER &&
    scoreValid(entry.prospectScore) && scoreValid(entry.riskScore) &&
    ["categoryId", "stageId", "stageName", "currency", "manager", "titleDeal"].every(field => optionalText(entry[field])) &&
    // Old snapshots can omit history semantics; unresolved live Bitrix
    // stages are written with an empty semantic until a verified dictionary
    // is available. Accept that canonical unknown value across restarts.
    (entry.semantic == null || ["", "P", "S", "F"].includes(entry.semantic)) &&
    (index === 0 || dateValue(entry.at) >= dateValue(row.scoreHistory[index - 1].at)))) {
    return false;
  }
  // Validate alerts independently: legacy deals may have an empty score history.
  if (!row.alerts.every((entry, index) =>
      record(entry) && typeof entry.at === "string" &&
    // Sales emits absolute observation instants. An unzoned Sheet datetime
    // would be parsed in the host timezone and misorder the audit trail.
    timezoneQualifiedCrmDateTime(entry.at) && plausibleVersion(entry.at) &&
      // Sales alerts are generated only after the underlying CRM deal exists.
      // Old snapshots without a creation timestamp remain compatible.
      (row.createdAt == null || dateValue(entry.at) >= dateValue(row.createdAt)) &&
      // addAlert appends observations and retains the newest MAX_ALERTS.
      // Unordered persisted alerts can instead make the tail discard a
      // recent warning while displaying an older one as its replacement.
      // Multiple alerts from one observation may share a timestamp.
      (index === 0 || dateValue(entry.at) >= dateValue(row.alerts[index - 1].at)) &&
      // addAlert emits only these four categories. Unknown stored types
      // would otherwise render as generic warnings and pollute the audit.
      ["success", "prospect", "risk", "warning"].includes(entry.type) &&
      typeof entry.title === "string" && typeof entry.detail === "string" &&
      // Legacy alerts omit attribution. New stored attribution must be scalar
      // to prevent poisoned Sheet values leaking into Dashboard rendering.
      optionalText(entry.titleDeal) && optionalText(entry.manager) &&
      // Legacy alerts have neither monetary field. New observations record
      // both so future CRM amount/currency edits cannot rewrite the audit.
      (entry.amount == null || (typeof entry.amount === "number" &&
        Number.isFinite(entry.amount) && Math.abs(entry.amount) <= Number.MAX_SAFE_INTEGER)) &&
      (entry.currency == null || (typeof entry.currency === "string" && Boolean(entry.currency.trim()))) &&
      (entry.amount == null) === (entry.currency == null))) {
    return false;
  }
  // Each accepted snapshot is emitted with an audit entry whenever its
  // scored state, amount, currency, pipeline, stage or outcome changes.
  // A Sheet row whose final history entry disagrees with its current state
  // would otherwise display a forged or stale score/outcome progression.
  // Older history may omit optional semantic/category/currency metadata.
  const latest = row.scoreHistory[row.scoreHistory.length - 1];
  return !latest || (
    latest.amount === row.amount &&
    latest.prospectScore === row.prospectScore &&
    latest.riskScore === row.riskScore &&
    (latest.stageId == null || latest.stageId === row.stageId) &&
    (latest.categoryId == null || row.categoryId == null ||
      latest.categoryId === row.categoryId) &&
    (latest.semantic == null || latest.semantic === row.semantic) &&
    (latest.currency == null || latest.currency === row.currency)
  );
}

async function loadPersisted() {
  if (!storeConfigured()) return;
  try {
    const payload = await storeRequest("load");
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    let count = 0;
    let rejected = 0;
    for (const entry of rows) {
      // Store data is untrusted JSON: String() can coerce an array into a
      // plausible sales:deal:<id> key, or throw for an object with a poisoned
      // toString, aborting hydration before valid snapshots are restored.
      // Only the exact string key format may identify a saved Sales deal.
      const key = typeof entry?.key === "string" ? entry.key : "";
      const row = entry?.payload;
      if (!key.startsWith(SALES_PREFIX)) continue;

      // Validate the raw persisted identity before String() can coerce
      // an array such as ["42"] into an apparently valid deal key.
      const id = validDealId(row?.dealId) ? String(row.dealId) : "";
      // Storage records are not authoritative CRM events. Validate their
      // identity AND their score, alert and history shape before hydration.
      // Keep any previously accepted snapshot when a duplicate is corrupt.
      if (!validDealId(id) || key !== SALES_PREFIX + id || !validPersistedSnapshot(row)) {
        rejected += 1;
        continue;
      }
      const current = SALES.deals.get(id);
      if (current) {
        // A webhook can finish while the startup store read is in flight.
        // Never let an older or incomparable persisted row replace that
        // in-memory snapshot; only accept a strictly newer, comparable row.
        const currentVersion = current.sourceUpdatedAt || current.updatedAt;
        const storedVersion = row.sourceUpdatedAt || row.updatedAt;
        if (!currentVersion || !storedVersion) continue;
        const order = compareBitrixTimestamp(storedVersion, currentVersion);
        if (order === null || order <= 0) continue;
      }

      // An older Sales build could persist the Bitrix unassigned marker as
      // manager "#0". Dormant deals outside the recent CRM sync window would
      // otherwise keep showing a fictitious manager after every restart.
      // Repair only the presentation label, without fabricating CRM updates,
      // changing the saved source version or calling user.get for ID 0.
      const legacyUnassigned = row.managerId === "0" ||
        ((row.managerId == null || row.managerId === "") &&
          (row.manager === "#0" || row.manager === "—"));
      // The same obsolete #0 label was also persisted inside historical
      // score observations and alerts. Correct only that known unassigned
      // identity, never a real historical manager after reassignment.
      const historyHasZero = legacyUnassigned &&
        row.scoreHistory.some(entry => entry.manager === "#0");
      const alertsHaveZero = legacyUnassigned &&
        row.alerts.some(entry => entry.manager === "#0");
      const hydrated = legacyUnassigned &&
        (row.manager !== "—" || historyHasZero || alertsHaveZero)
        ? {
            ...row, manager: "—",
            scoreHistory: historyHasZero
              ? row.scoreHistory.map(entry => entry.manager === "#0" ? { ...entry, manager: "—" } : entry)
              : row.scoreHistory,
            alerts: alertsHaveZero
              ? row.alerts.map(entry => entry.manager === "#0" ? { ...entry, manager: "—" } : entry)
              : row.alerts,
          }
        : row;
      SALES.deals.set(id, hydrated);
      count += 1;
    }
    console.log(JSON.stringify({ source: "sales-mvp", action: "store-load-ok", count, rejected }));
    if (rejected) {
      // Avoid logging potentially sensitive/corrupt row contents.
      console.warn(JSON.stringify({ source: "sales-mvp", action: "store-load-invalid-rows", rejected }));
    }
  } catch (error) {
    SALES.lastError = { at: new Date().toISOString(), source: "sales-store-load", message: String(error.message || error) };
    console.warn(JSON.stringify({ source: "sales-mvp", action: "store-load-failed", error: String(error.message || error) }));
  }
}

async function processDealId(dealId, source = "event") {
  if (!validDealId(dealId)) throw new Error("Invalid Bitrix deal ID");
  const deal = await bitrixCall("crm.deal.get", { ID: Number(dealId) });
  const verified = validateDealRow(deal, String(dealId));
  await ensureStageCategory(verified.CATEGORY_ID);
  return snapshotDeal(verified, source);
}

async function processActivityId(activityId) {
  if (!validDealId(activityId)) throw new Error("Invalid Bitrix activity ID");
  const activity = validateActivityRow(
    await bitrixCall("crm.activity.get", { id: Number(activityId) }),
    activityId
  );
  if (String(activity.OWNER_TYPE_ID) !== "2") return null;
  return processDealId(activity.OWNER_ID, "activity");
}

async function handleEvent(evt, { propagateError = false } = {}) {
  SALES.lastEventAt = new Date().toISOString();
  const upper = String(evt?.event || "").toUpperCase();
  try {
    let result = null;
    if (upper.includes("CRMACTIVITY")) {
      result = await processActivityId(evt.activityId);
    } else if (upper.includes("CRMDEAL") && evt.dealId) {
      result = await processDealId(evt.dealId, "deal-event");
    }
    // Clear an earlier event-processing error only after a real successful
    // read. Ignored events and errors from sync/store must not be hidden.
    if (result) {
      SALES.lastProcessedEventAt = new Date().toISOString();
      if (SALES.lastError?.source === "sales-event") SALES.lastError = null;
    } else {
      // An activity belonging to a lead/company, not a deal, is deliberately
      // ignored. This must not be counted as a completed deal snapshot.
      SALES.lastIgnoredEventAt = new Date().toISOString();
    }
    return result;
  } catch (error) {
    SALES.lastFailedEventAt = new Date().toISOString();
    SALES.lastError = { at: SALES.lastFailedEventAt, source: "sales-event", message: String(error.message || error) };
    // Gateway processing must reject on a failed CRM read so its receipt
    // audit cannot label the event as a harmless no-deal snapshot. Direct
    // callers retain the original null-return/error-log behavior.
    if (propagateError) throw error;
    console.warn(JSON.stringify({
      source: "sales-mvp",
      action: "event-processing-failed",
      event: evt?.event || null,
      dealId: evt?.dealId || null,
      activityId: evt?.activityId || null,
      error: String(error.message || error),
    }));
    return null;
  }
}

function restartSyncScan() {
  SALES.syncPartial = false;
  SALES.syncCursor = 0;
  SALES.syncSince = null;
  SALES.syncSeenIds = new Set();
  SALES.syncExpectedTotal = null;
  SALES.syncLastSortKey = null;
}

async function syncRecentDeals(limitPages = 4) {
  if (SALES.syncing) return;
  SALES.syncing = true;
  try {
    // Failed dictionaries need retry; successful dictionaries must also
    // expire. Bitrix admins can rename a stage or change its semantics
    // without any deal webhook or DATE_MODIFY change. Refreshing every loaded
    // pipeline on a bounded cadence avoids permanent stale scoring while
    // retaining the last known-good cache if a read is malformed.
    const categoriesToRefresh = new Set(SALES.stageCategoriesPending);
    for (const category of SALES.stageCategoriesLoaded) {
      const loadedAt = SALES.stageLoadedAt.get(category);
      if (!Number.isFinite(loadedAt) || Date.now() - loadedAt >= STAGE_CACHE_TTL_MS) {
        categoriesToRefresh.add(category);
      }
    }
    // Hydration may restore dormant deals that are older than the 45-day
    // crm.deal.list window. A non-default pipeline then has no recent deal
    // to trigger ensureStageCategory(), so its stored inferred classification
    // and Next Step could stay stale forever. Refresh every missing dictionary
    // referenced by trusted snapshots, using read-only crm.status.list.
    for (const snapshot of SALES.deals.values()) {
      const category = stageCategoryId(snapshot.categoryId);
      if (!SALES.stageCategoriesLoaded.has(category)) categoriesToRefresh.add(category);
    }
    for (const category of categoriesToRefresh) await loadStages(category);
    // Continue bounded scans instead of restarting at page zero forever.
    // Keep the same cutoff throughout the scan, including across timer ticks.
    const resume = SALES.syncPartial && SALES.syncCursor > 0 && SALES.syncSince;
    const seenIds = resume ? SALES.syncSeenIds : new Set();
    let expectedTotal = resume ? SALES.syncExpectedTotal : null;
    let start = resume ? SALES.syncCursor : 0;
    let previousSortKey = resume ? SALES.syncLastSortKey : null;
    let pages = 0;
    const since = resume ? SALES.syncSince : new Date(Date.now() - DEAL_SYNC_LOOKBACK_DAYS * 86400000).toISOString();

    do {
      const payload = await bitrixRaw("crm.deal.list", {
        // DATE_MODIFY ties are common during bulk CRM updates. Offset pages
        // need a unique secondary key or equal-timestamp deals can swap
        // order across requests, causing an overlap and missing records.
        order: { DATE_MODIFY: "DESC", ID: "DESC" },
        filter: { ">DATE_MODIFY": since },
        select: [
          "ID","TITLE","ASSIGNED_BY_ID","SOURCE_ID","CATEGORY_ID","STAGE_ID","STAGE_SEMANTIC_ID",
          "OPPORTUNITY","CURRENCY_ID","DATE_CREATE","DATE_MODIFY","MOVED_TIME","BEGINDATE","CLOSEDATE",
          "LAST_ACTIVITY_TIME","ACTIVITY_TIME","NEXT_ACTIVITY_TIME",
          "UF_CRM_AI_QUAL_STATUS","UF_CRM_AI_CLIENT_TYPE"
        ],
        start,
      });
      // A malformed list response must not make the Dashboard claim that
      // a successful Bitrix sync occurred. Likewise, never silently accept
      // an invalid or non-advancing pagination cursor as the final page.
      const rows = payload?.result;
      if (!Array.isArray(rows)) {
        throw new Error("Invalid Bitrix deal list response");
      }
      // Bitrix crm.deal.list returns at most 50 rows per offset page.
      // Reject an oversized/malformed page before loading metadata or
      // applying any deal: otherwise it could certify an invalid scan as
      // healthy and consume unbounded work on unexpected REST data.
      if (rows.length > 50) {
        throw new Error("Oversized Bitrix deal list page");
      }
      // Check the entire page before mutating any trusted Sales snapshot.
      // Otherwise an invalid later row or cursor can leave earlier rows
      // applied even though the scan correctly reports a sync failure.
      const validatedRows = rows.map(deal => validateDealRow(deal));
      for (const category of new Set(validatedRows.map(deal => stageCategoryId(deal.CATEGORY_ID)))) {
        await ensureStageCategory(category);
      }
      // Duplicate IDs in one CRM page make its contents ambiguous. Applying
      // the first row would silently ignore a later conflicting version, yet
      // a completed scan would be reported as authoritative. Reject the whole
      // page before changing any cached snapshot.
      const pageIds = new Set();
      for (const deal of validatedRows) {
        const id = String(deal.ID);
        if (pageIds.has(id)) throw new Error("Duplicate Bitrix deal ID in sync page");
        if (seenIds.has(id)) {
          // A changing offset-based result can repeat an earlier page's deal
          // and skip a different deal. Never certify that scan as complete.
          // Restart from page zero on the next tick to avoid a stuck cursor.
          restartSyncScan();
          throw new Error("Duplicate Bitrix deal ID across sync pages");
        }
        pageIds.add(id);
      }
      // Bitrix was asked for DATE_MODIFY DESC, ID DESC. A malformed or
      // drifting page may contain unique IDs and a consistent total while
      // still violating that order. Do not certify such a scan as complete:
      // the offset boundary may have skipped another deal. Check before
      // applying any of this page's snapshots to the read-only Dashboard.
      for (let i = 1; i < validatedRows.length; i += 1) {
        const earlier = validatedRows[i - 1];
        const later = validatedRows[i];
        const order = compareBitrixTimestamp(earlier.DATE_MODIFY, later.DATE_MODIFY);
        if (order === null || order < 0 ||
            (order === 0 && Number(earlier.ID) <= Number(later.ID))) {
          throw new Error("Out-of-order Bitrix deal list page");
        }
      }
      // Every page can be internally sorted while the combined offset
      // scan is not. A newer (or equal-date higher-ID) first row on a later
      // page means records may have shifted or been skipped at the boundary.
      // Preserve this boundary across the four-page timer limit as well.
      if (validatedRows.length && previousSortKey) {
        const first = validatedRows[0];
        const order = compareBitrixTimestamp(previousSortKey.modifiedAt, first.DATE_MODIFY);
        if (order === null || order < 0 ||
            (order === 0 && Number(previousSortKey.id) <= Number(first.ID))) {
          restartSyncScan();
          throw new Error("Out-of-order Bitrix deal list across page boundary");
        }
      }
      let nextStart = -1;
      if (payload.next !== undefined && payload.next !== null) {
        // A JSON array such as [1] must not be coerced to a valid cursor.
        const cursorValue = payload.next;
        const cursorText = (typeof cursorValue === "string" || typeof cursorValue === "number")
          ? String(cursorValue).trim() : "";
        const next = Number(cursorText);
        // Bitrix crm.deal.list uses pages of at most 50 records. A cursor
        // that jumps further can silently skip deals and falsely mark the
        // dashboard sync complete once the jumped-to page is exhausted.
        // Require exactly the number of returned rows to be consumed.
        // A jumping cursor skips deals; an overlapping cursor followed by
        // an empty page can falsely certify an incomplete scan.
        if (!/^[1-9]\d*$/.test(cursorText) || !Number.isSafeInteger(next) ||
            next <= start || next - start > 50 || next - start !== validatedRows.length) {
          throw new Error("Invalid Bitrix pagination cursor");
        }
        nextStart = next;
      }
      // Bitrix crm.deal.list may also return a total match count. A broken
      // intermediary can drop the next cursor while keeping total > the
      // number of rows covered by this page. Treating that as the last page
      // falsely certifies a truncated Dashboard scan as fully synchronized.
      // Check before applying any page rows, and do not coerce array/object
      // totals into believable numeric values.
      let observedTotal = null;
      if (payload.total !== undefined && payload.total !== null) {
        const totalValue = payload.total;
        const totalText = (typeof totalValue === "string" || typeof totalValue === "number")
          ? String(totalValue).trim() : "";
        const total = Number(totalText);
        if (!/^(0|[1-9]\d*)$/.test(totalText) || !Number.isSafeInteger(total) ||
            // The reported total cannot be smaller than the number of records
            // already covered by this page, even when next is absent.
            // Otherwise a contradictory total:0 + one deal is accepted as
            // complete and applied to a supposedly healthy Dashboard.
            total < start + validatedRows.length ||
            (nextStart < 0 && total > start + validatedRows.length) ||
            (nextStart >= 0 && nextStart > total)) {
          throw new Error("Inconsistent Bitrix deal list total or pagination");
        }
        observedTotal = total;
      }
      // The cursor and total of one page may be internally consistent even
      // when the underlying offset-based result set shrank between requests.
      // That can skip a previously unseen deal, then report a false complete
      // scan. Keep the first verified total through bounded/resumed scans.
      if (observedTotal !== null) {
        if (expectedTotal !== null && observedTotal !== expectedTotal) {
          restartSyncScan();
          throw new Error("Bitrix deal list total changed during pagination");
        }
        expectedTotal = observedTotal;
      }
      // A later page may omit total. It cannot override an earlier promise
      // that more records exist, even if its own next cursor is missing.
      if (expectedTotal !== null &&
          ((nextStart < 0 && start + validatedRows.length !== expectedTotal) ||
           (nextStart >= 0 && nextStart > expectedTotal))) {
        restartSyncScan();
        throw new Error("Bitrix deal list pagination omitted previously announced deals");
      }

      // A full 50-record page with neither next nor total is ambiguous:
      // an intermediary may have dropped both pagination markers while
      // more records remain. Probe the next offset before declaring the scan
      // complete; an empty follow-up page also confirms a genuine 50-row end.
      // A verified total equal to the consumed count needs no extra read.
      if (nextStart < 0 && validatedRows.length === 50 &&
          observedTotal === null && expectedTotal === null) {
        nextStart = start + validatedRows.length;
      }

      for (const deal of validatedRows) {
        await snapshotDeal(deal, "sync");
      }
      // Commit the page's identities only after it has been fully applied.
      // Retain these IDs if a bounded scan resumes at a later timer tick.
      for (const id of pageIds) seenIds.add(id);
      if (validatedRows.length) {
        const last = validatedRows[validatedRows.length - 1];
        previousSortKey = { modifiedAt: last.DATE_MODIFY, id: String(last.ID) };
      }
      SALES.syncSeenIds = seenIds;
      SALES.syncExpectedTotal = expectedTotal;
      SALES.syncLastSortKey = previousSortKey;
      pages += 1;
      start = nextStart;

      if (start >= 0 && pages < limitPages) {
        await new Promise(resolve => setTimeout(resolve, 1400));
      }
    } while (start >= 0 && pages < limitPages);

    if (start >= 0) {
      // More pages remain; never report a complete/healthy sync yet.
      SALES.syncPartial = true;
      SALES.syncCursor = start;
      SALES.syncSince = since;
      console.log(JSON.stringify({
        source: "sales-mvp",
        action: "sync-partial",
        pages,
        nextStart: start,
        trackedDeals: SALES.deals.size,
      }));
      return;
    }
    restartSyncScan();
    SALES.lastSyncAt = new Date().toISOString();
    if (SALES.lastError?.source === "sales-sync") SALES.lastError = null;
    console.log(JSON.stringify({
      source: "sales-mvp",
      action: "sync-ok",
      pages,
      trackedDeals: SALES.deals.size,
      since,
    }));
  } catch (error) {
    // An interrupted multi-tick scan cannot safely reuse its old offset:
    // the underlying CRM result set may have shifted before the next tick.
    // Keep verified deal snapshots, but abandon the partial cursor/cutoff
    // after any failed resumed page (including invalid cursors or timeouts).
    if (SALES.syncPartial) restartSyncScan();
    SALES.lastError = {
      at: new Date().toISOString(),
      source: "sales-sync",
      message: String(error.message || error),
    };
    console.warn(JSON.stringify({
      source: "sales-mvp",
      action: "sync-failed",
      error: String(error.message || error),
    }));
  } finally {
    SALES.syncing = false;
  }
}

function sortedDeals() {
  return Array.from(SALES.deals.values()).sort((a, b) =>
    (dateValue(b.updatedAt) || 0) - (dateValue(a.updatedAt) || 0)
  );
}

// Read-only CRM records can stay unchanged for days. Their next activity can
// become overdue and their last contact can become stale without any webhook
// or DATE_MODIFY update. Re-evaluate time-dependent scores when serving the
// dashboard, preserving the last CRM source version and observations.
function refreshTimedScores() {
  for (const [id, previous] of SALES.deals) {
    if (!previous || !previous.dealId) continue;
    const deal = {
      // Re-scoring must use the original deal pipeline. Without CATEGORY_ID,
      // a non-default pipeline can silently inherit a same-named default
      // stage, producing a phantom won deal on every Dashboard refresh.
      CATEGORY_ID: previous.categoryId,
      STAGE_SEMANTIC_ID: sourceStageSemanticForRefresh(previous),
      STAGE_ID: previous.stageId,
      OPPORTUNITY: previous.amount,
      CURRENCY_ID: previous.currency,
      DATE_CREATE: previous.createdAt,
      DATE_MODIFY: previous.sourceUpdatedAt || previous.modifiedAt || previous.updatedAt,
      LAST_ACTIVITY_TIME: previous.lastActivityAt,
      ACTIVITY_TIME: previous.nextActivityAt,
      UF_CRM_AI_QUAL_STATUS: previous.qualificationStatus,
      UF_CRM_AI_CLIENT_TYPE: previous.clientType,
    };
    const scored = scoreDeal(deal, previous);
    // Verified stage labels can change after a metadata retry even when the
    // deal semantic, scores and CRM DATE_MODIFY remain unchanged.
    // JSON dashboard age diagnostics must advance even between scoring
    // thresholds. Age-only changes still must not append score history:
    // history below records score changes, not passage of time alone.
    const keys = [
      "prospectScore", "riskScore", "hasNext", "nextOverdue",
      "qualificationIssue", "nextStep", "stageName",
      "semantic", "open", "stageSemanticKnown",
      "stageAgeDays", "dealAgeDays", "lastActivityAgeDays",
    ];
    if (keys.every(key => scored[key] === previous[key])) continue;

    const row = { ...previous, ...scored };
    // Age diagnostics change with time even when the trusted deal state does
    // not. A dashboard GET must not write the same snapshot to Google Sheets
    // merely because a displayed age rounded to another tenth of a day.
    // Persist actual stage, score, qualification and Next Step transitions.
    const ageDiagnostics = new Set(["stageAgeDays", "dealAgeDays", "lastActivityAgeDays"]);
    const shouldPersist = keys.some(key =>
      !ageDiagnostics.has(key) && scored[key] !== previous[key]);
    const history = Array.isArray(previous.scoreHistory) ? previous.scoreHistory.slice(-MAX_HISTORY) : [];
    const last = history[history.length - 1];
    if (!last || previous.semantic !== row.semantic ||
        last.prospectScore !== row.prospectScore || last.riskScore !== row.riskScore) {
      history.push({
        at: chronologicalHistoryAt(new Date().toISOString(), last?.at),
        titleDeal: row.title,
        categoryId: row.categoryId,
        stageId: row.stageId,
        semantic: row.semantic,
        stageName: row.stageName,
        manager: row.manager,
        amount: row.amount,
        currency: row.currency,
        prospectScore: row.prospectScore,
        riskScore: row.riskScore,
      });
    }
    row.scoreHistory = history.slice(-MAX_HISTORY);
    // Timed scoring can reclassify a deal after a stage-dictionary edit.
    // That is an audit correction, not an observed CRM deal transition:
    // reopening a historical deal can cross the prospect/red-zone scoring
    // thresholds without any new customer activity. Preserve real temporal
    // threshold alerts when the stage meaning itself has not changed.
    row.alerts = addAlert(row, previous, {
      allowWonTransition: false,
      allowScoreTransitions: previous.semantic === row.semantic,
      // Stage-dictionary-only reopening can expose an existing qualification
      // gap. That is a corrected audit classification, not a new CRM warning.
      allowWarningTransitions: previous.semantic === row.semantic,
    });
    SALES.deals.set(id, row);
    if (shouldPersist) markDirty(id);
  }
}

function status() {
  refreshTimedScores();
  const all = sortedDeals();
  const open = all.filter(x => x.open);
  const prospects = open.filter(x => x.prospectScore >= 60);
  const high = open.filter(x => x.prospectScore >= 75);
  const risk = open.filter(x => x.riskScore >= 60);
  const noNext = open.filter(x => !x.hasNext);
  const qualIssues = open.filter(x => x.qualificationIssue);
  const won = all.filter(x => x.semantic === "S");
  // The original Dashboard exposed per-deal history only for deals that
  // happened to be in a prospect, attention or won queue. A closed-lost deal
  // therefore disappeared from the visible audit trail. Keep a bounded,
  // read-only cross-deal timeline that includes every outcome and first read.
  // Bounded insertion avoids flattening every stored score record per refresh.
  const recentHistory = [];
  const historyLimit = 25;
  for (const deal of all) {
    for (const entry of (Array.isArray(deal.scoreHistory) ? deal.scoreHistory : [])) {
      const at = dateValue(entry.at) || 0;
      const tail = recentHistory[recentHistory.length - 1];
      if (recentHistory.length >= historyLimit && at <= (dateValue(tail.at) || 0)) continue;
      recentHistory.push({
        ...entry, dealId: deal.dealId,
        // Legacy saved histories did not record a per-observation title.
        // New entries retain the real name at observation time across renames.
        titleDeal: typeof entry.titleDeal === "string" ? entry.titleDeal : deal.title,
        // Historical observations must not be retroactively attributed to
        // the current manager after a CRM ownership transfer. Older saved
        // observations lack this field and retain the legacy fallback.
        manager: typeof entry.manager === "string" ? entry.manager : deal.manager,
      });
      recentHistory.sort((a, b) => (dateValue(b.at) || 0) - (dateValue(a.at) || 0));
      if (recentHistory.length > historyLimit) recentHistory.pop();
    }
  }
  const alerts = all
    .flatMap(x => (x.alerts || []).map(a => ({
      ...a, dealId: x.dealId,
      // Preserve the name and owner recorded when the alert was generated.
      // Old persisted alerts did not have either field, so keep the legacy
      // current-deal fallback rather than losing those notifications.
      titleDeal: typeof a.titleDeal === "string" ? a.titleDeal : x.title,
      manager: typeof a.manager === "string" ? a.manager : x.manager,
      // Legacy alerts have no monetary attribution; fall back to the
      // current deal only for those old records, never for new alerts.
      amount: typeof a.amount === "number" && Number.isFinite(a.amount) ? a.amount : x.amount,
      currency: typeof a.currency === "string" ? a.currency : x.currency,
    })))
    .sort((a, b) => (dateValue(b.at) || 0) - (dateValue(a.at) || 0))
    .slice(0, 30);

  // Dashboard totals are deliberately RUB-only. Other currencies are shown
  // per deal and counted separately; no implicit FX conversion is performed.
  const sumRub = rows => {
    // Number addition can silently lose fractional RUB even below
    // MAX_SAFE_INTEGER (5e15 + 0.5), or publish artifacts (0.1 + 0.2).
    // Sum canonical decimal components exactly. Publish a JSON Number only
    // if it preserves the resulting decimal value without any rounding.
    let coefficient = 0n;
    let exponent = 0;
    for (const row of rows) {
      if (String(row.currency || "").trim().toUpperCase() !== "RUB") continue;
      const amount = row.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount) ||
          Math.abs(amount) > Number.MAX_SAFE_INTEGER) return null;
      const match = /^(-?)([0-9]+)(?:[.]([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(String(amount));
      if (!match) return null;
      const fraction = match[3] || "";
      const power = Number(match[4] || 0) - fraction.length;
      if (!Number.isSafeInteger(power)) return null;
      const digits = BigInt((match[1] || "") + match[2] + fraction);
      if (power < exponent) {
        coefficient *= 10n ** BigInt(exponent - power);
        exponent = power;
      }
      coefficient += digits * (10n ** BigInt(power - exponent));
    }
    if (coefficient === 0n) return 0;
    const result = Number(String(coefficient) + "e" + exponent);
    if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) return null;
    const decimalDigits = (coefficient < 0n ? -coefficient : coefficient).toString();
    const significant = decimalDigits.replace(/0+$/, "");
    const precise = (coefficient < 0n ? "-" : "") + significant + "e" +
      (exponent + decimalDigits.length - significant.length);
    return decimalFingerprint(String(result)) === precise ? result : null;
  };
  const excludedCurrencyCount = rows =>
    rows.filter(x => String(x.currency || "").trim().toUpperCase() !== "RUB").length;
  const rubAmount = row => String(row.currency || "").trim().toUpperCase() === "RUB" ? num(row.amount) : -1;
  return {
    service: "topsense-sales-mvp",
    startedAt: SALES.startedAt,
    lastEventAt: SALES.lastEventAt,
    lastProcessedEventAt: SALES.lastProcessedEventAt,
    lastFailedEventAt: SALES.lastFailedEventAt,
    lastIgnoredEventAt: SALES.lastIgnoredEventAt,
    lastSyncAt: SALES.lastSyncAt,
    syncPartial: SALES.syncPartial,
    // A successful deal read may clear the latest sales-event error even
    // while earlier stage metadata failures are still awaiting a retry.
    lastError: SALES.lastError || (SALES.stageLookupFailed
      ? SALES.stageErrors.values().next().value || null : null),
    coverage: {
      // Scheduled reads do not enumerate the full CRM or reconcile deleted
      // deals/activities. A recent successful scan is not a complete census.
      recentDealLookbackDays: DEAL_SYNC_LOOKBACK_DAYS,
      deletedDealsReconciled: false,
      deletedActivitiesReconciled: false,
    },
    scoringLimitations: {
      // DATE_MODIFY is the latest confirmed deal edit, not a proven stage
      // transition timestamp. Initial stage ages (and later observed moves)
      // are source-version estimates until CRM stage history is integrated.
      stageAgeEstimatedFromDateModify: true,
      // Where Bitrix returns its actual stage-transition timestamp, Risk
      // uses that instead of treating an unrelated deal edit as a stage move.
      stageAgeUsesMovedTimeWhenAvailable: true,
      // Live scoring has no confirmed activity-list read. Optional deal
      // fields ACTIVITY_TIME and NEXT_ACTIVITY_TIME are absent from the
      // documented crm.deal.fields contract; missing fields cannot prove
      // that the deal has no pending actions.
      nextStepNotVerifiedByActivityList: true,
    },
    counts: {
      tracked: all.length,
      open: open.length,
      prospects: prospects.length,
      highProspects: high.length,
      risk: risk.length,
      noNext: noNext.length,
      qualificationIssues: qualIssues.length,
      won: won.length,
    },
    sums: {
      open: sumRub(open),
      prospects: sumRub(prospects),
      highProspects: sumRub(high),
      risk: sumRub(risk),
      won: sumRub(won),
    },
    excludedCurrencyCounts: {
      open: excludedCurrencyCount(open),
      prospects: excludedCurrencyCount(prospects),
      highProspects: excludedCurrencyCount(high),
      risk: excludedCurrencyCount(risk),
      won: excludedCurrencyCount(won),
    },
    prospects: prospects
      .sort((a,b) => b.prospectScore - a.prospectScore || rubAmount(b) - rubAmount(a))
      .slice(0, 25),
    attention: open
      .filter(x => x.riskScore >= 45 || !x.hasNext || x.qualificationIssue)
      .sort((a,b) => b.riskScore - a.riskScore || rubAmount(b) - rubAmount(a))
      .slice(0, 30),
    wins: won.slice(0, 20),
    recentHistory,
    alerts,
  };
}

function badgeClass(type) {
  if (type === "success") return "ok";
  if (type === "risk") return "bad";
  if (type === "prospect") return "star";
  return "warn";
}

function dealLink(id) {
  return bitrixOrigin() + "/crm/deal/details/" + encodeURIComponent(id) + "/";
}

function html() {
  const s = status();
  const syncAge = s.lastSyncAt ? Date.now() - Date.parse(s.lastSyncAt) : Infinity;
  const syncState = s.lastError ? "bad" : s.syncPartial ? "partial" : !s.lastSyncAt ? "pending" : syncAge <= 5 * 60 * 1000 ? "ok" : "stale";
  const syncLabel = s.lastError ? "Ошибка последней операции" : s.syncPartial ? "Частичная синхронизация — загрузка продолжается" : !s.lastSyncAt ? "Ожидание первой синхронизации" : syncAge <= 5 * 60 * 1000 ? "Синхронизация актуальна" : "Синхронизация устарела";
  const sumHint = key => (s.sums[key] === null
    ? "— · превышен предел точности"
    : money(s.sums[key], "RUB")) + " · только RUB" +
    (s.excludedCurrencyCounts[key] ? " · " + s.excludedCurrencyCounts[key] + " вне суммы" : "");
  const prospectRows = s.prospects.map(x => `<tr>
    <td><a href="${escapeHtml(dealLink(x.dealId))}" target="_blank" rel="noopener">#${escapeHtml(x.dealId)} · ${escapeHtml(x.title)}</a></td>
    <td>${escapeHtml(x.manager)}</td>
    <td>${escapeHtml(money(x.amount, x.currency))}</td>
    <td><span class="score good">${x.prospectScore}</span></td>
    <td>${escapeHtml(x.stageName)}</td>
    <td>${shortDate(x.lastActivityAt)}</td>
    <td>${shortDate(x.nextActivityAt)}</td>
    <td>${escapeHtml(x.nextStep)}</td>
  </tr>`).join("");

  const attentionRows = s.attention.map(x => `<tr>
    <td><a href="${escapeHtml(dealLink(x.dealId))}" target="_blank" rel="noopener">#${escapeHtml(x.dealId)} · ${escapeHtml(x.title)}</a></td>
    <td>${escapeHtml(x.manager)}</td>
    <td>${escapeHtml(money(x.amount, x.currency))}</td>
    <td><span class="score ${x.riskScore >= 60 ? "bad" : "warn"}">${x.riskScore}</span></td>
    <td>${x.hasNext ? "есть" : '<span class="red">нет</span>'}</td>
    <td>${x.qualificationIssue ? '<span class="red">проверить</span>' : "—"}</td>
    <td>${escapeHtml(x.nextStep)}</td>
  </tr>`).join("");

  const outcomeLabel = semantic => semantic === "S" ? "Продажа" :
    semantic === "F" ? "Закрыта без продажи" : semantic === "P" ? "В работе" : "Не определено";
  const historyRows = s.recentHistory.map(x => `<tr>
    <td>${shortDateTime(x.at)}</td>
    <td><a href="${escapeHtml(dealLink(x.dealId))}" target="_blank" rel="noopener">${escapeHtml(x.titleDeal)}</a></td>
    <td>${escapeHtml(x.manager)}</td>
    <td>${escapeHtml(x.stageName || x.stageId || "—")}</td>
    <td>${escapeHtml(outcomeLabel(x.semantic))}</td>
    <td><span class="score good">${x.prospectScore}</span></td>
    <td><span class="score ${x.riskScore >= 60 ? "bad" : "warn"}">${x.riskScore}</span></td>
    <td>${escapeHtml(money(x.amount, x.currency))}</td>
  </tr>`).join("");

  const alertRows = s.alerts.slice(0,12).map(a => `<div class="alert">
    <span class="dot ${badgeClass(a.type)}"></span>
    <div><b>${escapeHtml(a.title)}</b><br><a href="${escapeHtml(dealLink(a.dealId))}" target="_blank" rel="noopener">${escapeHtml(a.titleDeal)}</a><br><small>${escapeHtml(a.manager)} · ${escapeHtml(money(a.amount, a.currency))} · ${shortDate(a.at)}</small></div>
  </div>`).join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>TOP-SENS · Sales Control MVP</title>
<style>
:root{color-scheme:dark;font-family:Inter,Arial,sans-serif;background:#07111f;color:#e8eef8}*{box-sizing:border-box}
body{margin:0;background:#07111f}.wrap{padding:18px;max-width:1900px;margin:auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.top h1{margin:0;font-size:28px}.sub{color:#8ea0b8;margin-top:5px}.live{padding:7px 10px;border:1px solid #29405d;border-radius:999px;color:#8fd0a7;background:#0f2630;font-size:13px}.live.bad{color:#ff9ea9;background:#321c25;border-color:#5b2a34}.live.pending,.live.stale,.live.partial{color:#b9c4d4;background:#182335;border-color:#35435a}
.cards{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px;margin:16px 0}.card{background:#101d30;border:1px solid #21344d;border-radius:13px;padding:14px}.k{color:#8ea0b8;font-size:12px;text-transform:uppercase}.v{font-size:27px;font-weight:800;margin-top:6px}.hint{font-size:12px;color:#9dafc4;margin-top:4px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px}.panel{background:#0e1a2b;border:1px solid #21344d;border-radius:13px;padding:12px;margin-bottom:12px}.panel h2{margin:3px 0 10px;font-size:19px}
table{width:100%;border-collapse:collapse;font-size:13px}th{color:#8ea0b8;text-align:left;font-size:11px;text-transform:uppercase;border-bottom:1px solid #263a53;padding:8px}td{padding:9px 8px;border-bottom:1px solid #1b2c42;vertical-align:top}a{color:#d8e8ff;text-decoration:none}a:hover{text-decoration:underline}
.score{display:inline-flex;min-width:34px;justify-content:center;padding:3px 7px;border-radius:999px;font-weight:700}.score.good{background:#123d31;color:#84e0b0}.score.warn{background:#493819;color:#ffd27c}.score.bad{background:#4b2028;color:#ff9ea9}
.red{color:#ff8e9b}.alerts{display:flex;flex-direction:column;gap:7px}.alert{display:flex;gap:9px;padding:9px;border-radius:10px;background:#101f33}.dot{width:9px;height:9px;border-radius:50%;margin-top:5px;flex:0 0 auto}.dot.ok{background:#44d98b}.dot.bad{background:#ff5f6d}.dot.star{background:#ffd05a}.dot.warn{background:#f2a742}.alert small{color:#8ea0b8}
.note{font-size:12px;color:#8ea0b8;margin-top:7px}.coverage-warning{margin:12px 0;padding:10px 12px;border:1px solid #765531;border-radius:9px;background:#322719;color:#ffe1ad;font-size:13px}@media(max-width:1200px){.cards{grid-template-columns:repeat(3,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:700px){.cards{grid-template-columns:repeat(2,1fr)}.wrap{padding:10px}.tablewrap{overflow:auto}table{min-width:900px}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>TOP-SENS · Sales Control</h1><div class="sub">MVP контроля перспективных и проблемных сделок из Bitrix24</div></div><div class="live ${syncState}">${syncState === "ok" ? "● " : "○ "}${escapeHtml(syncLabel)} · автообновление 20 сек</div></div>
<div class="coverage-warning" role="note"><strong>Ограничение охвата:</strong> проверяются только сделки, изменённые за последние ${s.coverage.recentDealLookbackDays} дней. Удаления сделок и активностей Bitrix24 не сверяются. Итоги, Prospect/Risk Score и Next Step могут включать устаревшие записи даже после успешной синхронизации.</div>
<div class="cards">
<div class="card"><div class="k">Открытые</div><div class="v">${s.counts.open}</div><div class="hint">${escapeHtml(sumHint("open"))}</div></div>
<div class="card"><div class="k">Перспективные</div><div class="v">${s.counts.prospects}</div><div class="hint">${escapeHtml(sumHint("prospects"))}</div></div>
<div class="card"><div class="k">Горячие ≥75</div><div class="v">${s.counts.highProspects}</div><div class="hint">${escapeHtml(sumHint("highProspects"))}</div></div>
<div class="card"><div class="k">Красная зона</div><div class="v">${s.counts.risk}</div><div class="hint">${escapeHtml(sumHint("risk"))}</div></div>
<div class="card"><div class="k">Без Next Step</div><div class="v">${s.counts.noNext}</div><div class="hint">нужно назначить действие</div></div>
<div class="card"><div class="k">Квалификация</div><div class="v">${s.counts.qualificationIssues}</div><div class="hint">нужна проверка</div></div>
</div>
<div class="layout"><main>
<div class="panel"><h2>⭐ Перспективные сделки</h2><div class="tablewrap"><table><thead><tr><th>Сделка</th><th>Менеджер</th><th>Сумма</th><th>Score</th><th>Этап</th><th>Последняя активность CRM</th><th>Next Step</th><th>Что делать</th></tr></thead><tbody>${prospectRows || '<tr><td colspan="8">Пока нет сделок с score ≥60. База заполняется из Bitrix.</td></tr>'}</tbody></table></div></div>
<div class="coverage-warning" role="note">Next Step не подтверждён crm.activity.list: текущий расчёт использует поля сделки ACTIVITY_TIME / NEXT_ACTIVITY_TIME, отсутствующие в стандартном списке crm.deal.fields. Отсутствие даты в ответе сделки не доказывает отсутствие запланированных дел. Перед решениями проверьте Next Step и зависящие от него Prospect/Risk Score в Bitrix24.</div>
<div class="panel"><h2>🔴 Требуют внимания</h2><div class="tablewrap"><table><thead><tr><th>Сделка</th><th>Менеджер</th><th>Сумма</th><th>Risk</th><th>Next Step</th><th>Квалификация</th><th>Действие</th></tr></thead><tbody>${attentionRows || '<tr><td colspan="7">Критичных отклонений не найдено.</td></tr>'}</tbody></table></div><div class="note">Risk Score оценивает давность по последней активности в CRM-таймлайне (LAST_ACTIVITY_TIME), а не по подтверждённому контакту с клиентом. Перед выводами проверьте звонки и переписку в Bitrix24. При наличии MOVED_TIME возраст стадии берётся из Bitrix24; если поле отсутствует, возраст стадии оценивается по DATE_MODIFY, а не по подтверждённой дате перехода: после недавнего редактирования сделки это может занижать риск. Проверьте историю стадий Bitrix24.</div></div>
<div class="panel"><h2>История оценок</h2><div class="tablewrap"><table><thead><tr><th>Время</th><th>Сделка</th><th>Менеджер</th><th>Этап</th><th>Результат</th><th>Prospect</th><th>Risk</th><th>Сумма</th></tr></thead><tbody>${historyRows || '<tr><td colspan="8">История появится после загрузки сделок.</td></tr>'}</tbody></table></div><div class="note">Последние 25 наблюдений: первичная загрузка, изменение стадии или оценок.</div></div>
</main><aside><div class="panel"><h2>Уведомления</h2><div class="alerts">${alertRows || '<div class="note">События появятся после изменений сделок.</div>'}</div></div>
<div class="panel"><h2>Статус</h2><div class="note">Отслеживается: ${s.counts.tracked} сделок<br>Последний webhook: ${escapeHtml(s.lastEventAt || "—")}<br>Обработан CRM: ${escapeHtml(s.lastProcessedEventAt || "—")}<br>Ошибка обработки: ${escapeHtml(s.lastFailedEventAt || "—")}<br>Пропущен без сделки: ${escapeHtml(s.lastIgnoredEventAt || "—")}<br>Последняя синхронизация: ${escapeHtml(s.lastSyncAt || "—")}<br>Ошибка: ${escapeHtml(s.lastError?.message || "нет")}</div></div></aside></div>
</div></body></html>`;
}

async function start() {
  await loadStages();
  await loadPersisted();
  setTimeout(() => syncRecentDeals().catch(() => {}), 5000);
  SALES.syncTimer = setInterval(() => syncRecentDeals(2).catch(() => {}), 2 * 60 * 1000);
}

module.exports = {
  handleEvent,
  start,
  status,
  html,
};

const SALES = {
  startedAt: new Date().toISOString(),
  lastEventAt: null,
  lastSyncAt: null,
  // A bounded page scan is incomplete until Bitrix stops returning next.
  syncPartial: false,
  syncCursor: 0,
  syncSince: null,
  lastError: null,
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

function bitrixBaseUrl() {
  const raw = String(process.env.BITRIX_WEBHOOK_BASE || "").trim();
  if (!raw) throw new Error("BITRIX_WEBHOOK_BASE is not configured");
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

async function bitrixRaw(method, params = {}) {
  // POST is the Bitrix REST transport; the REST method itself must be read-only.
  // Prevent accidental CRM writes if a future caller adds a mutating method.
  if (!READ_ONLY_BITRIX_METHODS.has(method)) {
    throw new Error("Read-only Bitrix method blocked");
  }
  const url = new URL(method + ".json", bitrixBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error_description || payload?.error || ("HTTP " + response.status));
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

async function storeRequest(action, rows = null) {
  if (!storeConfigured()) return null;
  const body = {
    action,
    secret: String(process.env.GOOGLE_SHEET_STORE_SECRET || "").trim(),
  };
  if (rows) body.rows = rows;
  const response = await fetch(String(process.env.GOOGLE_SHEET_STORE_URL || "").trim(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("Invalid Sales store response"); }
  // HTTP 200 alone is not an acknowledgement: redirects, login pages or
  // malformed JSON must never cause pending score history to be discarded.
  if (!response.ok || !payload || typeof payload !== "object" ||
      Array.isArray(payload) || payload.ok === false) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "Sales store response failed");
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

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function dateValue(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function daysSince(value) {
  const t = dateValue(value);
  return t ? Math.max(0, (Date.now() - t) / 86400000) : null;
}

function isoOrNull(value) {
  const t = dateValue(value);
  return t ? new Date(t).toISOString() : null;
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

function stageSemantic(deal) {
  const direct = String(deal.STAGE_SEMANTIC_ID || "").toUpperCase();
  if (direct) return direct;
  const stage = SALES.stages.get(String(deal.STAGE_ID || ""));
  return String(stage?.semantics || "").toUpperCase();
}

function isOpenSemantic(semantic) {
  return semantic !== "S" && semantic !== "F";
}

function money(value, currency = "RUB") {
  const code = String(currency || "RUB").trim().toUpperCase();
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(num(value));
  if (!/^[A-Z]{3}$/.test(code)) return formatted + " " + code;
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency", currency: code, maximumFractionDigits: 0,
    }).format(num(value));
  } catch {
    return formatted + " " + code;
  }
}

function shortDate(value) {
  const t = dateValue(value);
  if (!t) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(t));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadStages() {
  try {
    const result = await bitrixCall("crm.status.list", {
      filter: { ENTITY_ID: "DEAL_STAGE" },
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
          typeof row.STATUS_ID !== "string" || !row.STATUS_ID.trim()) {
        throw new Error("Invalid Bitrix stage metadata row");
      }
      // Both metadata fields are single-value strings. An array ['S'] gets
      // string-coerced into the won semantic by stageSemantic(), and could
      // falsely close deals when a CRM deal omits STAGE_SEMANTIC_ID.
      // Validate every row before atomically replacing the stage cache.
      if ((row.NAME != null && typeof row.NAME !== "string") ||
          (row.SEMANTICS != null && typeof row.SEMANTICS !== "string")) {
        throw new Error("Invalid Bitrix stage metadata value");
      }
      const stageId = row.STATUS_ID.trim();
      if (stages.has(stageId)) throw new Error("Duplicate Bitrix stage metadata ID");
      stages.set(stageId, {
        name: row.NAME || stageId,
        semantics: row.SEMANTICS || "",
      });
    }
    SALES.stages = stages;
    if (SALES.lastError?.source === "stages") SALES.lastError = null;
  } catch (error) {
    SALES.lastError = { at: new Date().toISOString(), source: "stages", message: String(error.message || error) };
  }
}

async function managerName(id) {
  const key = String(id || "");
  if (!key) return "—";
  if (SALES.managers.has(key)) return SALES.managers.get(key);

  // Concurrent event handlers can resolve user.get out of order. Only the
  // most recently started lookup may populate the shared manager cache.
  const lookupVersion = (SALES.managerLookupVersions.get(key) || 0) + 1;
  SALES.managerLookupVersions.set(key, lookupVersion);
  try {
    const users = await bitrixCall("user.get", { ID: Number(key) });
    // Bitrix may return a malformed/partial user list. A different user's
    // name must never be attributed to the deal's assigned manager.
    const user = Array.isArray(users)
      ? users.find(candidate => candidate && typeof candidate === "object" &&
          String(candidate.ID ?? "") === key)
      : null;
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
  const id = String(value ?? "").trim();
  return /^[1-9]\d{0,14}$/.test(id) && Number.isSafeInteger(Number(id));
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
    const validAmount = typeof opportunity === "number"
      ? Number.isFinite(opportunity)
      : decimal && Number.isFinite(Number(opportunity.trim()));
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
  for (const field of ["DATE_MODIFY", "DATE_CREATE", "LAST_ACTIVITY_TIME"]) {
    const value = deal[field];
    if (value == null || value === "") continue;
    const timestamp = typeof value === "string" ? dateValue(value) : null;
    // An unparseable observed date can silently erase stale-contact risk,
    // and a malformed DATE_MODIFY can bypass source-version ordering.
    // Reject malformed fields as well as dates too far in the future.
    if (timestamp === null || timestamp > latestPlausible) {
      throw new Error("Invalid Bitrix deal " + field + " timestamp");
    }
  }
  // Future scheduled actions are legitimate, but a malformed non-empty
  // activity date would otherwise erase the verified Next Step and inflate
  // Risk Score. Do not impose the past-observation clock limit on plans.
  for (const field of ["ACTIVITY_TIME", "NEXT_ACTIVITY_TIME"]) {
    const value = deal[field];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || dateValue(value) === null) {
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
  const ownerType = String(activity.OWNER_TYPE_ID ?? "").trim();
  if (!/^[1-9]\d*$/.test(ownerType) || !Number.isSafeInteger(Number(ownerType))) {
    throw new Error("Invalid Bitrix activity owner type");
  }
  if (ownerType === "2" && !validDealId(activity.OWNER_ID)) {
    throw new Error("Invalid Bitrix activity deal owner");
  }
  return activity;
}

function scoreDeal(deal, previous) {
  const semantic = stageSemantic(deal);
  const stageSemanticKnown = semantic === "P" || semantic === "S" || semantic === "F";
  const open = isOpenSemantic(semantic);
  const amount = num(deal.OPPORTUNITY);
  const currency = String(deal.CURRENCY_ID || "RUB").trim().toUpperCase();
  const amountIsRub = currency === "RUB";
  const createdAt = deal.DATE_CREATE || deal.BEGINDATE || null;
  const modifiedAt = deal.DATE_MODIFY || null;
  const lastActivityAt = deal.LAST_ACTIVITY_TIME || null;
  const nextActivityAt = deal.ACTIVITY_TIME || deal.NEXT_ACTIVITY_TIME || null;
  const lastAge = daysSince(lastActivityAt);
  const dealAge = daysSince(createdAt);
  const nextTs = dateValue(nextActivityAt);
  const hasNext = Boolean(nextTs && nextTs > Date.now() - 5 * 60 * 1000);
  const nextOverdue = Boolean(nextTs && nextTs < Date.now() - 5 * 60 * 1000);
  const qual = qualificationStatus(deal);
  // Only an affirmative qualification status earns the full scoring bonus.
  // A status such as "Не квалифицировано" must not match a substring search.
  const qualificationConfirmed = /^квалифицировано$/i.test(qual);
  const type = clientType(deal);
  const stageId = String(deal.STAGE_ID || "");
  const nowIso = new Date().toISOString();

  let stageEnteredAt = previous?.stageEnteredAt || deal.DATE_MODIFY || deal.DATE_CREATE || nowIso;
  if (previous && previous.stageId !== stageId) stageEnteredAt = nowIso;
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
  if (stageId && !/^NEW$/i.test(stageId)) prospect += 5;
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

  const stage = SALES.stages.get(stageId);
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

function addAlert(snapshot, previous) {
  const alerts = Array.isArray(previous?.alerts) ? previous.alerts.slice(-MAX_ALERTS) : [];
  const now = new Date().toISOString();

  const push = (type, title, detail) => {
    if (alerts.some(a => a.type === type && a.title === title && (Date.now() - dateValue(a.at)) < 6 * 3600000)) return;
    alerts.push({ at: now, type, title, detail });
  };

  if (snapshot.semantic === "S" && previous?.semantic !== "S") {
    push("success", "Сделка успешно закрыта", money(snapshot.amount, snapshot.currency));
  }
  if (snapshot.open && snapshot.prospectScore >= 70 && num(previous?.prospectScore) < 70) {
    push("prospect", "Перспективная сделка", "Score " + snapshot.prospectScore + " · " + money(snapshot.amount, snapshot.currency));
  }
  if (snapshot.open && snapshot.riskScore >= 60 && num(previous?.riskScore) < 60) {
    push("risk", "Сделка вошла в красную зону", "Risk " + snapshot.riskScore + " · " + snapshot.nextStep);
  }
  if (snapshot.open && !snapshot.hasNext && previous?.hasNext !== false) {
    push("warning", "Нет следующего действия", snapshot.nextStep);
  }
  if (snapshot.qualificationIssue && !previous?.qualificationIssue) {
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
  const latestVersion = latest
    ? (Object.prototype.hasOwnProperty.call(latest, "sourceUpdatedAt") ? latest.sourceUpdatedAt : latest.updatedAt)
    : "";
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
      if (order === 0 && source === "activity") {
        // Bitrix can add a scheduled action without changing the deal's
        // DATE_MODIFY or last contact. Accept strictly newer contact/next times,
        // but never regress either field from an out-of-order activity read.
        // An earlier reschedule needs a newer source version to disambiguate.
        const incomingLast = dateValue(deal.LAST_ACTIVITY_TIME);
        const currentLast = dateValue(latest.lastActivityAt);
        const incomingNext = dateValue(deal.ACTIVITY_TIME || deal.NEXT_ACTIVITY_TIME);
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
      STAGE_SEMANTIC_ID: latest.semantic,
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
        (deal.ACTIVITY_TIME || deal.NEXT_ACTIVITY_TIME) : latest.nextActivityAt,
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
    last.prospectScore !== row.prospectScore ||
    last.riskScore !== row.riskScore ||
    num(last.amount) !== row.amount ||
    last.currency !== row.currency
  ) {
    history.push({
      // For an activity-only refresh the CRM DATE_MODIFY is unchanged; use
      // observation time for this new history entry, not the old deal version.
      at: chronologicalHistoryAt(
        activityOnlyRefresh ? row.observedAt : row.updatedAt, last?.at, row.observedAt
      ),
      stageId: row.stageId,
      stageName: row.stageName,
      amount: row.amount,
      currency: row.currency,
      prospectScore: row.prospectScore,
      riskScore: row.riskScore,
    });
  }
  row.scoreHistory = history.slice(-MAX_HISTORY);
  row.alerts = addAlert(row, previous);

  const changed = !previous || [
    "title","managerId","sourceId","categoryId","stageId","semantic","stageSemanticKnown","amount","currency","sourceUpdatedAt",
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
  const scoreValid = score => typeof score === "number" &&
    Number.isFinite(score) && score >= 0 && score <= 100;
  const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const optionalPastDate = value => value == null ||
    (typeof value === "string" && plausibleVersion(value));
  const optionalScheduledDate = value => value == null ||
    (typeof value === "string" && dateValue(value) !== null);

  if (!record(row) || row.kind !== "salesDeal" ||
      typeof row.title !== "string" || typeof row.manager !== "string" ||
      typeof row.stageId !== "string" || typeof row.semantic !== "string" ||
      typeof row.currency !== "string" || typeof row.nextStep !== "string" ||
      typeof row.open !== "boolean" || row.open !== isOpenSemantic(row.semantic) ||
      typeof row.hasNext !== "boolean" || typeof row.qualificationIssue !== "boolean" ||
      typeof row.amount !== "number" || !Number.isFinite(row.amount) ||
      !scoreValid(row.prospectScore) || !scoreValid(row.riskScore) ||
      typeof row.updatedAt !== "string" || !plausibleVersion(row.updatedAt) ||
      (row.sourceUpdatedAt != null &&
        (typeof row.sourceUpdatedAt !== "string" || !plausibleVersion(row.sourceUpdatedAt))) ||
      !optionalPastDate(row.createdAt) ||
      !optionalPastDate(row.modifiedAt) ||
      !optionalPastDate(row.lastActivityAt) ||
      !optionalPastDate(row.stageEnteredAt) ||
      !optionalPastDate(row.observedAt) ||
      !optionalScheduledDate(row.nextActivityAt) ||
      !Array.isArray(row.scoreHistory) || row.scoreHistory.length > MAX_HISTORY ||
      !Array.isArray(row.alerts) || row.alerts.length > MAX_ALERTS) {
    return false;
  }

  // A malformed nested array can otherwise break Dashboard.status(), while
  // unlimited history/alerts can expand the read-only JSON response without
  // bounds. These shapes are exactly what Sales writes on a successful save.
  return row.scoreHistory.every(entry =>
    record(entry) && typeof entry.at === "string" && plausibleVersion(entry.at) &&
    typeof entry.amount === "number" && Number.isFinite(entry.amount) &&
    scoreValid(entry.prospectScore) && scoreValid(entry.riskScore)) &&
    row.alerts.every(entry =>
      record(entry) && typeof entry.at === "string" && plausibleVersion(entry.at) &&
      typeof entry.type === "string" && typeof entry.title === "string" &&
      typeof entry.detail === "string");
}

async function loadPersisted() {
  if (!storeConfigured()) return;
  try {
    const payload = await storeRequest("load");
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    let count = 0;
    let rejected = 0;
    for (const entry of rows) {
      const key = String(entry?.key || "");
      const row = entry?.payload;
      if (!key.startsWith(SALES_PREFIX)) continue;

      const id = String(row?.dealId ?? "");
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

      SALES.deals.set(id, row);
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
  return snapshotDeal(validateDealRow(deal, String(dealId)), source);
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

async function handleEvent(evt) {
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
    if (result && SALES.lastError?.source === "sales-event") SALES.lastError = null;
    return result;
  } catch (error) {
    SALES.lastError = { at: new Date().toISOString(), source: "sales-event", message: String(error.message || error) };
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

async function syncRecentDeals(limitPages = 4) {
  if (SALES.syncing) return;
  SALES.syncing = true;
  try {
    // Continue bounded scans instead of restarting at page zero forever.
    // Keep the same cutoff throughout the scan, including across timer ticks.
    const resume = SALES.syncPartial && SALES.syncCursor > 0 && SALES.syncSince;
    let start = resume ? SALES.syncCursor : 0;
    let pages = 0;
    const since = resume ? SALES.syncSince : new Date(Date.now() - 45 * 86400000).toISOString();

    do {
      const payload = await bitrixRaw("crm.deal.list", {
        order: { DATE_MODIFY: "DESC" },
        filter: { ">DATE_MODIFY": since },
        select: [
          "ID","TITLE","ASSIGNED_BY_ID","SOURCE_ID","CATEGORY_ID","STAGE_ID","STAGE_SEMANTIC_ID",
          "OPPORTUNITY","CURRENCY_ID","DATE_CREATE","DATE_MODIFY","BEGINDATE","CLOSEDATE",
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
      for (const deal of rows) {
        await snapshotDeal(validateDealRow(deal), "sync");
      }

      pages += 1;
      if (payload.next === undefined || payload.next === null) {
        start = -1;
      } else {
        const cursorText = String(payload.next).trim();
        const next = Number(cursorText);
        // Bitrix crm.deal.list uses pages of at most 50 records. A cursor
        // that jumps further can silently skip deals and falsely mark the
        // dashboard sync complete once the jumped-to page is exhausted.
        // Do not skip unseen records when a short/empty Bitrix page claims
        // a cursor advance larger than the number of rows returned.
        if (!/^[1-9]\d*$/.test(cursorText) || !Number.isSafeInteger(next) ||
            next <= start || next - start > 50 || next - start > rows.length) {
          throw new Error("Invalid Bitrix pagination cursor");
        }
        start = next;
      }

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
    SALES.syncPartial = false;
    SALES.syncCursor = 0;
    SALES.syncSince = null;
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
      STAGE_SEMANTIC_ID: previous.semantic,
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
    const keys = ["prospectScore", "riskScore", "hasNext", "nextOverdue", "qualificationIssue", "nextStep"];
    if (keys.every(key => scored[key] === previous[key])) continue;

    const row = { ...previous, ...scored };
    const history = Array.isArray(previous.scoreHistory) ? previous.scoreHistory.slice(-MAX_HISTORY) : [];
    const last = history[history.length - 1];
    if (!last || last.prospectScore !== row.prospectScore || last.riskScore !== row.riskScore) {
      history.push({
        at: chronologicalHistoryAt(new Date().toISOString(), last?.at),
        stageId: row.stageId,
        stageName: row.stageName,
        amount: row.amount,
        currency: row.currency,
        prospectScore: row.prospectScore,
        riskScore: row.riskScore,
      });
    }
    row.scoreHistory = history.slice(-MAX_HISTORY);
    row.alerts = addAlert(row, previous);
    SALES.deals.set(id, row);
    markDirty(id);
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
  const alerts = all
    .flatMap(x => (x.alerts || []).map(a => ({ ...a, dealId: x.dealId, titleDeal: x.title, manager: x.manager, amount: x.amount, currency: x.currency })))
    .sort((a, b) => (dateValue(b.at) || 0) - (dateValue(a.at) || 0))
    .slice(0, 30);

  // Dashboard totals are deliberately RUB-only. Other currencies are shown
  // per deal and counted separately; no implicit FX conversion is performed.
  const sumRub = rows => rows.reduce((acc, x) =>
    acc + (String(x.currency || "").toUpperCase() === "RUB" ? num(x.amount) : 0), 0);
  const excludedCurrencyCount = rows =>
    rows.filter(x => String(x.currency || "").toUpperCase() !== "RUB").length;
  const rubAmount = row => String(row.currency || "").toUpperCase() === "RUB" ? num(row.amount) : -1;
  return {
    service: "topsense-sales-mvp",
    startedAt: SALES.startedAt,
    lastEventAt: SALES.lastEventAt,
    lastSyncAt: SALES.lastSyncAt,
    syncPartial: SALES.syncPartial,
    lastError: SALES.lastError,
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
  const sumHint = key => money(s.sums[key], "RUB") + " · только RUB" +
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
.note{font-size:12px;color:#8ea0b8;margin-top:7px}@media(max-width:1200px){.cards{grid-template-columns:repeat(3,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:700px){.cards{grid-template-columns:repeat(2,1fr)}.wrap{padding:10px}.tablewrap{overflow:auto}table{min-width:900px}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>TOP-SENS · Sales Control</h1><div class="sub">MVP контроля перспективных и проблемных сделок из Bitrix24</div></div><div class="live ${syncState}">${syncState === "ok" ? "● " : "○ "}${escapeHtml(syncLabel)} · автообновление 20 сек</div></div>
<div class="cards">
<div class="card"><div class="k">Открытые</div><div class="v">${s.counts.open}</div><div class="hint">${escapeHtml(sumHint("open"))}</div></div>
<div class="card"><div class="k">Перспективные</div><div class="v">${s.counts.prospects}</div><div class="hint">${escapeHtml(sumHint("prospects"))}</div></div>
<div class="card"><div class="k">Горячие ≥75</div><div class="v">${s.counts.highProspects}</div><div class="hint">${escapeHtml(sumHint("highProspects"))}</div></div>
<div class="card"><div class="k">Красная зона</div><div class="v">${s.counts.risk}</div><div class="hint">${escapeHtml(sumHint("risk"))}</div></div>
<div class="card"><div class="k">Без Next Step</div><div class="v">${s.counts.noNext}</div><div class="hint">нужно назначить действие</div></div>
<div class="card"><div class="k">Квалификация</div><div class="v">${s.counts.qualificationIssues}</div><div class="hint">нужна проверка</div></div>
</div>
<div class="layout"><main>
<div class="panel"><h2>⭐ Перспективные сделки</h2><div class="tablewrap"><table><thead><tr><th>Сделка</th><th>Менеджер</th><th>Сумма</th><th>Score</th><th>Этап</th><th>Последний контакт</th><th>Next Step</th><th>Что делать</th></tr></thead><tbody>${prospectRows || '<tr><td colspan="8">Пока нет сделок с score ≥60. База заполняется из Bitrix.</td></tr>'}</tbody></table></div></div>
<div class="panel"><h2>🔴 Требуют внимания</h2><div class="tablewrap"><table><thead><tr><th>Сделка</th><th>Менеджер</th><th>Сумма</th><th>Risk</th><th>Next Step</th><th>Квалификация</th><th>Действие</th></tr></thead><tbody>${attentionRows || '<tr><td colspan="7">Критичных отклонений не найдено.</td></tr>'}</tbody></table></div></div>
</main><aside><div class="panel"><h2>Уведомления</h2><div class="alerts">${alertRows || '<div class="note">События появятся после изменений сделок.</div>'}</div></div>
<div class="panel"><h2>Статус</h2><div class="note">Отслеживается: ${s.counts.tracked} сделок<br>Последний webhook: ${escapeHtml(s.lastEventAt || "—")}<br>Последняя синхронизация: ${escapeHtml(s.lastSyncAt || "—")}<br>Ошибка: ${escapeHtml(s.lastError?.message || "нет")}</div></div></aside></div>
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

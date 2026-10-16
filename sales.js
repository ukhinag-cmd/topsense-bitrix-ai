const SALES = {
  startedAt: new Date().toISOString(),
  lastEventAt: null,
  lastSyncAt: null,
  lastError: null,
  syncing: false,
  deals: new Map(),
  managers: new Map(),
  stages: new Map(),
  dirty: new Set(),
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

async function bitrixRaw(method, params = {}) {
  const url = new URL(method + ".json", bitrixBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error_description || payload.error || ("HTTP " + response.status));
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
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || ("HTTP " + response.status));
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

function stageSemantic(deal) {
  const direct = String(deal.STAGE_SEMANTIC_ID || "").toUpperCase();
  if (direct) return direct;
  const stage = SALES.stages.get(String(deal.STAGE_ID || ""));
  return String(stage?.semantics || "").toUpperCase();
}

function isOpenSemantic(semantic) {
  return semantic !== "S" && semantic !== "F";
}

function money(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(num(value)) + " ₽";
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
    SALES.stages.clear();
    for (const row of Array.isArray(result) ? result : []) {
      SALES.stages.set(String(row.STATUS_ID || ""), {
        name: row.NAME || row.STATUS_ID || "",
        semantics: row.SEMANTICS || "",
      });
    }
  } catch (error) {
    SALES.lastError = { at: new Date().toISOString(), source: "stages", message: String(error.message || error) };
  }
}

async function managerName(id) {
  const key = String(id || "");
  if (!key) return "—";
  if (SALES.managers.has(key)) return SALES.managers.get(key);
  try {
    const users = await bitrixCall("user.get", { ID: Number(key) });
    const user = Array.isArray(users) ? users[0] : null;
    const name = user
      ? [user.NAME, user.LAST_NAME].filter(Boolean).join(" ").trim() || user.EMAIL || ("#" + key)
      : ("#" + key);
    SALES.managers.set(key, name);
    return name;
  } catch {
    const fallback = "#" + key;
    SALES.managers.set(key, fallback);
    return fallback;
  }
}

function qualificationStatus(deal) {
  return String(deal.UF_CRM_AI_QUAL_STATUS || "").trim();
}

function clientType(deal) {
  return String(deal.UF_CRM_AI_CLIENT_TYPE || "").trim();
}

function scoreDeal(deal, previous) {
  const semantic = stageSemantic(deal);
  const open = isOpenSemantic(semantic);
  const amount = num(deal.OPPORTUNITY);
  const createdAt = deal.DATE_CREATE || deal.BEGINDATE || null;
  const modifiedAt = deal.DATE_MODIFY || null;
  const lastActivityAt = deal.LAST_ACTIVITY_TIME || deal.LAST_ACTIVITY_BY || modifiedAt || createdAt;
  const nextActivityAt = deal.ACTIVITY_TIME || deal.NEXT_ACTIVITY_TIME || null;
  const lastAge = daysSince(lastActivityAt);
  const dealAge = daysSince(createdAt);
  const nextTs = dateValue(nextActivityAt);
  const hasNext = Boolean(nextTs && nextTs > Date.now() - 5 * 60 * 1000);
  const nextOverdue = Boolean(nextTs && nextTs < Date.now() - 5 * 60 * 1000);
  const qual = qualificationStatus(deal);
  const type = clientType(deal);
  const stageId = String(deal.STAGE_ID || "");
  const nowIso = new Date().toISOString();

  let stageEnteredAt = previous?.stageEnteredAt || deal.DATE_MODIFY || deal.DATE_CREATE || nowIso;
  if (previous && previous.stageId !== stageId) stageEnteredAt = nowIso;
  const stageAge = daysSince(stageEnteredAt);

  let prospect = 0;
  if (open) prospect += 10;
  if (amount > 0) prospect += 15;
  if (amount >= 50000) prospect += 10;
  if (amount >= 200000) prospect += 10;
  if (amount >= 1000000) prospect += 5;
  if (type) prospect += 10;
  if (/квалифицировано/i.test(qual)) prospect += 20;
  else if (qual) prospect += 8;
  if (hasNext) prospect += 15;
  if (lastAge !== null && lastAge <= 3) prospect += 10;
  else if (lastAge !== null && lastAge <= 7) prospect += 5;
  if (stageId && !/^NEW$/i.test(stageId)) prospect += 5;
  prospect = clamp(prospect);

  let risk = 0;
  if (open) {
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
    if (amount >= 500000) risk += 8;
  }
  risk = clamp(risk);

  const qualificationIssue = open && (
    (prospect >= 60 && !qual) ||
    (prospect >= 65 && /нужно|не определено/i.test(qual)) ||
    (amount >= 100000 && !type)
  );

  let nextStep = "";
  if (!open) {
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
    push("success", "Сделка успешно закрыта", money(snapshot.amount));
  }
  if (snapshot.open && snapshot.prospectScore >= 70 && num(previous?.prospectScore) < 70) {
    push("prospect", "Перспективная сделка", "Score " + snapshot.prospectScore + " · " + money(snapshot.amount));
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
  const previous = SALES.deals.get(id) || null;
  const scored = scoreDeal(deal, previous);
  const manager = await managerName(deal.ASSIGNED_BY_ID);

  const row = {
    kind: "salesDeal",
    dealId: id,
    title: String(deal.TITLE || ("Сделка #" + id)),
    managerId: String(deal.ASSIGNED_BY_ID || ""),
    manager,
    sourceId: String(deal.SOURCE_ID || ""),
    categoryId: String(deal.CATEGORY_ID || "0"),
    stageId: String(deal.STAGE_ID || ""),
    currency: String(deal.CURRENCY_ID || "RUB"),
    updatedAt: isoOrNull(deal.DATE_MODIFY) || new Date().toISOString(),
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
    num(last.amount) !== row.amount
  ) {
    history.push({
      at: row.updatedAt,
      stageId: row.stageId,
      stageName: row.stageName,
      amount: row.amount,
      prospectScore: row.prospectScore,
      riskScore: row.riskScore,
    });
  }
  row.scoreHistory = history.slice(-MAX_HISTORY);
  row.alerts = addAlert(row, previous);

  const changed = !previous || [
    "title","managerId","sourceId","categoryId","stageId","semantic","amount",
    "prospectScore","riskScore","qualificationIssue","qualificationStatus",
    "clientType","lastActivityAt","nextActivityAt","hasNext","nextOverdue",
    "stageEnteredAt","nextStep"
  ].some(key => String(previous?.[key] ?? "") !== String(row?.[key] ?? "")) ||
    JSON.stringify(previous?.alerts || []) !== JSON.stringify(row.alerts || []);

  SALES.deals.set(id, row);
  if (changed) markDirty(id);
  return row;
}

function markDirty(id) {
  SALES.dirty.add(String(id));
  if (SALES.flushTimer) return;
  SALES.flushTimer = setTimeout(() => {
    SALES.flushTimer = null;
    flushDirty().catch(error => {
      SALES.lastError = { at: new Date().toISOString(), source: "sales-store", message: String(error.message || error) };
    });
  }, 2500);
}

async function flushDirty() {
  if (!storeConfigured() || !SALES.dirty.size) return;
  const ids = Array.from(SALES.dirty).slice(0, 50);
  const rows = ids
    .map(id => SALES.deals.get(id))
    .filter(Boolean)
    .map(row => ({ key: SALES_PREFIX + row.dealId, payload: row }));
  if (!rows.length) return;
  await storeRequest("upsert", rows);
  ids.forEach(id => SALES.dirty.delete(id));
  if (SALES.dirty.size) markDirty(Array.from(SALES.dirty)[0]);
}

async function loadPersisted() {
  if (!storeConfigured()) return;
  try {
    const payload = await storeRequest("load");
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    let count = 0;
    for (const entry of rows) {
      const key = String(entry?.key || "");
      const row = entry?.payload;
      if (!key.startsWith(SALES_PREFIX) || !row?.dealId) continue;
      SALES.deals.set(String(row.dealId), row);
      count += 1;
    }
    console.log(JSON.stringify({ source: "sales-mvp", action: "store-load-ok", count }));
  } catch (error) {
    SALES.lastError = { at: new Date().toISOString(), source: "sales-store-load", message: String(error.message || error) };
    console.warn(JSON.stringify({ source: "sales-mvp", action: "store-load-failed", error: String(error.message || error) }));
  }
}

async function processDealId(dealId, source = "event") {
  if (!dealId) return null;
  const deal = await bitrixCall("crm.deal.get", { ID: Number(dealId) });
  return snapshotDeal(deal, source);
}

async function processActivityId(activityId) {
  if (!activityId) return null;
  const activity = await bitrixCall("crm.activity.get", { id: Number(activityId) });
  if (String(activity?.OWNER_TYPE_ID || "") !== "2" || !activity?.OWNER_ID) return null;
  return processDealId(activity.OWNER_ID, "activity");
}

async function handleEvent(evt) {
  SALES.lastEventAt = new Date().toISOString();
  const upper = String(evt?.event || "").toUpperCase();
  try {
    if (upper.includes("CRMACTIVITY")) {
      return await processActivityId(evt.activityId);
    }
    if (upper.includes("CRMDEAL") && evt.dealId) {
      return await processDealId(evt.dealId, "deal-event");
    }
    return null;
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
    let start = 0;
    let pages = 0;
    const since = new Date(Date.now() - 45 * 86400000).toISOString();

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
      const rows = Array.isArray(payload.result) ? payload.result : [];
      for (const deal of rows) {
        await snapshotDeal(deal, "sync");
      }

      pages += 1;
      start = Number.isFinite(Number(payload.next)) ? Number(payload.next) : -1;

      if (start >= 0 && pages < limitPages) {
        await new Promise(resolve => setTimeout(resolve, 1400));
      }
    } while (start >= 0 && pages < limitPages);

    SALES.lastSyncAt = new Date().toISOString();
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

function status() {
  const all = sortedDeals();
  const open = all.filter(x => x.open);
  const prospects = open.filter(x => x.prospectScore >= 60);
  const high = open.filter(x => x.prospectScore >= 75);
  const risk = open.filter(x => x.riskScore >= 60);
  const noNext = open.filter(x => !x.hasNext);
  const qualIssues = open.filter(x => x.qualificationIssue);
  const won = all.filter(x => x.semantic === "S");
  const alerts = all
    .flatMap(x => (x.alerts || []).map(a => ({ ...a, dealId: x.dealId, titleDeal: x.title, manager: x.manager, amount: x.amount })))
    .sort((a, b) => (dateValue(b.at) || 0) - (dateValue(a.at) || 0))
    .slice(0, 30);

  const sum = rows => rows.reduce((acc, x) => acc + num(x.amount), 0);
  return {
    service: "topsense-sales-mvp",
    startedAt: SALES.startedAt,
    lastEventAt: SALES.lastEventAt,
    lastSyncAt: SALES.lastSyncAt,
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
      open: sum(open),
      prospects: sum(prospects),
      highProspects: sum(high),
      risk: sum(risk),
      won: sum(won),
    },
    prospects: prospects
      .sort((a,b) => b.prospectScore - a.prospectScore || b.amount - a.amount)
      .slice(0, 25),
    attention: open
      .filter(x => x.riskScore >= 45 || !x.hasNext || x.qualificationIssue)
      .sort((a,b) => b.riskScore - a.riskScore || b.amount - a.amount)
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
  const prospectRows = s.prospects.map(x => `<tr>
    <td><a href="${escapeHtml(dealLink(x.dealId))}" target="_blank" rel="noopener">#${escapeHtml(x.dealId)} · ${escapeHtml(x.title)}</a></td>
    <td>${escapeHtml(x.manager)}</td>
    <td>${money(x.amount)}</td>
    <td><span class="score good">${x.prospectScore}</span></td>
    <td>${escapeHtml(x.stageName)}</td>
    <td>${shortDate(x.lastActivityAt)}</td>
    <td>${shortDate(x.nextActivityAt)}</td>
    <td>${escapeHtml(x.nextStep)}</td>
  </tr>`).join("");

  const attentionRows = s.attention.map(x => `<tr>
    <td><a href="${escapeHtml(dealLink(x.dealId))}" target="_blank" rel="noopener">#${escapeHtml(x.dealId)} · ${escapeHtml(x.title)}</a></td>
    <td>${escapeHtml(x.manager)}</td>
    <td>${money(x.amount)}</td>
    <td><span class="score ${x.riskScore >= 60 ? "bad" : "warn"}">${x.riskScore}</span></td>
    <td>${x.hasNext ? "есть" : '<span class="red">нет</span>'}</td>
    <td>${x.qualificationIssue ? '<span class="red">проверить</span>' : "—"}</td>
    <td>${escapeHtml(x.nextStep)}</td>
  </tr>`).join("");

  const alertRows = s.alerts.slice(0,12).map(a => `<div class="alert">
    <span class="dot ${badgeClass(a.type)}"></span>
    <div><b>${escapeHtml(a.title)}</b><br><a href="${escapeHtml(dealLink(a.dealId))}" target="_blank" rel="noopener">${escapeHtml(a.titleDeal)}</a><br><small>${escapeHtml(a.manager)} · ${money(a.amount)} · ${shortDate(a.at)}</small></div>
  </div>`).join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>TOP-SENS · Sales Control MVP</title>
<style>
:root{color-scheme:dark;font-family:Inter,Arial,sans-serif;background:#07111f;color:#e8eef8}*{box-sizing:border-box}
body{margin:0;background:#07111f}.wrap{padding:18px;max-width:1900px;margin:auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.top h1{margin:0;font-size:28px}.sub{color:#8ea0b8;margin-top:5px}.live{padding:7px 10px;border:1px solid #29405d;border-radius:999px;color:#8fd0a7;background:#0f2630;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px;margin:16px 0}.card{background:#101d30;border:1px solid #21344d;border-radius:13px;padding:14px}.k{color:#8ea0b8;font-size:12px;text-transform:uppercase}.v{font-size:27px;font-weight:800;margin-top:6px}.hint{font-size:12px;color:#9dafc4;margin-top:4px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px}.panel{background:#0e1a2b;border:1px solid #21344d;border-radius:13px;padding:12px;margin-bottom:12px}.panel h2{margin:3px 0 10px;font-size:19px}
table{width:100%;border-collapse:collapse;font-size:13px}th{color:#8ea0b8;text-align:left;font-size:11px;text-transform:uppercase;border-bottom:1px solid #263a53;padding:8px}td{padding:9px 8px;border-bottom:1px solid #1b2c42;vertical-align:top}a{color:#d8e8ff;text-decoration:none}a:hover{text-decoration:underline}
.score{display:inline-flex;min-width:34px;justify-content:center;padding:3px 7px;border-radius:999px;font-weight:700}.score.good{background:#123d31;color:#84e0b0}.score.warn{background:#493819;color:#ffd27c}.score.bad{background:#4b2028;color:#ff9ea9}
.red{color:#ff8e9b}.alerts{display:flex;flex-direction:column;gap:7px}.alert{display:flex;gap:9px;padding:9px;border-radius:10px;background:#101f33}.dot{width:9px;height:9px;border-radius:50%;margin-top:5px;flex:0 0 auto}.dot.ok{background:#44d98b}.dot.bad{background:#ff5f6d}.dot.star{background:#ffd05a}.dot.warn{background:#f2a742}.alert small{color:#8ea0b8}
.note{font-size:12px;color:#8ea0b8;margin-top:7px}@media(max-width:1200px){.cards{grid-template-columns:repeat(3,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:700px){.cards{grid-template-columns:repeat(2,1fr)}.wrap{padding:10px}.tablewrap{overflow:auto}table{min-width:900px}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>TOP-SENS · Sales Control</h1><div class="sub">MVP контроля перспективных и проблемных сделок из Bitrix24</div></div><div class="live">● данные Bitrix · автообновление 20 сек</div></div>
<div class="cards">
<div class="card"><div class="k">Открытые</div><div class="v">${s.counts.open}</div><div class="hint">${money(s.sums.open)}</div></div>
<div class="card"><div class="k">Перспективные</div><div class="v">${s.counts.prospects}</div><div class="hint">${money(s.sums.prospects)}</div></div>
<div class="card"><div class="k">Горячие ≥75</div><div class="v">${s.counts.highProspects}</div><div class="hint">${money(s.sums.highProspects)}</div></div>
<div class="card"><div class="k">Красная зона</div><div class="v">${s.counts.risk}</div><div class="hint">${money(s.sums.risk)}</div></div>
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

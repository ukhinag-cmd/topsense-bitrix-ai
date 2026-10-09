const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const pdfParse = require("pdf-parse");

const PORT = process.env.PORT || 10000;
const MAX_BODY = 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function getNested(obj, path) {
  return path.reduce(
    (value, key) =>
      value && typeof value === "object" ? value[key] : undefined,
    obj
  );
}

function parseBody(raw, contentType) {
  if ((contentType || "").includes("application/json")) {
    try {
      return { kind: "json", value: JSON.parse(raw || "{}") };
    } catch {
      return { kind: "json", value: {} };
    }
  }

  return { kind: "form", value: new URLSearchParams(raw) };
}

function extractEvent(parsed) {
  if (parsed.kind === "json") {
    const body = parsed.value || {};
    const event = body.event || body.EVENT || null;
    const entityId =
      getNested(body, ["data", "FIELDS", "ID"]) ||
      getNested(body, ["data", "ID"]) ||
      body.dealId ||
      body.activityId ||
      null;
    const upperEvent = String(event || "").toUpperCase();
    return {
      event,
      dealId: upperEvent.includes("CRMACTIVITY") ? null : entityId,
      activityId: upperEvent.includes("CRMACTIVITY") ? entityId : null,
      activityProviderId: upperEvent.includes("CRMACTIVITY")
        ? getNested(body, ["data", "FIELDS", "PROVIDER_ID"]) || null
        : null,
      activityDirection: upperEvent.includes("CRMACTIVITY")
        ? getNested(body, ["data", "FIELDS", "DIRECTION"]) || null
        : null,
      activityOwnerTypeId: upperEvent.includes("CRMACTIVITY")
        ? getNested(body, ["data", "FIELDS", "OWNER_TYPE_ID"]) || null
        : null,
      applicationToken:
        getNested(body, ["auth", "application_token"]) ||
        body.application_token ||
        null,
    };
  }

  const p = parsed.value;
  const event = p.get("event") || p.get("EVENT");
  const entityId =
    p.get("data[FIELDS][ID]") ||
    p.get("data[ID]") ||
    p.get("dealId") ||
    p.get("activityId");
  const upperEvent = String(event || "").toUpperCase();
  return {
    event,
    dealId: upperEvent.includes("CRMACTIVITY") ? null : entityId,
    activityId: upperEvent.includes("CRMACTIVITY") ? entityId : null,
    activityProviderId: upperEvent.includes("CRMACTIVITY")
      ? p.get("data[FIELDS][PROVIDER_ID]")
      : null,
    activityDirection: upperEvent.includes("CRMACTIVITY")
      ? p.get("data[FIELDS][DIRECTION]")
      : null,
    activityOwnerTypeId: upperEvent.includes("CRMACTIVITY")
      ? p.get("data[FIELDS][OWNER_TYPE_ID]")
      : null,
    applicationToken:
      p.get("auth[application_token]") ||
      p.get("application_token"),
  };
}

function bitrixBaseUrl() {
  const raw = (process.env.BITRIX_WEBHOOK_BASE || "").trim();
  if (!raw) {
    throw new Error("BITRIX_WEBHOOK_BASE is not configured");
  }
  return raw.endsWith("/") ? raw : raw + "/";
}

async function fetchDeal(dealId) {
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const url = new URL("crm.deal.get.json", bitrixBaseUrl());
    url.searchParams.set("ID", String(dealId));

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      const payload = await response.json().catch(() => ({}));

      if (
        response.ok &&
        !payload.error &&
        payload.result &&
        payload.result.ID
      ) {
        return payload.result;
      }

      lastError = new Error(
        payload.error_description ||
        payload.error ||
        `Bitrix deal read failed with HTTP ${response.status}`
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, attempt * 700));
    }
  }

  throw lastError || new Error("Bitrix deal read returned no deal");
}

async function updateDealField(dealId, fieldName, value) {
  const url = new URL("crm.deal.update.json", bitrixBaseUrl());
  const body = new URLSearchParams();
  body.set("ID", String(dealId));
  body.set(`FIELDS[${fieldName}]`, value);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json();

  if (!response.ok || payload.error || payload.result !== true) {
    throw new Error(
      `Bitrix deal update failed: ${payload.error_description || payload.error || "unknown error"}`
    );
  }
}

async function ensureMultilineDealField(fieldName) {
  const listUrl = new URL("crm.deal.userfield.list.json", bitrixBaseUrl());

  const listResponse = await fetch(listUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filter: { FIELD_NAME: fieldName },
    }),
  });

  const listPayload = await listResponse.json();

  if (!listResponse.ok || listPayload.error) {
    throw new Error(
      `Bitrix user field lookup failed: ${listPayload.error_description || listPayload.error || "unknown error"}`
    );
  }

  const field = Array.isArray(listPayload.result)
    ? listPayload.result.find(item => item.FIELD_NAME === fieldName)
    : null;

  if (!field) {
    throw new Error(`Bitrix user field not found: ${fieldName}`);
  }

  if (field.USER_TYPE_ID !== "string") {
    return;
  }

  const currentRows = Number(field.SETTINGS?.ROWS || 1);
  if (currentRows >= 8) {
    return;
  }

  const updateUrl = new URL("crm.deal.userfield.update.json", bitrixBaseUrl());

  const updateResponse = await fetch(updateUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: Number(field.ID),
      fields: {
        SETTINGS: {
          ROWS: 10,
        },
      },
    }),
  });

  const updatePayload = await updateResponse.json();

  if (!updateResponse.ok || updatePayload.error || updatePayload.result !== true) {
    throw new Error(
      `Bitrix user field update failed: ${updatePayload.error_description || updatePayload.error || "unknown error"}`
    );
  }

  console.log(
    JSON.stringify({
      source: "bitrix24",
      action: "field-multiline-enabled",
      field: fieldName,
      rows: 10,
      at: new Date().toISOString(),
    })
  );
}


const AI_FIELDS = {
  dealType: "UF_CRM_AI_CLIENT_TYPE",
  dealReason: "UF_CRM_AI_CLASS_REASON",
  dealStatus: "UF_CRM_AI_QUAL_STATUS",
  dealAnswers: "UF_CRM_AI_QUAL_ANSWERS",
  dealManufacturer: "UF_CRM_AI_IS_MANUFACTURER",
  dealManufacturedProducts: "UF_CRM_AI_MANUFACTURED_PRODUCTS",
  dealServices: "UF_CRM_AI_SERVICES",
  dealRoles: "UF_CRM_AI_COMPANY_ROLES",
  companyType: "UF_CRM_AI_CLIENT_TYPE",
  companyReason: "UF_CRM_AI_CLASS_REASON",
  companyInn: "UF_CRM_AI_INN",
  companyManufacturer: "UF_CRM_AI_IS_MANUFACTURER",
  companyManufacturedProducts: "UF_CRM_AI_MANUFACTURED_PRODUCTS",
  companyServices: "UF_CRM_AI_SERVICES",
  companyRoles: "UF_CRM_AI_COMPANY_ROLES",
  companyRevenue: "UF_CRM_AI_REVENUE",
  companyRevenueYear: "UF_CRM_AI_REVENUE_YEAR",
  companyRevenuePrevious: "UF_CRM_AI_REVENUE_PREV",
  companyRevenuePreviousYear: "UF_CRM_AI_REVENUE_PREV_YEAR",
  companyRevenueGrowth: "UF_CRM_AI_REVENUE_GROWTH",
  companyNetProfit: "UF_CRM_AI_NET_PROFIT",
  companyFinancialSource: "UF_CRM_AI_FIN_SOURCE",
  companyEmployees: "UF_CRM_AI_EMPLOYEES",
  companyEmployeesYear: "UF_CRM_AI_EMPLOYEES_YEAR",
  companyBranches: "UF_CRM_AI_BRANCHES",
  companyRegions: "UF_CRM_AI_REGIONS",
  companyKeyObjects: "UF_CRM_AI_KEY_OBJECTS",
  companyQuickSaleScore: "UF_CRM_AI_QUICK_SALE_SCORE",
  companyQuickSaleReason: "UF_CRM_AI_QUICK_SALE_REASON",
};

const LEGACY_TYPE_ENUM = {
  "Дилер": 172,
  "Потенциальный дилер": 174,
  "Дистрибьютор": 176,
  "Завод / промышленное предприятие": 178,
  "Промышленный подрядчик": 180,
  "Генподрядчик / EPC": 180,
  "КИПиА / АСУ ТП интегратор": 180,
  "Сервисная компания": 182,
};

const SELF_UPDATES = new Map();

const CONTRACTOR_BASELINE_RESULTS = [
  {
    seed: "Промфинстрой",
    matched_company: "Промфинстрой, АО",
    status: "needs-disambiguation",
    reason: "В CRM нет ИНН и сайта; требуется точная идентификация перед внешним профилированием."
  },
  {
    seed: "Лесавик",
    matched_company: "ООО \"ЛЕСАВИК\"",
    status: "needs-disambiguation",
    reason: "В CRM компания найдена, но нет ИНН и сайта; профиль: производитель строительных лесов."
  },
  {
    seed: "Сибирская сервисная компания (ССК)",
    matched_company: "",
    status: "not-found-in-crm",
    reason: "ССК — это сокращение Сибирской сервисной компании. Идентификация выполняется по полному названию и известным корпоративным доменам."
  },
  {
    seed: "Шлюмберже",
    matched_company: "Шлюмберже Восток, ООО",
    status: "needs-disambiguation",
    reason: "Карточка найдена, но в CRM нет ИНН и сайта для строгой идентификации."
  },
  {
    seed: "БКЕ",
    matched_company: "БКЕ Шельф, ООО",
    status: "needs-disambiguation",
    reason: "Карточка найдена, но в CRM нет ИНН и сайта для строгой идентификации."
  },
  {
    seed: "Бурсервис",
    matched_company: "",
    status: "not-found-in-crm",
    reason: "По этому написанию точного совпадения в CRM не найдено."
  }
];

const DASHBOARD_STATE = {
  serviceStartedAt: new Date().toISOString(),
  lastBitrixEventAt: null,
  lastBitrixEvent: null,
  lastError: null,
  contractorBenchmark: {
    status: "snapshot",
    total: CONTRACTOR_BASELINE_RESULTS.length,
    completed: CONTRACTOR_BASELINE_RESULTS.length,
    current: "",
    startedAt: null,
    finishedAt: "2026-10-07T07:06:27Z",
    results: CONTRACTOR_BASELINE_RESULTS.slice(),
  },
  similarContractors: {
    status: "scanning-bitrix",
    target: 30,
    completed: 0,
  },
  contractorScan: {
    status: "starting",
    mode: "continuous-read-only",
    pass: 1,
    cursor: 0,
    totalDeals: 0,
    scannedDealsPass: 0,
    scannedDealsLifetime: 0,
    candidateCompanies: 0,
    discoveredCandidates: 0,
    verifiedContractors: 0,
    pendingVerification: 0,
    rejectedCandidates: 0,
    unclearCandidates: 0,
    highPotential: 0,
    directPurchaseCompanies: 0,
    tenderOnlyCompanies: 0,
    unlinkedCandidateDeals: 0,
    startedAt: null,
    lastBatchAt: null,
    lastCompletedPassAt: null,
    topCandidates: [],
    recentDiscoveries: [],
  },
};

async function bitrixCall(method, params = {}) {
  const url = new URL(method + ".json", bitrixBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(12000),
  });

  const payload = await response.json();

  if (!response.ok || payload.error) {
    throw new Error(
      `${method} failed: ${payload.error_description || payload.error || "HTTP " + response.status}`
    );
  }

  return payload.result;
}

async function bitrixCallRaw(method, params = {}) {
  const url = new URL(method + ".json", bitrixBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(
      `${method} failed: ${payload.error_description || payload.error || "HTTP " + response.status}`
    );
  }
  return payload;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === "" || String(value) === "0";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function emailDomain(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : "";
}

const PUBLIC_EMAIL_DOMAINS = new Set([
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "yandex.ru",
  "ya.ru",
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "rambler.ru",
]);

function isCorporateDomain(domain) {
  const value = String(domain || "").trim().toLowerCase();
  return Boolean(value) && !PUBLIC_EMAIL_DOMAINS.has(value);
}

function corporateDomainFromContext(context = {}) {
  const candidates = [];

  for (const email of context.linked_contact?.email || []) {
    candidates.push(emailDomain(email));
  }

  for (const activity of context.recent_activities || []) {
    for (const communication of activity.communications || []) {
      if (String(communication.type || "").toUpperCase() === "EMAIL") {
        candidates.push(emailDomain(communication.value));
      }
    }
  }

  return candidates.find(isCorporateDomain) || "";
}

function cleanReason(value) {
  return String(value || "")
    .replace(/\(\[[^\]]+\]\([^)]+\)\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureUserField(entity, code, label, rows = 1) {
  const fullName = "UF_CRM_" + code;
  const listMethod = `crm.${entity}.userfield.list`;
  const addMethod = `crm.${entity}.userfield.add`;

  try {
    const existing = await bitrixCall(listMethod, {
      filter: { FIELD_NAME: fullName },
    });

    const found = Array.isArray(existing)
      ? existing.find(item => item.FIELD_NAME === fullName)
      : null;

    if (found) return fullName;

    await bitrixCall(addMethod, {
      fields: {
        FIELD_NAME: code,
        USER_TYPE_ID: "string",
        MULTIPLE: "N",
        MANDATORY: "N",
        SHOW_FILTER: "Y",
        EDIT_FORM_LABEL: { ru: label },
        LIST_COLUMN_LABEL: { ru: label },
        SETTINGS: { ROWS: rows },
        SORT: 9900,
      },
    });

    console.log(JSON.stringify({
      source: "bitrix24",
      action: "ai-field-created",
      entity,
      field: fullName,
      at: new Date().toISOString(),
    }));

    return fullName;
  } catch (error) {
    console.warn(JSON.stringify({
      source: "bitrix24",
      action: "ai-field-create-skipped",
      entity,
      field: fullName,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

async function ensureAIFields() {
  await ensureUserField("deal", "AI_CLIENT_TYPE", "ИИ: Тип компании", 1);
  await ensureUserField("deal", "AI_CLASS_REASON", "ИИ: Основание классификации", 3);
  await ensureUserField("deal", "AI_QUAL_STATUS", "ИИ: Статус квалификации", 1);
  await ensureUserField("deal", "AI_QUAL_ANSWERS", "ИИ: Ответы квалификации", 8);
  await ensureUserField("deal", "AI_IS_MANUFACTURER", "ИИ: Производитель", 1);
  await ensureUserField("deal", "AI_MANUFACTURED_PRODUCTS", "ИИ: Что производит", 3);
  await ensureUserField("deal", "AI_SERVICES", "ИИ: Какие услуги оказывает", 3);
  await ensureUserField("deal", "AI_COMPANY_ROLES", "ИИ: Роли компании", 3);
  await ensureUserField("company", "AI_CLIENT_TYPE", "ИИ: Тип компании", 1);
  await ensureUserField("company", "AI_CLASS_REASON", "ИИ: Основание классификации", 3);
  await ensureUserField("company", "AI_INN", "ИИ: ИНН", 1);
  await ensureUserField("company", "AI_IS_MANUFACTURER", "ИИ: Производитель", 1);
  await ensureUserField("company", "AI_MANUFACTURED_PRODUCTS", "ИИ: Что производит", 3);
  await ensureUserField("company", "AI_SERVICES", "ИИ: Какие услуги оказывает", 3);
  await ensureUserField("company", "AI_COMPANY_ROLES", "ИИ: Роли компании", 3);
  await ensureUserField("company", "AI_REVENUE", "ИИ: Выручка, руб.", 1);
  await ensureUserField("company", "AI_REVENUE_YEAR", "ИИ: Год выручки", 1);
  await ensureUserField("company", "AI_REVENUE_PREV", "ИИ: Выручка пред. год, руб.", 1);
  await ensureUserField("company", "AI_REVENUE_PREV_YEAR", "ИИ: Предыдущий год", 1);
  await ensureUserField("company", "AI_REVENUE_GROWTH", "ИИ: Динамика выручки, %", 1);
  await ensureUserField("company", "AI_NET_PROFIT", "ИИ: Чистая прибыль, руб.", 1);
  await ensureUserField("company", "AI_FIN_SOURCE", "ИИ: Источник финансов", 2);
  await ensureUserField("company", "AI_EMPLOYEES", "ИИ: Численность сотрудников", 1);
  await ensureUserField("company", "AI_EMPLOYEES_YEAR", "ИИ: Год численности", 1);
  await ensureUserField("company", "AI_BRANCHES", "ИИ: Филиалы и подразделения", 5);
  await ensureUserField("company", "AI_REGIONS", "ИИ: География работы", 4);
  await ensureUserField("company", "AI_KEY_OBJECTS", "ИИ: Ключевые заказчики/объекты", 5);
  await ensureUserField("company", "AI_QUICK_SALE_SCORE", "ИИ: Потенциал быстрой продажи", 1);
  await ensureUserField("company", "AI_QUICK_SALE_REASON", "ИИ: Почему интересна ТОП-СЕНС", 4);
}

async function getCompany(id) {
  if (!id || String(id) === "0") return null;
  return bitrixCall("crm.company.get", { ID: Number(id) });
}

async function getContact(id) {
  if (!id || String(id) === "0") return null;
  return bitrixCall("crm.contact.get", { ID: Number(id) });
}

async function findContactByEmailOrPhone(email, phone) {
  if (email) {
    const result = await bitrixCall("crm.contact.list", {
      order: { ID: "ASC" },
      filter: { EMAIL: email },
      select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "POST", "COMPANY_ID", "EMAIL", "PHONE"],
    });
    if (Array.isArray(result) && result[0]) return result[0];
  }

  if (phone) {
    const result = await bitrixCall("crm.contact.list", {
      order: { ID: "ASC" },
      filter: { PHONE: phone },
      select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "POST", "COMPANY_ID", "EMAIL", "PHONE"],
    });
    if (Array.isArray(result) && result[0]) return result[0];
  }

  return null;
}

async function findCompanyByAnalysis(company) {
  if (!company) return null;

  const inn = String(company.inn || "").trim();
  if (inn) {
    try {
      const byInn = await bitrixCall("crm.company.list", {
        order: { ID: "ASC" },
        filter: { [AI_FIELDS.companyInn]: inn },
        select: ["ID", "TITLE", AI_FIELDS.companyInn, "WEB", "PHONE", "EMAIL"],
      });
      if (Array.isArray(byInn) && byInn[0]) return byInn[0];
    } catch {}
  }

  const title = String(company.name || "").trim();
  if (title) {
    const byTitle = await bitrixCall("crm.company.list", {
      order: { ID: "ASC" },
      filter: { TITLE: title },
      select: ["ID", "TITLE", "WEB", "PHONE", "EMAIL"],
    });
    if (Array.isArray(byTitle) && byTitle[0]) return byTitle[0];
  }

  return null;
}

function multifieldHas(items, value, normalizer) {
  const target = normalizer(value);
  if (!target) return false;
  return Array.isArray(items) && items.some(item => normalizer(item.VALUE) === target);
}

function addMultifieldPatch(patch, existing, key, value, normalizer) {
  if (!value || multifieldHas(existing?.[key], value, normalizer)) return;
  const current = Array.isArray(existing?.[key])
    ? existing[key].map(item => ({ VALUE: item.VALUE, VALUE_TYPE: item.VALUE_TYPE || "WORK" }))
    : [];
  patch[key] = current.concat([{ VALUE: value, VALUE_TYPE: "WORK" }]);
}

async function upsertCompany(deal, analysis) {
  const companyData = analysis.company || {};
  let company = await getCompany(deal.COMPANY_ID);

  if (!company && deal.CONTACT_ID && String(deal.CONTACT_ID) !== "0") {
    try {
      const linkedContact = await getContact(deal.CONTACT_ID);
      if (linkedContact?.COMPANY_ID && String(linkedContact.COMPANY_ID) !== "0") {
        company = await getCompany(linkedContact.COMPANY_ID);
        if (company) {
          console.log(JSON.stringify({
            source: "bitrix24",
            action: "company-reused-from-contact",
            dealId: String(deal.ID),
            companyId: String(company.ID),
            contactId: String(deal.CONTACT_ID),
          }));
        }
      }
    } catch {}
  }

  if (!company) {
    company = await findCompanyByAnalysis(companyData);
  }

  const title = String(companyData.name || "").trim();

  if (!company && !title) return null;

  if (!company) {
    const fields = { TITLE: title };

    if (companyData.address) fields.ADDRESS = companyData.address;
    if (companyData.city) fields.ADDRESS_CITY = companyData.city;
    if (companyData.region) fields.ADDRESS_REGION = companyData.region;
    if (companyData.phone) fields.PHONE = [{ VALUE: companyData.phone, VALUE_TYPE: "WORK" }];
    if (companyData.email) fields.EMAIL = [{ VALUE: companyData.email, VALUE_TYPE: "WORK" }];
    if (companyData.website) fields.WEB = [{ VALUE: companyData.website, VALUE_TYPE: "WORK" }];
    if (companyData.inn) fields[AI_FIELDS.companyInn] = String(companyData.inn);
    fields[AI_FIELDS.companyType] = analysis.client_type || "";
    fields[AI_FIELDS.companyReason] = cleanReason(analysis.classification_reason);
    fields[AI_FIELDS.companyManufacturer] = analysis.company?.is_manufacturer || "Не определено";
    fields[AI_FIELDS.companyManufacturedProducts] = analysis.company?.manufactured_products || "";
    fields[AI_FIELDS.companyServices] = analysis.company?.services || "";
    fields[AI_FIELDS.companyRoles] = Array.isArray(analysis.company?.roles)
      ? analysis.company.roles.join(", ")
      : "";
    if (companyData.revenue) fields[AI_FIELDS.companyRevenue] = String(companyData.revenue);
    if (companyData.revenue_year) fields[AI_FIELDS.companyRevenueYear] = String(companyData.revenue_year);
    if (companyData.revenue_previous) fields[AI_FIELDS.companyRevenuePrevious] = String(companyData.revenue_previous);
    if (companyData.revenue_previous_year) fields[AI_FIELDS.companyRevenuePreviousYear] = String(companyData.revenue_previous_year);
    if (companyData.revenue_growth_percent) fields[AI_FIELDS.companyRevenueGrowth] = String(companyData.revenue_growth_percent);
    if (companyData.net_profit) fields[AI_FIELDS.companyNetProfit] = String(companyData.net_profit);
    if (companyData.financial_source) fields[AI_FIELDS.companyFinancialSource] = String(companyData.financial_source);
    if (companyData.employee_count) fields[AI_FIELDS.companyEmployees] = String(companyData.employee_count);
    if (companyData.employee_count_year) fields[AI_FIELDS.companyEmployeesYear] = String(companyData.employee_count_year);
    if (Array.isArray(companyData.branches) && companyData.branches.length) fields[AI_FIELDS.companyBranches] = companyData.branches.join("\n");
    if (Array.isArray(companyData.operating_regions) && companyData.operating_regions.length) fields[AI_FIELDS.companyRegions] = companyData.operating_regions.join(", ");
    if (Array.isArray(companyData.key_customers_or_objects) && companyData.key_customers_or_objects.length) fields[AI_FIELDS.companyKeyObjects] = companyData.key_customers_or_objects.join("\n");
    if (companyData.quick_sale_score !== null && companyData.quick_sale_score !== undefined) fields[AI_FIELDS.companyQuickSaleScore] = String(companyData.quick_sale_score);
    if (companyData.quick_sale_reason) fields[AI_FIELDS.companyQuickSaleReason] = String(companyData.quick_sale_reason);

    const id = await bitrixCall("crm.company.add", { fields });
    company = await getCompany(id);

    console.log(JSON.stringify({
      source: "bitrix24",
      action: "company-created",
      dealId: String(deal.ID),
      companyId: String(id),
    }));
  } else {
    const patch = {};

    if (isEmpty(company.TITLE) && title) patch.TITLE = title;
    if (isEmpty(company.ADDRESS) && companyData.address) patch.ADDRESS = companyData.address;
    if (isEmpty(company.ADDRESS_CITY) && companyData.city) patch.ADDRESS_CITY = companyData.city;
    if (isEmpty(company.ADDRESS_REGION) && companyData.region) patch.ADDRESS_REGION = companyData.region;
    if (isEmpty(company[AI_FIELDS.companyInn]) && companyData.inn) patch[AI_FIELDS.companyInn] = String(companyData.inn);
    // AI-owned fields can be corrected by later research; human-owned fields above are only filled when empty.
    const existingCompanyType = String(company[AI_FIELDS.companyType] || "").trim();
    const existingCompanyRoles = String(company[AI_FIELDS.companyRoles] || "");
    const confirmedDealer =
      existingCompanyType.toLowerCase() === "дилер" ||
      existingCompanyRoles.toLowerCase().includes("дилер");

    if (
      analysis.client_type &&
      analysis.client_type !== "Не определено" &&
      !confirmedDealer &&
      existingCompanyType !== analysis.client_type
    ) {
      patch[AI_FIELDS.companyType] = analysis.client_type;
    }
    if (analysis.classification_reason) {
      const reason = cleanReason(analysis.classification_reason);
      if (String(company[AI_FIELDS.companyReason] || "") !== reason) {
        patch[AI_FIELDS.companyReason] = reason;
      }
    }
    if (
      analysis.company?.is_manufacturer &&
      analysis.company.is_manufacturer !== "Не определено" &&
      String(company[AI_FIELDS.companyManufacturer] || "") !== analysis.company.is_manufacturer
    ) {
      patch[AI_FIELDS.companyManufacturer] = analysis.company.is_manufacturer;
    }
    if (
      analysis.company?.manufactured_products &&
      String(company[AI_FIELDS.companyManufacturedProducts] || "") !== analysis.company.manufactured_products
    ) {
      patch[AI_FIELDS.companyManufacturedProducts] = analysis.company.manufactured_products;
    }
    if (
      analysis.company?.services &&
      String(company[AI_FIELDS.companyServices] || "") !== analysis.company.services
    ) {
      patch[AI_FIELDS.companyServices] = analysis.company.services;
    }
    if (Array.isArray(analysis.company?.roles) && analysis.company.roles.length) {
      const existingRoles = String(company[AI_FIELDS.companyRoles] || "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);
      const mergedRoles = Array.from(new Set(
        existingRoles.concat(analysis.company.roles.map(x => String(x || "").trim()).filter(Boolean))
      ));
      const rolesText = mergedRoles.join(", ");
      if (String(company[AI_FIELDS.companyRoles] || "") !== rolesText) {
        patch[AI_FIELDS.companyRoles] = rolesText;
      }
    }

    const financialFields = [
      [AI_FIELDS.companyRevenue, companyData.revenue],
      [AI_FIELDS.companyRevenueYear, companyData.revenue_year],
      [AI_FIELDS.companyRevenuePrevious, companyData.revenue_previous],
      [AI_FIELDS.companyRevenuePreviousYear, companyData.revenue_previous_year],
      [AI_FIELDS.companyRevenueGrowth, companyData.revenue_growth_percent],
      [AI_FIELDS.companyNetProfit, companyData.net_profit],
      [AI_FIELDS.companyFinancialSource, companyData.financial_source],
    ];
    for (const [field, value] of financialFields) {
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        const normalized = String(value).trim();
        if (String(company[field] || "").trim() !== normalized) {
          patch[field] = normalized;
        }
      }
    }

    const profileFields = [
      [AI_FIELDS.companyEmployees, companyData.employee_count],
      [AI_FIELDS.companyEmployeesYear, companyData.employee_count_year],
      [AI_FIELDS.companyBranches, Array.isArray(companyData.branches) ? companyData.branches.join("\n") : ""],
      [AI_FIELDS.companyRegions, Array.isArray(companyData.operating_regions) ? companyData.operating_regions.join(", ") : ""],
      [AI_FIELDS.companyKeyObjects, Array.isArray(companyData.key_customers_or_objects) ? companyData.key_customers_or_objects.join("\n") : ""],
      [AI_FIELDS.companyQuickSaleScore, companyData.quick_sale_score],
      [AI_FIELDS.companyQuickSaleReason, companyData.quick_sale_reason],
    ];
    for (const [field, value] of profileFields) {
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        const normalized = String(value).trim();
        if (String(company[field] || "").trim() !== normalized) {
          patch[field] = normalized;
        }
      }
    }

    const sitePhone = String(companyData.phone || "").trim();
    const personPhone = String(analysis.contact?.phone || "").trim();
    const existingPhones = Array.isArray(company.PHONE) ? company.PHONE : [];

    const hasPersonPhone = personPhone && multifieldHas(existingPhones, personPhone, normalizePhone);
    const siteDiffersFromPerson =
      sitePhone &&
      personPhone &&
      normalizePhone(sitePhone) !== normalizePhone(personPhone);

    if (hasPersonPhone && siteDiffersFromPerson) {
      const preserved = existingPhones
        .filter(item => normalizePhone(item.VALUE) !== normalizePhone(personPhone))
        .map(item => ({
          VALUE: item.VALUE,
          VALUE_TYPE: item.VALUE_TYPE || "WORK",
        }));
      preserved.push({ VALUE: sitePhone, VALUE_TYPE: "WORK" });
      patch.PHONE = preserved;
    } else {
      addMultifieldPatch(patch, company, "PHONE", companyData.phone, normalizePhone);
    }
    addMultifieldPatch(patch, company, "EMAIL", companyData.email, normalizeEmail);
    addMultifieldPatch(patch, company, "WEB", companyData.website, value => String(value || "").trim().toLowerCase());

    if (Object.keys(patch).length) {
      await bitrixCall("crm.company.update", { ID: Number(company.ID), fields: patch });
      company = await getCompany(company.ID);
      console.log(JSON.stringify({
        source: "bitrix24",
        action: "company-updated",
        dealId: String(deal.ID),
        companyId: String(company.ID),
        fieldCount: Object.keys(patch).length,
      }));
    }
  }

  return company;
}

async function upsertContact(deal, analysis, company) {
  const contactData = analysis.contact || {};
  let contact = await getContact(deal.CONTACT_ID);

  if (!contact) {
    contact = await findContactByEmailOrPhone(contactData.email, contactData.phone);
  }

  const hasIdentity =
    contactData.email ||
    contactData.phone ||
    contactData.first_name ||
    contactData.last_name ||
    contactData.name;

  if (!contact && !hasIdentity) return null;

  if (!contact) {
    const fields = {};
    if (contactData.first_name) fields.NAME = contactData.first_name;
    else if (contactData.name) fields.NAME = contactData.name;
    if (contactData.last_name) fields.LAST_NAME = contactData.last_name;
    if (contactData.second_name) fields.SECOND_NAME = contactData.second_name;
    if (contactData.position) fields.POST = contactData.position;
    if (company?.ID) fields.COMPANY_ID = Number(company.ID);
    if (contactData.email) fields.EMAIL = [{ VALUE: contactData.email, VALUE_TYPE: "WORK" }];
    if (contactData.phone) fields.PHONE = [{ VALUE: contactData.phone, VALUE_TYPE: "WORK" }];

    const id = await bitrixCall("crm.contact.add", { fields });
    contact = await getContact(id);

    console.log(JSON.stringify({
      source: "bitrix24",
      action: "contact-created",
      dealId: String(deal.ID),
      contactId: String(id),
    }));
  } else {
    const patch = {};

    if (isEmpty(contact.NAME) && (contactData.first_name || contactData.name)) {
      patch.NAME = contactData.first_name || contactData.name;
    }

    const targetFirst = String(contactData.first_name || "").trim();
    const targetLast = String(contactData.last_name || contact.LAST_NAME || "").trim();
    const currentName = String(contact.NAME || "").trim();

    if (targetFirst && targetLast && currentName) {
      const normalizedCurrent = currentName.replace(/\s+/g, " ").toLowerCase();
      const normalizedFull = (targetFirst + " " + targetLast).toLowerCase();
      if (
        normalizedCurrent === normalizedFull ||
        (
          normalizedCurrent.startsWith(targetFirst.toLowerCase() + " ") &&
          normalizedCurrent.endsWith(" " + targetLast.toLowerCase())
        )
      ) {
        patch.NAME = targetFirst;
      }
    }

    if (isEmpty(contact.LAST_NAME) && contactData.last_name) patch.LAST_NAME = contactData.last_name;
    if (isEmpty(contact.SECOND_NAME) && contactData.second_name) patch.SECOND_NAME = contactData.second_name;
    if (isEmpty(contact.POST) && contactData.position) patch.POST = contactData.position;
    if (isEmpty(contact.COMPANY_ID) && company?.ID) patch.COMPANY_ID = Number(company.ID);

    addMultifieldPatch(patch, contact, "EMAIL", contactData.email, normalizeEmail);
    addMultifieldPatch(patch, contact, "PHONE", contactData.phone, normalizePhone);

    if (Object.keys(patch).length) {
      await bitrixCall("crm.contact.update", { ID: Number(contact.ID), fields: patch });
      contact = await getContact(contact.ID);
      console.log(JSON.stringify({
        source: "bitrix24",
        action: "contact-updated",
        dealId: String(deal.ID),
        contactId: String(contact.ID),
        fieldCount: Object.keys(patch).length,
      }));
    }
  }

  return contact;
}

function parseQuestionBlocks(text) {
  const source = String(text || "");
  const re = /(\d+)\.\s*([^\r\n]+)\r?\nОтвет:\s*([\s\S]*?)(?=(?:\r?\n){2,}\d+\.|$)/g;
  const blocks = [];
  let match;

  while ((match = re.exec(source)) !== null) {
    const question = String(match[2] || "").trim();
    const answer = String(match[3] || "").trim();
    if (question) {
      blocks.push({
        number: Number(match[1] || 0),
        question,
        answer,
      });
    }
  }

  return blocks;
}

function isMeaningfulManagerAnswer(value) {
  const answer = String(value || "").trim();
  if (!answer) return false;

  const normalized = answer
    .replace(/\s+/g, " ")
    .toLowerCase();

  return ![
    "-",
    "—",
    "нет ответа",
    "не заполнено",
    "не заполнен",
    "не выяснено",
    "не уточнено",
  ].includes(normalized);
}

function parseQuestionAnswers(text) {
  return parseQuestionBlocks(text)
    .filter(item => isMeaningfulManagerAnswer(item.answer))
    .map(item => ({
      question: item.question,
      answer: item.answer,
    }));
}

function answerHistoryText(existing, newAnswers) {
  const previous = String(existing || "").trim();
  const additions = newAnswers
    .map(item => `${item.question}\r\nОтвет: ${item.answer}`)
    .join("\r\n\r\n");

  if (!additions) return previous;
  if (!previous) return additions;

  const unique = additions
    .split(/\r?\n\r?\n/)
    .filter(block => !previous.includes(block))
    .join("\r\n\r\n");

  return unique ? previous + "\r\n\r\n" + unique : previous;
}

function answerFieldPatch(answers) {
  const patch = {};

  for (const item of answers) {
    const q = item.question.toLowerCase();
    const a = item.answer.trim();
    const al = a.toLowerCase();

    if (q.includes("тендер или прямая закупка")) {
      if (al.includes("тендер")) patch.UF_CRM_1728208250222 = [48];
      else if (al.includes("прям")) patch.UF_CRM_1728208250222 = [50];
    }

    if (q.includes("можно предложить аналог") || q.includes("рассматриваете другие бренды")) {
      if (/^(да|можно|рассматри)/i.test(a)) patch.UF_CRM_1728208192427 = 44;
      else if (/^(нет|нельзя|не рассмат)/i.test(a)) patch.UF_CRM_1728208192427 = 46;
    }

    if (q.includes("какие производители") || q.includes("какие бренды")) {
      patch.UF_CRM_1728208353618 = a;
    }

    if (q.includes("к какому сроку нужна поставка") || q.includes("к какому сроку нужны приборы")) {
      patch.UF_CRM_1728208560055 = a;
    }

    if (q.includes("к какому сроку нужно кп")) {
      patch.UF_CRM_1728208470685 = a;
    }

    if (q.includes("в каких регионах") || q.includes("какие регионы")) {
      patch.UF_CRM_1728209888200 = a;
    }

    if (q.includes("как часто")) {
      patch.UF_CRM_1728208292193 = a;
    }

    if (q.includes("дилерск")) {
      if (/^(да|готов|интерес)/i.test(a)) patch.UF_CRM_1728208444263 = 66;
      else if (/^(нет|не готов|не интерес)/i.test(a)) patch.UF_CRM_1728208444263 = 68;
    }
  }

  return patch;
}

function qualificationStatus(analysis) {
  if (!analysis || analysis.client_type === "Не определено") {
    return "Нужно определить тип компании";
  }

  const count = analysis?._known_dealer
    ? (Array.isArray(analysis.context_questions) ? analysis.context_questions.length : 0)
    : (
        Array.isArray(analysis.context_questions) && analysis.context_questions.length
          ? analysis.context_questions.length
          : (Array.isArray(analysis.question_keys) ? analysis.question_keys.length : 0)
      );
  return count ? `Нужно уточнить: ${count}` : "Квалифицировано";
}

async function writeDealAIFields(deal, analysis, answers = []) {
  const patch = {
    [AI_FIELDS.dealType]: analysis.client_type || "Не определено",
    [AI_FIELDS.dealReason]: cleanReason(analysis.classification_reason),
    [AI_FIELDS.dealStatus]: qualificationStatus(analysis),
    [AI_FIELDS.dealManufacturer]: analysis.company?.is_manufacturer || "Не определено",
    [AI_FIELDS.dealManufacturedProducts]: analysis.company?.manufactured_products || "",
    [AI_FIELDS.dealServices]: analysis.company?.services || "",
    [AI_FIELDS.dealRoles]: Array.isArray(analysis.company?.roles)
      ? analysis.company.roles.join(", ")
      : "",
  };

  const legacy = LEGACY_TYPE_ENUM[analysis.client_type];
  if (legacy && isEmpty(deal.UF_CRM_1739950675115)) {
    patch.UF_CRM_1739950675115 = legacy;
  }

  if (analysis.company?.inn && isEmpty(deal.UF_CRM_1789994254952)) {
    patch.UF_CRM_1789994254952 = String(analysis.company.inn);
  }

  if (analysis.company?.region && isEmpty(deal.UF_CRM_1728209888200)) {
    patch.UF_CRM_1728209888200 = analysis.company.region;
  }

  if (analysis.company?.address && isEmpty(deal.UF_CRM_1728209895847)) {
    patch.UF_CRM_1728209895847 = analysis.company.address;
  }

  Object.assign(patch, answerFieldPatch(answers));

  const history = answerHistoryText(deal[AI_FIELDS.dealAnswers], answers);
  if (history) patch[AI_FIELDS.dealAnswers] = history;

  return patch;
}

async function updateDealFields(dealId, fields) {
  if (!Object.keys(fields || {}).length) return;
  SELF_UPDATES.set(String(dealId), Date.now());
  await bitrixCall("crm.deal.update", { ID: Number(dealId), fields });
}

async function linkDealEntities(deal, company, contact) {
  const patch = {};
  if (company?.ID && isEmpty(deal.COMPANY_ID)) patch.COMPANY_ID = Number(company.ID);
  if (contact?.ID && isEmpty(deal.CONTACT_ID)) patch.CONTACT_ID = Number(contact.ID);
  if (Object.keys(patch).length) await updateDealFields(deal.ID, patch);
}

async function createQualificationActivity(deal, analysis) {
  if (process.env.AUTO_QUAL_ACTIVITY !== "1") return null;
  const count = analysis?._known_dealer
    ? (Array.isArray(analysis.context_questions) ? analysis.context_questions.length : 0)
    : (
        Array.isArray(analysis.context_questions) && analysis.context_questions.length
          ? analysis.context_questions.length
          : (Array.isArray(analysis.question_keys) ? analysis.question_keys.length : 0)
      );
  if (!count) return null;

  const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  try {
    return await bitrixCall("crm.activity.todo.add", {
      ownerTypeId: 2,
      ownerId: Number(deal.ID),
      deadline,
      responsibleId: Number(deal.ASSIGNED_BY_ID || 1),
      title: `Уточнить квалификацию — ${count} вопроса`,
      description: "Получите ответы на вопросы из поля «Вопросы менеджеру и ответы клиента».",
      pingOffsets: [0, 30],
    });
  } catch (error) {
    console.warn(JSON.stringify({
      source: "bitrix24",
      action: "qualification-activity-skipped",
      dealId: String(deal.ID),
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

const QUESTION_RULES = {
  "Завод / промышленное предприятие": [
    { key: "task", kind: "qualify", text: "Для какой задачи нужны приборы?" },
    { key: "spec", kind: "qualify", text: "Какие газ, диапазон и количество нужны?" },
    { key: "new_or_replace", kind: "qualify", text: "Это новая установка или замена существующих приборов?" },
    { key: "brands", kind: "qualify", text: "Какие производители сейчас используются или рассматриваются?" },
    { key: "purchase", kind: "qualify", text: "Тендер или прямая закупка?" },
    { key: "deadline", kind: "qualify", text: "К какому сроку нужны приборы?" },
    { key: "choice", kind: "sell", text: "На что в первую очередь будете смотреть при выборе?" },
    { key: "win", kind: "sell", text: "Что должно быть в нашем предложении, чтобы вы выбрали нас?" },
    { key: "current_problem", kind: "sell", text: "Что не устраивает в текущих приборах или поставщике?" },
    { key: "options", kind: "sell", text: "Подготовить несколько вариантов под разные цены и характеристики?" }
  ],
  "Генподрядчик / EPC": [
    { key: "stage", kind: "qualify", text: "На какой стадии проект: проектирование, комплектация или монтаж?" },
    { key: "choice_right", kind: "qualify", text: "Вы сами выбираете оборудование или работаете по готовой спецификации?" },
    { key: "alternative", kind: "qualify", text: "Можно предложить другой бренд или производитель уже закреплён?" },
    { key: "requirements", kind: "qualify", text: "Какие требования спецификации обязательны?" },
    { key: "quote_deadline", kind: "qualify", text: "К какому сроку нужно КП?" },
    { key: "delivery_deadline", kind: "qualify", text: "К какому сроку нужна поставка?" },
    { key: "approval", kind: "sell", text: "Что нужно, чтобы наше оборудование согласовали на объекте?" },
    { key: "rejection", kind: "sell", text: "Из-за чего обычно отклоняют альтернативного производителя?" },
    { key: "help_approve", kind: "sell", text: "Что мы можем подготовить, чтобы вам было проще согласовать ТОП-СЕНС?" },
    { key: "win", kind: "sell", text: "Что нам нужно сделать, чтобы вы отдали эту поставку нам?" }
  ],
  "Промышленный подрядчик": [
    { key: "use", kind: "qualify", text: "Приборы нужны для ваших работ или передаются на объект?" },
    { key: "choice_right", kind: "qualify", text: "Вы сами выбираете оборудование или работаете по спецификации?" },
    { key: "alternative", kind: "qualify", text: "Можно предложить аналог?" },
    { key: "priority", kind: "qualify", text: "Что важнее: цена, срок поставки или точное соответствие требованиям?" },
    { key: "deadline", kind: "qualify", text: "К какому сроку нужна поставка?" },
    { key: "frequency", kind: "qualify", text: "Такие запросы у вас возникают регулярно?" },
    { key: "supplier_choice", kind: "sell", text: "Что для вас будет главным при выборе поставщика?" },
    { key: "win", kind: "sell", text: "Что нужно сделать, чтобы эту закупку вы сделали у нас?" },
    { key: "speed", kind: "sell", text: "Если дадим быстрее конкурентов, это повлияет на решение?" },
    { key: "options", kind: "sell", text: "Упростит выбор, если подготовим 2–3 подходящих варианта?" }
  ],
  "КИПиА / АСУ ТП интегратор": [
    { key: "system", kind: "qualify", text: "Для какой системы или задачи подбираете оборудование?" },
    { key: "choice_right", kind: "qualify", text: "Вы сами определяете производителя?" },
    { key: "alternative", kind: "qualify", text: "Можно предложить аналог заложенного оборудования?" },
    { key: "interfaces", kind: "qualify", text: "Какие выходы, интерфейсы и исполнение нужны?" },
    { key: "brands", kind: "qualify", text: "Какие бренды обычно используете?" },
    { key: "frequency", kind: "qualify", text: "Такие проекты возникают регулярно?" },
    { key: "embed", kind: "sell", text: "Что нужно, чтобы вы начали закладывать ТОП-СЕНС в проекты?" },
    { key: "support", kind: "sell", text: "Какая техническая поддержка от производителя для вас наиболее полезна?" },
    { key: "analogs_service", kind: "sell", text: "Есть смысл нам быстро подбирать аналоги по вашим спецификациям?" },
    { key: "priority", kind: "sell", text: "Что для вас важнее: цена, инженерная поддержка, срок или наличие?" }
  ],
  "Сервисная компания": [
    { key: "for_whom", kind: "qualify", text: "Приборы нужны для вашей работы или для клиента?" },
    { key: "task", kind: "qualify", text: "Для какой задачи используются приборы?" },
    { key: "brands", kind: "qualify", text: "Какие марки газоанализаторов обычно используете или обслуживаете?" },
    { key: "other_brands", kind: "qualify", text: "Рассматриваете другие бренды?" },
    { key: "frequency", kind: "qualify", text: "Как часто возникают такие запросы?" },
    { key: "partnership", kind: "qualify", text: "Интересны постоянные условия работы с ТОП-СЕНС?" },
    { key: "recommend", kind: "sell", text: "Что нужно, чтобы вы чаще рекомендовали наши приборы клиентам?" },
    { key: "conditions", kind: "sell", text: "Какие условия сделали бы регулярную работу с нами удобной?" },
    { key: "priority", kind: "sell", text: "Что важнее: цена, наличие, срок ремонта/поставки или техподдержка?" }
  ],
  "Дилер": [
    { key: "regions", kind: "qualify", text: "В каких регионах работаете?" },
    { key: "industries", kind: "qualify", text: "В каких отраслях основные клиенты?" },
    { key: "brands", kind: "qualify", text: "Какие бренды газоанализаторов сейчас продаёте?" },
    { key: "frequency", kind: "qualify", text: "Как часто приходят запросы?" },
    { key: "stock", kind: "qualify", text: "Работаете со склада или в основном под заказ?" },
    { key: "volume", kind: "qualify", text: "Какой примерно объём таких запросов?" },
    { key: "active_sales", kind: "sell", text: "Что нужно, чтобы вы начали активно предлагать ТОП-СЕНС?" },
    { key: "margin", kind: "sell", text: "Какая маржа для вас интересна?" },
    { key: "manufacturer_value", kind: "sell", text: "Что важнее от производителя: цена, наличие, защита сделки, техподдержка или лиды?" },
    { key: "dealer_terms", kind: "sell", text: "Готовы обсудить дилерские условия?" }
  ],
  "Потенциальный дилер": [
    { key: "customers", kind: "qualify", text: "Каким клиентам обычно продаёте оборудование?" },
    { key: "regions", kind: "qualify", text: "В каких регионах работаете?" },
    { key: "demand", kind: "qualify", text: "Есть ли сейчас запросы на газоанализаторы?" },
    { key: "brands", kind: "qualify", text: "Какие бренды уже предлагаете?" },
    { key: "frequency", kind: "qualify", text: "Как часто возникает такой спрос?" },
    { key: "owner", kind: "qualify", text: "Есть ли человек, который занимается этим направлением?" },
    { key: "conditions", kind: "sell", text: "Что должно быть в наших условиях, чтобы вы попробовали работать с ТОП-СЕНС?" },
    { key: "barrier", kind: "sell", text: "Что мешает добавить ещё одного производителя в ассортимент?" },
    { key: "first_order", kind: "sell", text: "С какого заказа удобнее всего начать сотрудничество?" },
    { key: "dealer_terms", kind: "sell", text: "Интересно обсудить дилерские условия?" }
  ],
  "Дистрибьютор": [
    { key: "regions", kind: "qualify", text: "Какие регионы покрываете?" },
    { key: "network", kind: "qualify", text: "Есть филиалы или дилерская сеть?" },
    { key: "brands", kind: "qualify", text: "Какие бренды газоаналитического оборудования уже есть в портфеле?" },
    { key: "volume", kind: "qualify", text: "Какой примерно объём запросов на газоанализаторы?" },
    { key: "stock", kind: "qualify", text: "Работаете со склада или под заказ?" },
    { key: "industries", kind: "qualify", text: "Какие отрасли дают основной объём?" },
    { key: "portfolio", kind: "sell", text: "Что нужно, чтобы ТОП-СЕНС появился в вашей постоянной линейке?" },
    { key: "metrics", kind: "sell", text: "Какие показатели вы оцениваете перед вводом нового бренда?" },
    { key: "margin", kind: "sell", text: "Какая маржинальность вам нужна?" },
    { key: "launch", kind: "sell", text: "Что мы должны предоставить для запуска продаж через вашу сеть?" }
  ],
  "Торговая компания / комплектатор": [
    { key: "repeat", kind: "qualify", text: "Это разовая заявка или регулярное направление?" },
    { key: "alternative", kind: "qualify", text: "Требуется конкретный производитель или можно предложить аналог?" },
    { key: "purchase", kind: "qualify", text: "Тендер или прямая закупка?" },
    { key: "price", kind: "qualify", text: "Есть ориентир по цене или предложения конкурентов?" },
    { key: "quote_deadline", kind: "qualify", text: "К какому сроку нужно КП?" },
    { key: "delivery_deadline", kind: "qualify", text: "К какому сроку нужна поставка?" },
    { key: "win_client", kind: "sell", text: "Что поможет вам получить эту поставку?" },
    { key: "competition", kind: "sell", text: "На чём вы собираетесь конкурировать: цена, срок или характеристики?" },
    { key: "help_sell", kind: "sell", text: "Что нам нужно дать вам, чтобы наше предложение было проще продать дальше?" },
    { key: "options", kind: "sell", text: "Подготовить несколько вариантов под разные бюджеты?" }
  ],
  "Проектная организация / проектный институт": [
    { key: "stage", kind: "qualify", text: "На какой стадии находится проект?" },
    { key: "brand_status", kind: "qualify", text: "Производитель уже заложен или его ещё можно выбрать?" },
    { key: "requirements", kind: "qualify", text: "Какие параметры оборудования обязательны?" },
    { key: "spec_deadline", kind: "qualify", text: "Когда должна быть утверждена спецификация?" },
    { key: "buyer", kind: "qualify", text: "Кто будет проводить закупку?" },
    { key: "docs", kind: "qualify", text: "Какие документы нужны для включения оборудования в проект?" },
    { key: "embed", kind: "sell", text: "Что нужно, чтобы вы заложили ТОП-СЕНС в спецификацию?" },
    { key: "materials", kind: "sell", text: "Какие материалы помогут вам согласовать наше оборудование?" },
    { key: "solution", kind: "sell", text: "Есть смысл подготовить готовое техническое решение?" }
  ],
  "Лаборатория / метрология": [
    { key: "task", kind: "qualify", text: "Для какой задачи нужны приборы?" },
    { key: "spec", kind: "qualify", text: "Какие газы и диапазоны нужны?" },
    { key: "accuracy", kind: "qualify", text: "Какие требования к точности и поверке?" },
    { key: "portable", kind: "qualify", text: "Нужны переносные или стационарные приборы?" },
    { key: "quantity", kind: "qualify", text: "Какое количество требуется?" },
    { key: "repeat", kind: "qualify", text: "Это разовая или регулярная потребность?" },
    { key: "choice", kind: "sell", text: "На что будете в первую очередь смотреть при выборе?" },
    { key: "current_problem", kind: "sell", text: "Что не устраивает в текущем оборудовании?" },
    { key: "win", kind: "sell", text: "Что должно быть у нашего прибора, чтобы вы выбрали его?" },
    { key: "options", kind: "sell", text: "Подготовить несколько вариантов под разные бюджеты?" }
  ],
  "Производитель газоаналитического оборудования / конкурент": [
    { key: "purpose", kind: "qualify", text: "Для какой задачи вам нужны наши приборы или компоненты?" },
    { key: "own_or_resale", kind: "qualify", text: "Это закупка для собственного производства, внутреннего использования или перепродажи?" },
    { key: "product_interest", kind: "qualify", text: "Какие именно позиции ТОП-СЕНС вам интересны?" },
    { key: "volume", kind: "qualify", text: "Какой объём и регулярность закупок планируются?" },
    { key: "cooperation", kind: "sell", text: "Есть ли направления, где вам интереснее закупать готовое решение, чем производить самостоятельно?" },
    { key: "terms", kind: "sell", text: "Какие условия сделали бы сотрудничество с ТОП-СЕНС интересным?" }
  ],
  "Промышленная безопасность / аварийная служба": [
    { key: "works", kind: "qualify", text: "Для каких работ нужны приборы?" },
    { key: "gases", kind: "qualify", text: "Какие газы необходимо контролировать?" },
    { key: "portable", kind: "qualify", text: "Нужны переносные или стационарные приборы?" },
    { key: "explosion", kind: "qualify", text: "Какие требования к исполнению и взрывозащите?" },
    { key: "quantity", kind: "qualify", text: "Какое количество нужно?" },
    { key: "frequency", kind: "qualify", text: "Такие закупки происходят регулярно?" },
    { key: "priority", kind: "sell", text: "Что для вас критичнее всего: надёжность, срок поставки, удобство или цена?" },
    { key: "current_problem", kind: "sell", text: "Какие проблемы есть у текущих приборов?" },
    { key: "improve", kind: "sell", text: "Что должно быть лучше у нового оборудования?" },
    { key: "test", kind: "sell", text: "Есть смысл дать прибор на сравнение или тест?" }
  ]
};

function questionText(clientType, key) {
  const questions = QUESTION_RULES[clientType] || [];
  const item = questions.find(q => q.key === key);
  return item ? item.text : null;
}

function formatManagerQuestions(analysis) {
  const blocks = [];

  blocks.push("Тип: " + (analysis.client_type || "Не определено"));

  const manufacturer = analysis.company?.is_manufacturer || "Не определено";
  blocks.push("Производитель: " + manufacturer);

  if (analysis.company?.manufactured_products) {
    blocks.push("Что производит: " + analysis.company.manufactured_products);
  }

  if (analysis.company?.services) {
    blocks.push("Услуги: " + analysis.company.services);
  }

  if (Array.isArray(analysis.company?.roles) && analysis.company.roles.length) {
    blocks.push("Роли: " + analysis.company.roles.join(", "));
  }

  if (analysis.classification_reason) {
    blocks.push("Почему: " + cleanReason(analysis.classification_reason));
  }

  const contextQuestions = Array.isArray(analysis.context_questions)
    ? analysis.context_questions
        .map(value => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const keys = Array.isArray(analysis.question_keys)
    ? analysis.question_keys.slice(0, 6)
    : [];

  const fallbackQuestions = keys
    .map(key => questionText(analysis.client_type, key))
    .filter(Boolean);

  const questions = contextQuestions.length
    ? contextQuestions
    : (analysis._known_dealer ? [] : fallbackQuestions);

  questions.forEach((q, i) => {
    blocks.push(`${i + 1}. ${q}\r\nОтвет:`);
  });

  return blocks.join("\r\n\r\n");
}

function extractWebSources(payload) {
  const seen = new Set();
  const sources = [];

  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      for (const annotation of part.annotations || []) {
        const url =
          annotation.url ||
          annotation.url_citation?.url ||
          null;
        const title =
          annotation.title ||
          annotation.url_citation?.title ||
          null;

        if (url && !seen.has(url)) {
          seen.add(url);
          sources.push({ title, url });
        }
      }
    }
  }

  return sources.slice(0, 5);
}

function extractResponseText(payload) {
  const chunks = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonText(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  return JSON.parse(cleaned);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function getRecentDealActivities(dealId) {
  try {
    const activities = await bitrixCall("crm.activity.list", {
      order: { ID: "DESC" },
      filter: {
        OWNER_TYPE_ID: 2,
        OWNER_ID: Number(dealId),
      },
      select: [
        "ID",
        "TYPE_ID",
        "DIRECTION",
        "PROVIDER_ID",
        "SUBJECT",
        "DESCRIPTION",
        "DESCRIPTION_TYPE",
        "COMMUNICATIONS",
        "FILES",
        "STORAGE_ELEMENT_IDS",
        "CREATED",
      ],
    });

    if (!Array.isArray(activities)) return [];

    const fileObjects = activities.flatMap(item =>
      Array.isArray(item.FILES) ? item.FILES : []
    );
    const storageIds = activities.flatMap(item =>
      Array.isArray(item.STORAGE_ELEMENT_IDS) ? item.STORAGE_ELEMENT_IDS : []
    );

    console.log(JSON.stringify({
      source: "bitrix24",
      action: "activities-read-ok",
      dealId: String(dealId),
      count: activities.length,
      attachmentCount: activities.reduce((sum, item) => {
        const files = Array.isArray(item.FILES) ? item.FILES.length : 0;
        const storage = Array.isArray(item.STORAGE_ELEMENT_IDS) ? item.STORAGE_ELEMENT_IDS.length : 0;
        return sum + Math.max(files, storage);
      }, 0),
      attachmentFileNames: fileObjects
        .map(file => file.NAME || file.name || "")
        .filter(Boolean)
        .slice(0, 10),
      attachmentFileKeys: fileObjects[0] ? Object.keys(fileObjects[0]).sort() : [],
      storageElementIds: storageIds.map(String).slice(0, 10),
    }));

    return activities.slice(0, 8).map(item => ({
      id: item.ID,
      type_id: item.TYPE_ID,
      direction: item.DIRECTION,
      provider_id: item.PROVIDER_ID,
      subject: String(item.SUBJECT || "").slice(0, 500),
      description: stripHtml(item.DESCRIPTION).slice(0, 12000),
      communications: Array.isArray(item.COMMUNICATIONS)
        ? item.COMMUNICATIONS.slice(0, 10).map(c => ({
            type: c.TYPE || "",
            value: c.VALUE || "",
            entity_type_id: c.ENTITY_TYPE_ID || null,
            entity_id: c.ENTITY_ID || null,
          }))
        : [],
      files: Array.isArray(item.FILES)
        ? item.FILES.slice(0, 10).map(f => ({
            id: f.ID || f.id || null,
            name: f.NAME || f.name || "",
            bytes: Number(f.BYTES || f.bytes || 0),
            can_read: f.CAN_READ ?? f.can_read ?? null,
            url: f.URL || f.url || "",
          }))
        : [],
      storage_element_ids: Array.isArray(item.STORAGE_ELEMENT_IDS)
        ? item.STORAGE_ELEMENT_IDS.map(String)
        : [],
      created: item.CREATED || null,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      source: "bitrix24",
      action: "activity-read-skipped",
      dealId: String(dealId),
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}



async function getDealActivitiesForRelationship(dealId) {
  try {
    const activities = await bitrixCall("crm.activity.list", {
      order: { ID: "DESC" },
      filter: {
        OWNER_TYPE_ID: 2,
        OWNER_ID: Number(dealId),
      },
      select: [
        "ID","TYPE_ID","DIRECTION","PROVIDER_ID","SUBJECT","DESCRIPTION",
        "CREATED","DEADLINE","COMPLETED","RESPONSIBLE_ID","FILES","COMMUNICATIONS"
      ],
    });

    if (!Array.isArray(activities)) return [];

    return activities.slice(0, 30).map(item => ({
      id: item.ID,
      type_id: item.TYPE_ID,
      direction: item.DIRECTION,
      provider_id: item.PROVIDER_ID,
      subject: String(item.SUBJECT || "").slice(0, 700),
      description: stripHtml(item.DESCRIPTION).slice(0, 12000),
      created: item.CREATED || null,
      deadline: item.DEADLINE || null,
      completed: String(item.COMPLETED || "").toUpperCase() === "Y",
      responsible_id: item.RESPONSIBLE_ID || null,
      communications: Array.isArray(item.COMMUNICATIONS)
        ? item.COMMUNICATIONS.slice(0, 10).map(c => ({
            type: c.TYPE || "",
            value: c.VALUE || "",
            entity_type_id: c.ENTITY_TYPE_ID || null,
            entity_id: c.ENTITY_ID || null,
          }))
        : [],
      files: Array.isArray(item.FILES)
        ? item.FILES.slice(0, 10).map(f => ({
            id: f.ID || f.id || null,
            name: f.NAME || f.name || "",
          }))
        : [],
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      source: "contractor-dashboard",
      action: "relationship-activities-read-failed",
      dealId: String(dealId),
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}

function isPrivateAddress(address) {
  const ip = String(address || "").toLowerCase();
  const version = net.isIP(ip);
  if (!version) return true;

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith("ff")) return true;
  if (ip.startsWith("::ffff:")) {
    return isPrivateAddress(ip.slice(7));
  }
  return false;
}

async function resolvePublicAddress(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    net.isIP(host)
  ) {
    throw new Error("unsafe website host");
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  const publicRecord = records.find(item => !isPrivateAddress(item.address));
  if (!publicRecord) throw new Error("website host has no public address");
  return publicRecord;
}

async function fetchPinnedUrl(url, redirectsLeft = 3) {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("unsupported website protocol");
  }

  const resolved = await resolvePublicAddress(parsed.hostname);
  const transport = parsed.protocol === "https:" ? https : http;
  const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);

  const response = await new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: resolved.address,
      port,
      family: resolved.family,
      servername: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Host: parsed.host,
        "User-Agent": "TOP-SENSE CRM enrichment/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
      },
      timeout: 8000,
      rejectUnauthorized: true,
    }, res => {
      const chunks = [];
      let size = 0;

      res.on("data", chunk => {
        size += chunk.length;
        if (size <= 512 * 1024) chunks.push(chunk);
      });

      res.on("end", () => {
        resolve({
          status: Number(res.statusCode || 0),
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("timeout", () => req.destroy(new Error("website request timeout")));
    req.on("error", reject);
    req.end();
  });

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.location &&
    redirectsLeft > 0
  ) {
    const next = new URL(response.headers.location, parsed);
    return fetchPinnedUrl(next.toString(), redirectsLeft - 1);
  }

  if (response.status < 200 || response.status >= 400) {
    throw new Error("website HTTP " + response.status);
  }

  return {
    url: parsed.toString(),
    contentType: String(response.headers["content-type"] || ""),
    body: response.body,
  };
}

function uniqueNonEmpty(values) {
  return [...new Set((values || []).map(v => String(v || "").trim()).filter(Boolean))];
}

function extractWebsiteContactDetails(text, domain) {
  const source = String(text || "");
  const phoneMatches = source.match(/(?:\+7|8)[\s\-().]*\d{3}[\s\-().]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g) || [];
  const phones = uniqueNonEmpty(
    phoneMatches.filter(value => {
      const digits = normalizePhone(value);
      return digits.length === 11;
    })
  );

  const emailMatches = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const emails = uniqueNonEmpty(
    emailMatches.filter(value => {
      const d = emailDomain(value);
      return !domain || d === String(domain).toLowerCase();
    })
  );

  return { phones, emails };
}

function preferredCompanyEmail(emails) {
  const list = Array.isArray(emails) ? emails : [];
  return (
    list.find(v => /^(info|office|sales|mail|hello|zakaz|order)@/i.test(v)) ||
    list[0] ||
    ""
  );
}

function websiteTextFromHtml(html) {
  const source = String(html || "");
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();

  const meta = (
    source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i)?.[1] ||
    source.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i)?.[1] ||
    ""
  ).replace(/\s+/g, " ").trim();

  const body = stripHtml(
    source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
  ).slice(0, 18000);

  return { title, meta, body };
}

async function fetchDomainWebsite(domain) {
  const host = String(domain || "").trim().toLowerCase();
  if (!isCorporateDomain(host)) return null;

  const attempts = [
    "https://" + host + "/",
    "https://www." + host + "/",
    "http://" + host + "/",
  ];

  for (const url of attempts) {
    try {
      const page = await fetchPinnedUrl(url);
      const text = websiteTextFromHtml(page.body);
      if (!text.body && !text.title && !text.meta) continue;

      console.log(JSON.stringify({
        source: "website",
        action: "domain-site-read-ok",
        domain: host,
        url: page.url,
        textLength: text.body.length,
      }));

      const contacts = extractWebsiteContactDetails(text.body, host);

      console.log(JSON.stringify({
        source: "website",
        action: "domain-site-contacts",
        domain: host,
        phoneCount: contacts.phones.length,
        emailCount: contacts.emails.length,
        phones: contacts.phones,
        emails: contacts.emails,
      }));

      return {
        domain: host,
        url: page.url,
        title: text.title,
        description: text.meta,
        text: text.body,
        phones: contacts.phones,
        emails: contacts.emails,
      };
    } catch (error) {
      console.warn(JSON.stringify({
        source: "website",
        action: "domain-site-read-attempt-failed",
        domain: host,
        url,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return null;
}


function contentDispositionFileName(header) {
  const value = String(header || "");
  const utf = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) {
    try { return decodeURIComponent(utf[1].replace(/["']/g, "")); } catch {}
  }
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain?.[1] || "";
}

async function downloadBitrixAttachment(file) {
  const attachmentId = String(file?.id || "").trim();
  const portal = new URL(bitrixBaseUrl());

  // With disk permission, resolve the CRM attachment to a proper authenticated download URL.
  if (attachmentId) {
    try {
      const diskFile = await bitrixCall("disk.file.get", { id: Number(attachmentId) });
      if (diskFile) {
        const downloadUrl = String(
          diskFile.DOWNLOAD_URL ||
          diskFile.downloadUrl ||
          diskFile.download_url ||
          ""
        ).trim();

        console.log(JSON.stringify({
          source: "bitrix24",
          action: "disk-file-resolved",
          attachmentId,
          fileName: diskFile.NAME || diskFile.name || "",
          size: Number(diskFile.SIZE || diskFile.size || 0),
          hasDownloadUrl: Boolean(downloadUrl),
        }));

        if (downloadUrl) {
          const target = new URL(downloadUrl, portal.origin);
          if (target.hostname !== portal.hostname) {
            throw new Error("disk download URL host mismatch");
          }

          const response = await fetch(target, {
            method: "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(60000),
          });

          if (!response.ok) {
            throw new Error("disk attachment download HTTP " + response.status);
          }

          const type = String(response.headers.get("content-type") || "");
          const disposition = String(response.headers.get("content-disposition") || "");
          const declaredLength = Number(response.headers.get("content-length") || 0);

          if (declaredLength > 15 * 1024 * 1024) {
            throw new Error("attachment too large");
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 15 * 1024 * 1024) {
            throw new Error("attachment too large");
          }

          const fileName =
            diskFile.NAME ||
            diskFile.name ||
            contentDispositionFileName(disposition) ||
            "attachment";

          console.log(JSON.stringify({
            source: "bitrix24",
            action: "attachment-download-ok",
            attachmentId,
            fileName,
            contentType: type,
            bytes: buffer.length,
            via: "disk.file.get",
          }));

          return { id: attachmentId, fileName, contentType: type, buffer };
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({
        source: "bitrix24",
        action: "disk-file-resolve-failed",
        attachmentId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // Fallback for CRM URLs (usually returns an auth page, but kept for diagnostics).
  const rawUrl = String(file?.url || "").trim();
  if (!rawUrl) return null;

  const target = new URL(rawUrl, portal.origin);
  if (target.hostname !== portal.hostname) {
    throw new Error("attachment URL host mismatch");
  }

  const response = await fetch(target, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error("attachment download HTTP " + response.status);
  }

  const type = String(response.headers.get("content-type") || "");
  const disposition = String(response.headers.get("content-disposition") || "");
  const buffer = Buffer.from(await response.arrayBuffer());

  const fileName =
    contentDispositionFileName(disposition) ||
    file.name ||
    target.pathname.split("/").pop() ||
    "attachment";

  console.log(JSON.stringify({
    source: "bitrix24",
    action: "attachment-download-ok",
    attachmentId,
    fileName,
    contentType: type,
    bytes: buffer.length,
    via: "crm-url-fallback",
  }));

  return { id: attachmentId || null, fileName, contentType: type, buffer };
}

async function downloadRecentAttachments(activities) {
  const files = (activities || [])
    .flatMap(item => Array.isArray(item.files) ? item.files : [])
    .filter(file => file.url);

  const result = [];
  for (const file of files.slice(0, 3)) {
    try {
      const downloaded = await downloadBitrixAttachment(file);
      if (downloaded) result.push(downloaded);
    } catch (error) {
      console.warn(JSON.stringify({
        source: "bitrix24",
        action: "attachment-download-failed",
        attachmentId: String(file.id || ""),
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return result;
}


async function extractAttachmentDocument(downloaded) {
  if (!downloaded) return null;

  const fileName = String(downloaded.fileName || "");
  const contentType = String(downloaded.contentType || "").toLowerCase();
  const isPdf =
    contentType.includes("application/pdf") ||
    fileName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    try {
      const parsed = await pdfParse(downloaded.buffer);
      const text = String(parsed?.text || "").replace(/\u0000/g, "").trim();

      console.log(JSON.stringify({
        source: "attachment",
        action: "pdf-text-extracted",
        attachmentId: String(downloaded.id || ""),
        fileName,
        textLength: text.length,
        pages: Number(parsed?.numpages || 0),
      }));

      return {
        id: downloaded.id || null,
        file_name: fileName,
        content_type: contentType,
        text: text.slice(0, 30000),
      };
    } catch (error) {
      console.warn(JSON.stringify({
        source: "attachment",
        action: "pdf-text-extract-failed",
        attachmentId: String(downloaded.id || ""),
        fileName,
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
  }

  if (
    contentType.startsWith("text/") ||
    /\.(txt|csv)$/i.test(fileName)
  ) {
    const text = downloaded.buffer.toString("utf8").trim();
    return {
      id: downloaded.id || null,
      file_name: fileName,
      content_type: contentType,
      text: text.slice(0, 30000),
    };
  }

  return null;
}

async function extractAttachmentDocuments(attachments) {
  const documents = [];
  for (const item of attachments || []) {
    const doc = await extractAttachmentDocument(item);
    if (doc?.text) documents.push(doc);
  }
  return documents;
}


function isInboundEmailActivity(activity) {
  const direction = String(activity?.direction || "");
  const provider = String(activity?.provider_id || "").toUpperCase();
  const typeId = String(activity?.type_id || "");

  return direction === "1" && (provider.includes("EMAIL") || typeId === "4");
}

function normalizeInboundEmailBody(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

async function syncInboundEmailsToDeal(deal) {
  const activities = await getRecentDealActivities(deal.ID);
  const inbound = activities.filter(isInboundEmailActivity);
  if (!inbound.length) return false;

  const latest = inbound[0];
  const patch = {};

  const latestSubject = String(latest.subject || "").trim();
  const currentTitle = String(deal.TITLE || "").trim();

  // In the test contour, reflect the newest inbound request in the deal title.
  if (
    latestSubject &&
    latestSubject !== currentTitle &&
    (
      currentTitle.toUpperCase().startsWith("AI WEBHOOK TEST") ||
      latestSubject.toUpperCase().startsWith("AI WEBHOOK TEST")
    )
  ) {
    patch.TITLE = latestSubject;
  }

  let comments = String(deal.COMMENTS || "").trim();

  // Persist each inbound email once in COMMENTS so a new requirement is visible
  // in the deal card and available to managers without opening the activity.
  for (const activity of inbound.slice().reverse()) {
    const marker = `[AI-INBOUND:${activity.id}]`;
    if (comments.includes(marker)) continue;

    const subject = String(activity.subject || "").trim();
    const body = normalizeInboundEmailBody(activity.description);
    if (!subject && !body) continue;

    const block = [
      marker,
      activity.created ? "Дата: " + activity.created : "",
      subject ? "Тема: " + subject : "",
      body ? "Письмо: " + body : "",
    ].filter(Boolean).join("\r\n");

    comments = comments ? comments + "\r\n\r\n" + block : block;
  }

  if (comments !== String(deal.COMMENTS || "").trim()) {
    patch.COMMENTS = comments;
  }

  if (!Object.keys(patch).length) return false;

  await updateDealFields(deal.ID, patch);

  console.log(JSON.stringify({
    source: "bitrix24",
    action: "inbound-email-synced-to-deal",
    dealId: String(deal.ID),
    latestActivityId: String(latest.id || ""),
    latestSubject: latestSubject || null,
    inboundCount: inbound.length,
    titleUpdated: Boolean(patch.TITLE),
    commentsUpdated: Boolean(patch.COMMENTS),
  }));

  return true;
}

async function getPreviousDealContext(deal) {
  const filters = [];
  if (deal.CONTACT_ID && String(deal.CONTACT_ID) !== "0") {
    filters.push({ CONTACT_ID: Number(deal.CONTACT_ID) });
  }
  if (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0") {
    filters.push({ COMPANY_ID: Number(deal.COMPANY_ID) });
  }

  const seen = new Set();
  const previous = [];

  for (const filter of filters) {
    try {
      const deals = await bitrixCall("crm.deal.list", {
        order: { DATE_CREATE: "DESC" },
        filter,
        select: [
          "ID",
          "TITLE",
          "COMMENTS",
          "DATE_CREATE",
          "UF_CRM_1790850696723",
          AI_FIELDS.dealAnswers,
          AI_FIELDS.dealType,
          "UF_CRM_1739950675115",
        ],
        start: 0,
      });

      for (const item of Array.isArray(deals) ? deals : []) {
        const id = String(item.ID || "");
        if (!id || id === String(deal.ID) || seen.has(id)) continue;
        seen.add(id);
        previous.push({
          title: item.TITLE || "",
          comments: String(item.COMMENTS || "").slice(0, 5000),
          questions_and_answers: String(item.UF_CRM_1790850696723 || "").slice(0, 8000),
          answer_history: String(item[AI_FIELDS.dealAnswers] || "").slice(0, 8000),
          client_type: item[AI_FIELDS.dealType] || "",
          legacy_client_type: item.UF_CRM_1739950675115 || "",
          created: item.DATE_CREATE || null,
        });
        if (previous.length >= 6) break;
      }
    } catch {}

    if (previous.length >= 6) break;
  }

  return previous.slice(0, 6);
}

function isConfirmedDealerProfile(company, previousDeals = []) {
  const companyType = String(company?.[AI_FIELDS.companyType] || "").trim().toLowerCase();
  const roles = String(company?.[AI_FIELDS.companyRoles] || "").toLowerCase();

  if (companyType === "дилер" || /(^|,|\s)дилер($|,|\s)/i.test(roles)) {
    return true;
  }

  return (previousDeals || []).some(item => {
    const aiType = String(item.client_type || "").trim().toLowerCase();
    const legacy = String(item.legacy_client_type || "").trim();
    return aiType === "дилер" || legacy === "172";
  });
}

function dealerEvidence(company, previousDeals = []) {
  if (String(company?.[AI_FIELDS.companyType] || "").trim().toLowerCase() === "дилер") {
    return "Карточка компании: ИИ тип = Дилер";
  }

  if (String(company?.[AI_FIELDS.companyRoles] || "").toLowerCase().includes("дилер")) {
    return "Карточка компании: роль Дилер";
  }

  if ((previousDeals || []).some(item =>
    String(item.client_type || "").trim().toLowerCase() === "дилер" ||
    String(item.legacy_client_type || "").trim() === "172"
  )) {
    return "История сделок: подтвержден тип Дилер";
  }

  return "";
}

function filterDealerContextQuestions(questions) {
  const banned = [
    /какие\s+регионы/i,
    /в каких\s+регионах/i,
    /регион(ы|ах)?\s+(работ|продаж)/i,
    /как\s+часто/i,
    /частот[аы]\s+закуп/i,
    /об[ъь]ем\s+закуп/i,
    /дилерск(ое|ий|ого|ому)/i,
    /соглашени[ея]\s+о\s+дилер/i,
    /на\s+склад/i,
    /под\s+заказ/i,
    /канал(ы)?\s+продаж/i,
    /клиентск(ая|ую|ой)\s+баз/i,
    /для\s+себя\s+или\s+на\s+перепродаж/i,
    /собственн(ые|ая|ого)\s+нужд/i,
  ];

  return (Array.isArray(questions) ? questions : [])
    .map(q => String(q || "").trim())
    .filter(Boolean)
    .filter(q => !banned.some(re => re.test(q)))
    .slice(0, 5);
}

async function buildDealContext(deal) {
  let linkedContact = null;
  let linkedCompany = null;

  try {
    linkedContact = await getContact(deal.CONTACT_ID);
  } catch {}

  try {
    const companyId =
      (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0")
        ? deal.COMPANY_ID
        : linkedContact?.COMPANY_ID;
    linkedCompany = await getCompany(companyId);
  } catch {}

  const activities = await getRecentDealActivities(deal.ID);
  const attachments = await downloadRecentAttachments(activities);
  const attachmentDocuments = await extractAttachmentDocuments(attachments);
  const previousDeals = await getPreviousDealContext(deal);
  const knownDealer = isConfirmedDealerProfile(linkedCompany, previousDeals);

  const baseContext = {
    linked_company: linkedCompany
      ? {
          id: String(linkedCompany.ID || ""),
          title: linkedCompany.TITLE || "",
          ai_type: linkedCompany[AI_FIELDS.companyType] || "",
          ai_roles: linkedCompany[AI_FIELDS.companyRoles] || "",
          ai_reason: linkedCompany[AI_FIELDS.companyReason] || "",
        }
      : null,
    known_dealer: knownDealer,
    dealer_evidence: knownDealer
      ? dealerEvidence(linkedCompany, previousDeals)
      : "",
    linked_contact: linkedContact
      ? {
          name: linkedContact.NAME || "",
          last_name: linkedContact.LAST_NAME || "",
          second_name: linkedContact.SECOND_NAME || "",
          position: linkedContact.POST || "",
          email: Array.isArray(linkedContact.EMAIL)
            ? linkedContact.EMAIL.map(x => x.VALUE).filter(Boolean)
            : [],
          phone: Array.isArray(linkedContact.PHONE)
            ? linkedContact.PHONE.map(x => x.VALUE).filter(Boolean)
            : [],
        }
      : null,
    recent_activities: activities,
    attachment_metadata: attachments.map(item => ({
      id: item.id,
      file_name: item.fileName,
      content_type: item.contentType,
      bytes: item.buffer.length,
    })),
    attachment_documents: attachmentDocuments,
    previous_deals: previousDeals,
  };

  const senderDomain = corporateDomainFromContext(baseContext);
  const domainWebsite = senderDomain
    ? await fetchDomainWebsite(senderDomain)
    : null;

  return {
    ...baseContext,
    sender_domain: senderDomain,
    domain_website: domainWebsite,
  };
}

function dealForAI(deal, context = {}) {
  return {
    id: String(deal.ID),
    title: deal.TITLE || "",
    comments: deal.COMMENTS || "",
    additional_info: deal.ADDITIONAL_INFO || "",
    source_id: deal.SOURCE_ID || null,
    category_id: deal.CATEGORY_ID || null,
    stage_id: deal.STAGE_ID || null,
    opportunity: deal.OPPORTUNITY || null,
    currency: deal.CURRENCY_ID || null,
    region: deal.UF_CRM_1728209888200 || "",
    legal_address: deal.UF_CRM_1728209895847 || "",
    inn: deal.UF_CRM_1789994254952 || "",
    current_client_type: deal.UF_CRM_1739950675115 || "",
    analogs: deal.UF_CRM_1728208192427 || "",
    purchase_format: deal.UF_CRM_1728208250222 || "",
    end_customer: deal.UF_CRM_1728208529434 || "",
    delivery_deadline: deal.UF_CRM_1728208560055 || "",
    competitor_prices: deal.UF_CRM_1728208500678 || "",
    manager_questions_and_answers: deal.UF_CRM_1790850696723 || "",
    qualification_answer_history: deal[AI_FIELDS.dealAnswers] || "",
    sender_domain: context.sender_domain || corporateDomainFromContext(context),
    domain_website: context.domain_website || null,
    linked_company: context.linked_company || null,
    known_dealer: Boolean(context.known_dealer),
    dealer_evidence: context.dealer_evidence || "",
    linked_contact: context.linked_contact || null,
    recent_activities: context.recent_activities || [],
    attachment_documents: context.attachment_documents || [],
    previous_deals: context.previous_deals || [],
  };
}

async function callOpenAI(body) {
  if (openAiPaused()) {
    throw new Error("OpenAI calls are paused by OPENAI_PAUSED=1");
  }

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });

  const payload = await response.json();

  if (!response.ok || payload.error) {
    const message =
      payload?.error?.message ||
      payload?.error_description ||
      `OpenAI API HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}


function analysisTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "deal_qualification",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          deal_title: { type: "string" },
          title_components: {
            type: "object",
            additionalProperties: false,
            properties: {
              quantity: { type: "string" },
              device_type: { type: "string" },
              gases: {
                type: "array",
                items: { type: "string" }
              },
              end_customer: { type: "string" }
            },
            required: ["quantity", "device_type", "gases", "end_customer"]
          },
          client_type: { type: "string" },
          classification_reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          purchase_format: { type: "string" },
          delivery_deadline: { type: "string" },
          question_keys: {
            type: "array",
            items: { type: "string" },
          },
          context_questions: {
            type: "array",
            items: { type: "string" },
            maxItems: 6
          },
          known_facts: {
            type: "array",
            items: { type: "string" },
          },
          company: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              inn: { type: "string" },
              website: { type: "string" },
              phone: { type: "string" },
              email: { type: "string" },
              region: { type: "string" },
              city: { type: "string" },
              address: { type: "string" },
              is_manufacturer: {
                type: "string",
                enum: ["Да", "Нет", "Не определено"]
              },
              manufactured_products: { type: "string" },
              manufacturer_reason: { type: "string" },
              services: { type: "string" },
              roles: {
                type: "array",
                items: { type: "string" }
              },
              revenue: { type: "string" },
              revenue_year: { type: "string" },
              revenue_previous: { type: "string" },
              revenue_previous_year: { type: "string" },
              revenue_growth_percent: { type: "string" },
              net_profit: { type: "string" },
              financial_source: { type: "string" },
              employee_count: { type: "string" },
              employee_count_year: { type: "string" },
              branches: { type: "array", items: { type: "string" } },
              operating_regions: { type: "array", items: { type: "string" } },
              key_customers_or_objects: { type: "array", items: { type: "string" } },
              quick_sale_score: { type: "number", minimum: 0, maximum: 100 },
              quick_sale_reason: { type: "string" },
            },
            required: [
              "name",
              "inn",
              "website",
              "phone",
              "email",
              "region",
              "city",
              "address",
              "is_manufacturer",
              "manufactured_products",
              "manufacturer_reason",
              "services",
              "roles",
              "revenue",
              "revenue_year",
              "revenue_previous",
              "revenue_previous_year",
              "revenue_growth_percent",
              "net_profit",
              "financial_source",
              "employee_count",
              "employee_count_year",
              "branches",
              "operating_regions",
              "key_customers_or_objects",
              "quick_sale_score",
              "quick_sale_reason",
            ],
          },
          contact: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              first_name: { type: "string" },
              last_name: { type: "string" },
              second_name: { type: "string" },
              position: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
            },
            required: [
              "name",
              "first_name",
              "last_name",
              "second_name",
              "position",
              "email",
              "phone",
            ],
          },
        },
        required: [
          "deal_title",
          "title_components",
          "client_type",
          "classification_reason",
          "confidence",
          "purchase_format",
          "delivery_deadline",
          "question_keys",
          "context_questions",
          "known_facts",
          "company",
          "contact",
        ],
      },
    },
  };
}

function analysisInstructions() {
  return [
    "Ты квалификатор входящих B2B-заявок российского производителя промышленных газоанализаторов ТОП-СЕНС.",
    "Сначала определи тип компании по данным сделки. Не выдумывай факты.",
    "Допустимые типы: " + Object.keys(QUESTION_RULES).concat(["Не определено"]).join(", ") + ".",
    "СНГ — это география, а тендер — способ закупки, не тип компании.",
    "Сначала отдельно определи, является ли компания производителем. Это независимый признак от client_type.",
    "company.is_manufacturer: Да, если официальный сайт или надёжный источник явно говорит о собственном производстве/разработке продукции; Нет, если подтверждена только торговля/услуги; Не определено, если доказательств недостаточно.",
    "company.manufactured_products — коротко перечисли, что именно компания производит. Если не установлено — пустая строка.",
    "company.manufacturer_reason — коротко укажи, на каком факте основан вывод о производстве.",
    "Наличие каталога, интернет-магазина или слов «поставляем/продаём» само по себе не означает производство.",
    "Компания может одновременно производить продукцию, продавать чужое оборудование, комплектовать проекты, интегрировать системы и оказывать услуги. Эти признаки не взаимоисключающие.",
    "company.services — коротко перечисли подтверждённые услуги компании: сервис, ремонт, поверка, монтаж, пусконаладка, проектирование, интеграция, промышленная безопасность и т.п. Если не установлено — пустая строка.",
    "company.roles — массив всех подтверждённых коммерческих ролей компании, например: Производитель, Сервисная компания, Интегратор, Подрядчик, Дилер, Дистрибьютор, Комплектатор, Проектная организация. Можно указывать несколько ролей одновременно.",
    "Финансовый профиль собирай ДЛЯ ЛЮБОЙ точно идентифицированной компании, а не только для дилеров.",
    "Если удалось точно определить российское юрлицо по ИНН, при веб-поиске найди последнюю доступную годовую бухгалтерскую выручку и предыдущий год. Приоритет финансовых источников: ГИР БО/ФНС, затем надёжные бизнес-реестры, которые явно указывают год и показатель.",
    "company.revenue и company.revenue_previous — выручка в рублях, только цифрами без пробелов и валютных символов. Если достоверного значения нет — пустая строка.",
    "company.revenue_year и company.revenue_previous_year — соответствующие годы четырьмя цифрами.",
    "company.revenue_growth_percent — изменение выручки год к году в процентах, например 17.4 или -8.2. Если нельзя корректно посчитать — пустая строка.",
    "company.net_profit — чистая прибыль за тот же последний доступный год в рублях, только цифрами; отрицательное значение допускается. Если данных нет — пустая строка.",
    "company.financial_source — коротко укажи источник и год, например «ГИР БО ФНС, 2025» или «РБК Компании, отчетность 2025». Не угадывай финансовые показатели.",
    "Для ИП и организаций без доступной публичной отчётности оставляй финансовые поля пустыми; не оценивай оборот косвенно.",
    "Для любой точно идентифицированной компании анализируй официальный сайт и открытые источники на предмет филиалов, обособленных подразделений, сервисных центров и фактической географии работы.",
    "company.branches — подтверждённые филиалы/подразделения/сервисные центры с городом или регионом. Не путай филиалы с единичными объектами заказчиков.",
    "company.operating_regions — регионы России и другие территории, где компания реально ведёт работы/оказывает услуги.",
    "company.employee_count и company.employee_count_year — последняя подтверждённая численность сотрудников и год. Приоритет: официальная публикация компании или открытые сведения ФНС/надёжного реестра. Если есть только маркетинговое «5000+ специалистов», можно сохранить «5000+» и источник в известных фактах.",
    "company.key_customers_or_objects — только публично подтверждённые крупные заказчики, месторождения, НПЗ, нефтехимические, металлургические и иные промышленные объекты.",
    "company.quick_sale_score — оценка 0–100 вероятности относительно быстрой продажи ТОП-СЕНС. Это коммерческий скоринг, а не кредитный рейтинг.",
    "Для quick_sale_score повышай балл подрядчикам и сервисным компаниям на опасных объектах, с мобильными бригадами, несколькими регионами, остановочными/ремонтными работами, прямыми закупками и очевидной потребностью в газоанализаторах. Снижай при чисто тендерной модели, очень длинном цикле, отсутствии полевых работ или слабом соответствии продукту.",
    "company.quick_sale_reason — 1–2 коротких предложения, почему компания коммерчески интересна или неинтересна ТОП-СЕНС.",
    "client_type — это основной тип компании именно для текущей продажи и выбора вопросов, но он не должен скрывать другие роли компании.",
    "Если компания реально производит продукцию, это должно быть явно отражено даже если она одновременно продаёт, комплектует, интегрирует или оказывает сервис.",
    "Если собственное производство — основная деятельность, не классифицируй компанию как чистую Торговую компанию / комплектатора. Обычно выбирай Завод / промышленное предприятие, а для производителя газоаналитического оборудования — Производитель газоаналитического оборудования / конкурент.",
    "Тип компании определяй по основной деятельности компании, а не только по товару в текущем запросе и не по должности отправителя.",
    "Если официальный сайт прямо говорит о собственной разработке или производстве газоанализаторов, газоаналитического оборудования, датчиков газа или близкой продукции, классифицируй как Производитель газоаналитического оборудования / конкурент. Не относить такого клиента к торговой компании только потому, что на сайте есть каталог или продажи.",
    "Если есть sender_domain, используй его сразу как один из главных идентификаторов компании. Название из подписи сверяй с этим доменом.",
    "Если есть domain_website, это содержимое сайта домена отправителя. Используй его как первичный источник для определения деятельности компании, её названия и типа.",
    "Если есть attachment_documents, это текст вложенных документов из письма. Для юридических реквизитов компании (официальное название, ИНН, КПП, ОГРН, юридический адрес) такие документы имеют приоритет над сайтом и свободным веб-поиском.",
    "Если во вложенном официальном документе найден ИНН, обязательно заполни company.inn. Не подменяй ИНН похожей компании из интернета.",
    "Для company.phone и company.email приоритет имеют контакты с официального сайта domain_website. Не копируй персональный телефон отправителя в карточку компании, если на сайте есть отдельный общий телефон.",
    "Для contact.phone и contact.email используй только данные самого письма/подписи/контакта Bitrix, не контакты с сайта компании.",
    "Если тип нельзя определить уверенно, используй Не определено.",
    "Для названия сделки выдели title_components: quantity, device_type, gases, end_customer.",
    "title_components.quantity — только количество приборов цифрами, без «шт.». Если количество не указано — пустая строка.",
    "title_components.device_type — тип прибора: стационарный, портативный, персональный и т.п. Если в письме написано «переносной», нормализуй это как «портативный». Не добавляй слово «газоанализатор», если тип уже понятен. Если тип не установлен — пустая строка.",
    "title_components.gases — только химические формулы газов: CO, CO2, H2S, CH4, O2, NH3, Cl2 и т.п. Никогда не пиши названия газов словами. Если газ не указан — пустой массив.",
    "title_components.end_customer — конечный заказчик только если он прямо указан в заявке/переписке. Не угадывай его.",
    "deal_title можешь дать как черновик, но итоговое название CRM формирует код в формате: «12 шт. стац. на CO для Газаналитика (Моск. НПЗ)».",
    "classification_reason — одно короткое предложение, почему выбран этот тип.",
    "Если known_dealer=true, компания уже подтверждена как дилер по CRM/истории. В этом случае client_type должен быть Дилер, не проводи повторную квалификацию компании и не задавай вопросы про регионы работы, частоту закупок, объем закупок, работу под заказ/на склад, дилерское соглашение, клиентскую базу или является ли закупка перепродажей.",
    "Если known_dealer=true, question_keys должен быть пустым массивом. Все вопросы менеджеру формируй только в context_questions и только по конкретной текущей заявке: недостающие характеристики прибора, газ/диапазон, количество, конечный заказчик если не указан, допустимость аналога, сроки, формат закупки, требования ТЗ, целевая цена/конкурент при наличии контекста.",
    "Для известного дилера не спрашивай повторно сведения о самой компании, если они уже известны.",
    "question_keys используй только для стандартных CRM-полей и только если такой вопрос действительно нужен в текущей сделке.",
    "context_questions — 3–5 конкретных вопросов менеджеру, которые логически вытекают именно из ТЕКУЩЕЙ потребности.",
    "context_questions можно формулировать свободно: они должны учитывать конкретное оборудование, количество, газ, объект, сроки и уже известные факты.",
    "Если есть previous_deals, это история предыдущих потребностей этого же контакта/компании. Не повторяй вопросы, которые уже задавались раньше, если ответ применим к новой потребности.",
    "Если параметр может измениться от закупки к закупке и его надо подтвердить заново, формулируй вопрос как уточнение именно по новой потребности, а не повторяй старую формулировку.",
    "Не спрашивай то, что уже прямо сказано в новом письме. Вопросы должны закрывать пробелы нового контекста и помогать продаже.",
    "Из 3–5 context_questions 1–2 могут быть продающими, если базовая техническая потребность уже понятна.",
    "Не требуй имя конечного заказчика.",
    "Извлеки из сделки данные компании и контактного лица. Для входящих email-заявок обязательно анализируй recent_activities: там может находиться тема, текст письма, подпись отправителя и коммуникации.",
    "company должен содержать: name, inn, website, phone, email, region, city, address, is_manufacturer, manufactured_products, manufacturer_reason, services, roles, revenue, revenue_year, revenue_previous, revenue_previous_year, revenue_growth_percent, net_profit, financial_source, employee_count, employee_count_year, branches, operating_regions, key_customers_or_objects, quick_sale_score, quick_sale_reason. Неизвестные текстовые значения оставляй пустой строкой, неизвестные массивы — пустыми массивами.",
    "contact должен содержать: name, first_name, last_name, second_name, position, email, phone. Неизвестные значения оставляй пустой строкой.",
    "Для contact используй персональные данные только если они явно есть в самой заявке/подписи. Не ищи персональные контакты людей в интернете.",
    "Правила вопросов: " + JSON.stringify(QUESTION_RULES),
    "Ответь только валидным JSON без markdown.",
    "JSON должен содержать: deal_title, title_components, client_type, classification_reason, confidence, purchase_format, delivery_deadline, question_keys, context_questions, known_facts, company, contact."
  ].join("\n");
}

async function analyzeDeal(deal, allowWebSearch = false) {
  const model = (process.env.OPENAI_MODEL || "gpt-6-luna").trim();
  const context = await buildDealContext(deal);
  const input = dealForAI(deal, context);
  const senderDomain = input.sender_domain || "";

  let analysis = null;
  let finalPayload = null;
  let webUsed = false;
  let webSources = [];

  // For inbound email from a corporate domain, identify the company by domain immediately.
  if (allowWebSearch && senderDomain) {
    const domainPayload = await callOpenAI({
      model,
      store: false,
      max_output_tokens: 2200,
      text: analysisTextFormat(),
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      instructions: [
        analysisInstructions(),
        "Перед квалификацией обязательно выполни веб-поиск.",
        "Начни идентификацию компании с sender_domain: " + senderDomain + ".",
        "Сначала изучи domain_website, если он доступен: это сайт домена отправителя. Затем при необходимости используй веб-поиск для подтверждения и поиска реквизитов.",
        "Установи, какой организации принадлежит этот домен, затем сверяй название компании из письма, подписи, ИНН и сайт.",
        "Если название компании распространённое, домен имеет больший вес, чем одно только название.",
        "Приоритет источников: официальный сайт этого домена, затем надёжные бизнес-реестры.",
        "Заполни company только подтверждёнными данными: официальное название, ИНН, сайт, общий телефон, общий email, регион, город, адрес.",
        "Независимо от типа компании, если это точно идентифицированное российское юрлицо, найди последнюю доступную годовую выручку, выручку предыдущего года, чистую прибыль и источник финансовых данных.",
        "Также найди численность сотрудников, филиалы/подразделения, географию работ, публичных крупных заказчиков/объекты и оцени потенциал быстрой продажи ТОП-СЕНС.",
        "Не ищи в интернете персональные данные контактного лица."
      ].join("\n"),
      input: [{
        role: "user",
        content:
          "Определи точную компанию, её тип и вопросы менеджеру. Если сайт компании указывает на собственное производство газоанализаторов или газоаналитического оборудования, обязательно отнеси её к типу Производитель газоаналитического оборудования / конкурент. Данные сделки:\n" +
          JSON.stringify(input),
      }],
    });

    const domainText = extractResponseText(domainPayload);
    webUsed = true;
    webSources = extractWebSources(domainPayload);

    if (domainText) {
      try {
        analysis = parseJsonText(domainText);
        finalPayload = domainPayload;
      } catch (error) {
        console.warn(JSON.stringify({
          source: "openai",
          action: "domain-research-json-fallback",
          dealId: String(deal.ID),
          senderDomain,
          error: error instanceof Error ? error.message : String(error),
        }));
        analysis = null;
      }
    } else {
      console.warn(JSON.stringify({
        source: "openai",
        action: "domain-research-no-text-fallback",
        dealId: String(deal.ID),
        senderDomain,
        at: new Date().toISOString(),
      }));
    }
  }

  // Fallback / non-email path.
  if (!analysis) {
    const firstPayload = await callOpenAI({
      model,
      store: false,
      max_output_tokens: 1600,
      text: analysisTextFormat(),
      instructions: analysisInstructions(),
      input: [{
        role: "user",
        content:
          "Проанализируй новую сделку и верни квалификацию. Данные сделки:\n" +
          JSON.stringify(input),
      }],
    });

    const firstText = extractResponseText(firstPayload);
    if (!firstText) {
      throw new Error("OpenAI returned no text output");
    }

    analysis = parseJsonText(firstText);
    finalPayload = firstPayload;

    const hasCompanyIdentity = Boolean(
      analysis.company?.name ||
      analysis.company?.inn ||
      analysis.company?.website ||
      input.inn
    );

    const needsResearch =
      allowWebSearch &&
      (
        hasCompanyIdentity ||
        analysis.client_type === "Не определено" ||
        Number(analysis.confidence || 0) < 0.75
      );

    if (needsResearch) {
      const researchPayload = await callOpenAI({
        model,
        store: false,
        max_output_tokens: 2200,
        text: analysisTextFormat(),
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        instructions: [
          analysisInstructions(),
          "Перед ответом обязательно выполни веб-поиск.",
          "Ищи точную компанию по сочетанию названия, ИНН, сайта и sender_domain, если они присутствуют.",
          "Приоритет: официальный сайт компании, затем надёжные бизнес-реестры.",
          "Определи тип по фактической основной деятельности компании.",
          "Найди и заполни по открытым источникам компанию: официальное название, ИНН, сайт, общий телефон, общий email, регион, город и адрес.",
          "Для точно идентифицированного российского юрлица независимо от типа компании найди последнюю доступную годовую выручку, выручку предыдущего года, чистую прибыль и источник финансовых данных.",
          "Также проверь официальный сайт и открытые источники: численность сотрудников, филиалы/подразделения, географию работ, публично названных крупных заказчиков/объекты и оцени потенциал быстрой продажи ТОП-СЕНС.",
          "Не ищи в интернете персональные данные контактного лица."
        ].join("\n"),
        input: [{
          role: "user",
          content:
            "Уточни тип компании через открытые источники и заново выбери вопросы. " +
            "Данные сделки:\n" +
            JSON.stringify(input) +
            "\nПервичный анализ:\n" +
            JSON.stringify(analysis),
        }],
      });

      const researchText = extractResponseText(researchPayload);
      webUsed = true;
      webSources = extractWebSources(researchPayload);

      if (researchText) {
        try {
          analysis = parseJsonText(researchText);
          finalPayload = researchPayload;
        } catch (error) {
          console.warn(JSON.stringify({
            source: "openai",
            action: "research-json-kept-first-pass",
            dealId: String(deal.ID),
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }
  }

  if (input.domain_website) {
    const sitePhones = Array.isArray(input.domain_website.phones)
      ? input.domain_website.phones
      : [];
    const siteEmails = Array.isArray(input.domain_website.emails)
      ? input.domain_website.emails
      : [];

    if (sitePhones[0]) {
      analysis.company = analysis.company || {};
      analysis.company.phone = sitePhones[0];
    }

    const siteCompanyEmail = preferredCompanyEmail(siteEmails);
    if (siteCompanyEmail) {
      analysis.company = analysis.company || {};
      analysis.company.email = siteCompanyEmail;
    }
  }

  if (input.known_dealer) {
    analysis.client_type = "Дилер";
    analysis.question_keys = [];
    analysis.context_questions = filterDealerContextQuestions(
      analysis.context_questions
    );
    analysis.company = analysis.company || {};
    const roles = Array.isArray(analysis.company.roles)
      ? analysis.company.roles
      : [];
    if (!roles.some(role => String(role || "").toLowerCase() === "дилер")) {
      analysis.company.roles = roles.concat(["Дилер"]);
    }
    analysis._known_dealer = true;
    analysis._dealer_evidence = input.dealer_evidence || "";
  }

  console.log(JSON.stringify({
    source: "openai",
    action: "ai-first-pass",
    dealId: String(deal.ID),
    senderDomain: senderDomain || null,
    clientType: analysis.client_type || null,
    confidence: analysis.confidence ?? null,
    companyName: analysis.company?.name || null,
    companyInn: analysis.company?.inn || null,
    companyWebsite: analysis.company?.website || null,
    revenue: analysis.company?.revenue || null,
    revenueYear: analysis.company?.revenue_year || null,
    questionCount: Array.isArray(analysis.question_keys)
      ? analysis.question_keys.length
      : 0,
    webUsed,
  }));

  return {
    model: finalPayload?.model || model,
    responseId: finalPayload?.id || null,
    analysis,
    webUsed,
    webSources,
  };
}

async function reconcileRecentTestDeals() {
  try {
    const deals = await bitrixCall("crm.deal.list", {
      order: { ID: "DESC" },
      select: [
        "ID",
        "TITLE",
        "COMMENTS",
        "ADDITIONAL_INFO",
        "UF_CRM_1790850696723",
        "DATE_CREATE"
      ],
      start: 0,
    });

    if (!Array.isArray(deals)) return;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    let candidates = deals.slice(0, 50).filter(deal => {
      const createdAt = Date.parse(deal.DATE_CREATE || "");
      if (!createdAt || createdAt < cutoff) return false;

      const haystack = [
        deal.TITLE,
        deal.COMMENTS,
        deal.ADDITIONAL_INFO,
      ]
        .filter(Boolean)
        .join("\n")
        .toUpperCase();

      if (!haystack.includes("AI WEBHOOK TEST")) return false;

      const questions = String(deal.UF_CRM_1790850696723 || "");
      if (!questions.includes("Тип:")) return true;
      if (questions.includes("Тип: Не определено")) return true;
      return false;
    });

    // Reconcile only the newest missed test deal per pass.
    for (const deal of candidates.slice(0, 1)) {
      console.log(JSON.stringify({
        source: "pipeline",
        action: "reconcile-test-deal",
        dealId: String(deal.ID),
      }));

      await processDeal({
        event: "ONCRMDEALADD",
        dealId: String(deal.ID),
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      source: "pipeline",
      action: "reconcile-error",
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }));
  }
}


const ROUTED_ACTIVITIES = new Set();

async function getActivity(id) {
  if (!id) return null;
  return bitrixCall("crm.activity.get", { id: Number(id) });
}

function currentEmailBody(value) {
  const text = String(value || "").trim();
  const separators = [
    /\s*-{5,}\s*Кому:/i,
    /\s*От:\s+[^\n]{0,300}\s+Кому:/i,
    /\s*From:\s+[^\n]{0,300}\s+To:/i,
  ];

  let cut = text.length;
  for (const re of separators) {
    const match = re.exec(text);
    if (match && match.index < cut) cut = match.index;
  }

  return text.slice(0, cut).replace(/\s+/g, " ").trim();
}

function quotedEmailSubject(value) {
  const text = String(value || "");
  const match =
    text.match(/Тема:\s*([^;\n]{1,300})\s*;/i) ||
    text.match(/Subject:\s*([^;\n]{1,300})/i);
  return String(match?.[1] || "").trim();
}

async function findDealByTitleExact(title) {
  const value = String(title || "").trim();
  if (!value) return null;
  try {
    const deals = await bitrixCall("crm.deal.list", {
      order: { ID: "DESC" },
      filter: { TITLE: value },
      select: ["ID", "TITLE", "COMMENTS", "COMPANY_ID", "CONTACT_ID", "CATEGORY_ID", "ASSIGNED_BY_ID"],
      start: 0,
    });
    return Array.isArray(deals)
      ? deals.find(item => String(item.TITLE || "").trim() === value) || null
      : null;
  } catch {
    return null;
  }
}

function normalizedActivity(item) {
  if (!item) return null;
  return {
    id: String(item.ID || item.id || ""),
    owner_type_id: Number(item.OWNER_TYPE_ID || item.ownerTypeId || 0),
    owner_id: String(item.OWNER_ID || item.ownerId || ""),
    type_id: String(item.TYPE_ID || item.typeId || ""),
    direction: String(item.DIRECTION || item.direction || ""),
    provider_id: String(item.PROVIDER_ID || item.providerId || ""),
    subject: String(item.SUBJECT || item.subject || "").trim(),
    description: currentEmailBody(
      stripHtml(item.DESCRIPTION || item.description || "").slice(0, 12000)
    ),
    thread_description: stripHtml(item.DESCRIPTION || item.description || "").slice(0, 12000),
    created: item.CREATED || item.created || null,
  };
}

function needRoutingTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "email_need_routing",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          is_new_need: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          suggested_title: { type: "string" },
        },
        required: ["is_new_need", "confidence", "reason", "suggested_title"],
      },
    },
  };
}

async function classifyEmailNeed(deal, activity) {
  const activities = await getRecentDealActivities(deal.ID);
  const currentCreated = Date.parse(activity.created || "") || Number.MAX_SAFE_INTEGER;
  const previous = activities
    .filter(item => String(item.id) !== String(activity.id))
    .filter(isInboundEmailActivity)
    .filter(item => {
      const created = Date.parse(item.created || "") || 0;
      return created <= currentCreated;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.created || "") || 0;
      const tb = Date.parse(b.created || "") || 0;
      return tb - ta;
    })
    .slice(0, 4)
    .map(item => ({
      subject: item.subject,
      description: currentEmailBody(item.description),
      created: item.created,
    }));

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-6-luna",
    input: [
      {
        role: "system",
        content: [
          "Ты маршрутизатор входящих B2B-писем в CRM.",
          "Определи, относится ли новое письмо к уже существующей коммерческой потребности в сделке или создаёт новую самостоятельную потребность.",
          "Новая потребность — другой товар/оборудование, другое ТЗ, другой объект, другая закупка или независимый коммерческий запрос.",
          "Продолжение — уточнение количества, цены, сроков, характеристик, документов, оплаты или доставки по уже существующему запросу.",
          "Одна только смена темы письма недостаточна для новой сделки; сравни смысл.",
          "Если явно новая потребность — is_new_need=true.",
          "suggested_title: если это новая потребность, дай короткое временное название в стиле «12 шт. стац. на CO для Компания». Количество — цифрами, газы — только химическими формулами, стационарные сокращай «стац.», портативные — «порт.». Не используй AI WEBHOOK TEST/Запрос КП. Если это продолжение, оставь пустую строку.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          existing_deal: {
            id: String(deal.ID),
            title: deal.TITLE || "",
            previous_inbound_emails: previous,
          },
          new_email: {
            id: activity.id,
            subject: activity.subject,
            description: activity.description,
            quoted_subject: quotedEmailSubject(activity.thread_description),
            created: activity.created,
          },
        }),
      },
    ],
    text: needRoutingTextFormat(),
    max_output_tokens: 1200,
  };

  const response = await callOpenAI(payload);
  const text = extractResponseText(response);
  return parseJsonText(text);
}

async function findDealByRoutedActivityMarker(activityId) {
  try {
    const deals = await bitrixCall("crm.deal.list", {
      order: { ID: "DESC" },
      filter: {},
      select: ["ID", "TITLE", "COMMENTS", "DATE_CREATE"],
      start: 0,
    });

    const marker = "[AI-ROUTED-ACTIVITY:" + String(activityId) + "]";
    return Array.isArray(deals)
      ? deals.slice(0, 100).find(item => String(item.COMMENTS || "").includes(marker)) || null
      : null;
  } catch {
    return null;
  }
}

async function moveActivityToDeal(activityId, sourceDealId, targetDealId) {
  if (String(sourceDealId) === String(targetDealId)) return true;

  return bitrixCall("crm.activity.binding.move", {
    activityId: Number(activityId),
    sourceEntityTypeId: 2,
    sourceEntityId: Number(sourceDealId),
    targetEntityTypeId: 2,
    targetEntityId: Number(targetDealId),
  });
}

async function routeInboundActivity(activityId, options = {}) {
  const id = String(activityId || "");
  if (!id || ROUTED_ACTIVITIES.has(id)) return null;

  const raw = await getActivity(id);
  const activity = normalizedActivity(raw);
  if (!activity) return null;

  const isEmail =
    activity.provider_id.toUpperCase().includes("EMAIL") ||
    activity.type_id === "4";

  if (!isEmail || activity.direction !== "1" || activity.owner_type_id !== 2 || !activity.owner_id) {
    console.log(JSON.stringify({
      source: "routing",
      action: "activity-ignored",
      activityId: id,
      providerId: activity.provider_id,
      direction: activity.direction,
      ownerTypeId: activity.owner_type_id,
    }));
    return null;
  }

  const sourceDeal = await fetchDeal(activity.owner_id);

  // Bitrix may already create a brand-new deal for a standalone incoming email.
  // In that case this activity is the seed of the new deal, not a reason to create one more.
  try {
    const sourceActivities = await getRecentDealActivities(sourceDeal.ID);
    const inboundActivities = sourceActivities.filter(isInboundEmailActivity);
    const sourceCreated = Date.parse(sourceDeal.DATE_CREATE || "") || 0;
    const activityCreated = Date.parse(activity.created || "") || 0;
    const createdTogether =
      sourceCreated &&
      activityCreated &&
      Math.abs(activityCreated - sourceCreated) <= 5 * 60 * 1000;

    if (
      String(sourceDeal.SOURCE_ID || "").toUpperCase() === "EMAIL" &&
      inboundActivities.length <= 1 &&
      createdTogether
    ) {
      ROUTED_ACTIVITIES.add(id);

      console.log(JSON.stringify({
        source: "routing",
        action: "fresh-email-deal-kept",
        activityId: id,
        dealId: String(sourceDeal.ID),
        subject: activity.subject || "",
      }));

      if (!options.skipProcessDeal) {
        await processDeal({ event: "ONCRMDEALADD", dealId: String(sourceDeal.ID) });
      }

      return sourceDeal;
    }
  } catch {}

  const testHaystack = [
    sourceDeal.TITLE,
    sourceDeal.COMMENTS,
    sourceDeal.ADDITIONAL_INFO,
    activity.subject,
    activity.description,
  ].filter(Boolean).join("\n").toUpperCase();

  if (!testHaystack.includes("AI WEBHOOK TEST")) {
    console.log(JSON.stringify({
      source: "routing",
      action: "non-test-activity-skipped",
      activityId: id,
      dealId: String(sourceDeal.ID),
    }));
    return null;
  }

  const alreadyRouted = await findDealByRoutedActivityMarker(id);
  if (alreadyRouted) {
    if (String(activity.owner_id) !== String(alreadyRouted.ID)) {
      await moveActivityToDeal(id, activity.owner_id, alreadyRouted.ID);
      console.log(JSON.stringify({
        source: "routing",
        action: "existing-route-move-completed",
        activityId: id,
        sourceDealId: String(activity.owner_id),
        targetDealId: String(alreadyRouted.ID),
      }));
      if (!options.skipProcessDeal) {
        await processDeal({ event: "ONCRMDEALADD", dealId: String(alreadyRouted.ID) });
      }
    }

    ROUTED_ACTIVITIES.add(id);
    console.log(JSON.stringify({
      source: "routing",
      action: "activity-already-routed",
      activityId: id,
      dealId: String(alreadyRouted.ID),
    }));
    return fetchDeal(alreadyRouted.ID);
  }

  const quotedSubject = quotedEmailSubject(activity.thread_description);
  const currentBody = currentEmailBody(activity.description);

  // A reply in the same email thread can still contain a completely new need.
  // Always classify the CURRENT message first; quoted subject is only a routing hint.
  const routing = await classifyEmailNeed(sourceDeal, activity);

  console.log(JSON.stringify({
    source: "routing",
    action: "need-classified",
    activityId: id,
    sourceDealId: String(sourceDeal.ID),
    isNewNeed: Boolean(routing.is_new_need),
    confidence: routing.confidence,
    reason: routing.reason,
    suggestedTitle: routing.suggested_title || "",
  }));

  if (!routing.is_new_need || Number(routing.confidence || 0) < 0.65) {
    if (quotedSubject) {
      const quotedDeal = await findDealByTitleExact(quotedSubject);
      if (quotedDeal && String(quotedDeal.ID) !== String(sourceDeal.ID)) {
        const marker = "[AI-ROUTED-ACTIVITY:" + id + "]";
        const existingComments = String(quotedDeal.COMMENTS || "").trim();
        const append = [
          marker,
          "Продолжение переписки: " + (activity.subject || "входящее письмо"),
          currentBody ? "Письмо: " + currentBody : "",
        ].filter(Boolean).join("\r\n");

        if (!existingComments.includes(marker)) {
          await updateDealFields(quotedDeal.ID, {
            COMMENTS: existingComments
              ? existingComments + "\r\n\r\n" + append
              : append,
          });
        }

        await moveActivityToDeal(id, sourceDeal.ID, quotedDeal.ID);

        console.log(JSON.stringify({
          source: "routing",
          action: "followup-moved-to-quoted-deal",
          activityId: id,
          sourceDealId: String(sourceDeal.ID),
          targetDealId: String(quotedDeal.ID),
          quotedSubject,
        }));

        if (!options.skipProcessDeal) {
          await processDeal({ event: "ONCRMDEALADD", dealId: String(quotedDeal.ID) });
        }
      }
    }

    ROUTED_ACTIVITIES.add(id);
    return null;
  }

  const title =
    String(routing.suggested_title || "").trim() ||
    String(activity.subject || "").trim() ||
    "Новая потребность";

  const marker = "[AI-ROUTED-ACTIVITY:" + id + "]";
  const comments = [
    marker,
    "Новая потребность из входящего письма.",
    routing.reason ? "Причина выделения в новую сделку: " + routing.reason : "",
    activity.description ? "Письмо: " + currentEmailBody(activity.description) : "",
  ].filter(Boolean).join("\r\n\r\n");

  const fields = {
    TITLE: title,
    CATEGORY_ID: Number(sourceDeal.CATEGORY_ID || 0),
    STAGE_ID: "NEW",
    ASSIGNED_BY_ID: Number(sourceDeal.ASSIGNED_BY_ID || 1),
    SOURCE_ID: "EMAIL",
    COMMENTS: comments,
  };

  if (sourceDeal.COMPANY_ID && String(sourceDeal.COMPANY_ID) !== "0") {
    fields.COMPANY_ID = Number(sourceDeal.COMPANY_ID);
  }
  if (sourceDeal.CONTACT_ID && String(sourceDeal.CONTACT_ID) !== "0") {
    fields.CONTACT_ID = Number(sourceDeal.CONTACT_ID);
  }

  const newDealId = await bitrixCall("crm.deal.add", { fields });

  await moveActivityToDeal(id, sourceDeal.ID, newDealId);
  ROUTED_ACTIVITIES.add(id);

  console.log(JSON.stringify({
    source: "routing",
    action: "new-deal-created-from-email",
    activityId: id,
    sourceDealId: String(sourceDeal.ID),
    newDealId: String(newDealId),
    title,
    confidence: routing.confidence,
  }));

  if (!options.skipProcessDeal) {
    await processDeal({ event: "ONCRMDEALADD", dealId: String(newDealId) });
  }

  return fetchDeal(newDealId);
}

async function processActivityEvent(evt) {
  const eventName = String(evt.event || "").toUpperCase();
  if (eventName !== "ONCRMACTIVITYADD") return;
  if (!evt.activityId) {
    console.warn("Bitrix activity event has no activity ID");
    return;
  }

  const hintedProvider = String(evt.activityProviderId || "").toUpperCase();
  const hintedDirection = String(evt.activityDirection || "");
  const hintedOwnerType = String(evt.activityOwnerTypeId || "");

  if (
    hintedProvider &&
    !hintedProvider.includes("EMAIL")
  ) {
    return;
  }

  if (hintedDirection && hintedDirection !== "1") {
    return;
  }

  if (hintedOwnerType && hintedOwnerType !== "2") {
    return;
  }

  try {
    await routeInboundActivity(evt.activityId);
  } catch (error) {
    console.error(JSON.stringify({
      source: "routing",
      action: "activity-routing-error",
      activityId: String(evt.activityId),
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }));
  }
}

async function reconcileTestEmailRouting() {
  try {
    const deal = await fetchDeal(39626);
    const activities = await getRecentDealActivities(deal.ID);

    const candidates = activities
      .filter(isInboundEmailActivity)
      .filter(item => {
        const haystack = [item.subject, item.description]
          .filter(Boolean)
          .join("\n")
          .toUpperCase();
        return (
          haystack.includes("AI WEBHOOK TEST 14") ||
          haystack.includes("AI WEBHOOK TEST 15")
        );
      })
      .sort((a, b) => {
        const ta = Date.parse(a.created || "") || 0;
        const tb = Date.parse(b.created || "") || 0;
        return ta - tb;
      });

    for (const candidate of candidates) {
      await routeInboundActivity(candidate.id);
    }
  } catch (error) {
    console.warn(JSON.stringify({
      source: "routing",
      action: "test-email-routing-reconcile-skipped",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function reprocessCurrentTitleFormatTest() {
  try {
    const deal = await fetchDeal(39710);
    const comments = String(deal.COMMENTS || "");
    const guard =
      String(deal.COMPANY_ID || "") === "3974" &&
      String(deal.CONTACT_ID || "") === "39448" &&
      (
        comments.includes("[AI-ROUTED-ACTIVITY:323688]") ||
        String(deal.TITLE || "").includes("12")
      );

    if (!guard) return;

    await processDeal({
      event: "ONCRMDEALADD",
      dealId: String(deal.ID),
      forceTest: true,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      source: "pipeline",
      action: "title-format-test-reprocess-skipped",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function rollbackMistakenTest16Target() {
  const mistakenDealId = 39706;
  const mistakenCompanyId = 3986;
  const mistakenContactId = 39518;
  const expectedRealSubject = "Запрос коммерческого предложения (Газоанализатор)";

  try {
    const deal = await fetchDeal(mistakenDealId);
    const activities = await getRecentDealActivities(mistakenDealId);
    const inbound = activities.find(isInboundEmailActivity) || null;

    const guard =
      String(deal.TITLE || "").trim() === "AI WEBHOOK TEST 16" &&
      String(deal.COMPANY_ID || "") === String(mistakenCompanyId) &&
      String(deal.CONTACT_ID || "") === String(mistakenContactId) &&
      String(inbound?.subject || "").trim() === expectedRealSubject;

    if (!guard) {
      console.warn(JSON.stringify({
        source: "rollback",
        action: "mistaken-test16-target-not-touched",
        title: deal.TITLE || "",
        companyId: String(deal.COMPANY_ID || ""),
        contactId: String(deal.CONTACT_ID || ""),
        activitySubject: inbound?.subject || "",
      }));
      return;
    }

    const patch = {
      TITLE: expectedRealSubject,
      COMPANY_ID: 0,
      [AI_FIELDS.dealType]: "",
      [AI_FIELDS.dealReason]: "",
      [AI_FIELDS.dealStatus]: "",
      [AI_FIELDS.dealAnswers]: "",
      [AI_FIELDS.dealManufacturer]: "",
      [AI_FIELDS.dealManufacturedProducts]: "",
      [AI_FIELDS.dealServices]: "",
      [AI_FIELDS.dealRoles]: "",
      UF_CRM_1790850696723: "",
    };

    if (String(deal.UF_CRM_1739950675115 || "") === "178") {
      patch.UF_CRM_1739950675115 = "";
    }

    const inn = String(deal.UF_CRM_1789994254952 || "");
    if (
      inn.includes("5190306152") ||
      inn.includes("5106090010") ||
      inn.includes("5111002203")
    ) {
      patch.UF_CRM_1789994254952 = "";
    }

    await updateDealFields(mistakenDealId, patch);

    try {
      const contact = await getContact(mistakenContactId);
      if (String(contact?.COMPANY_ID || "") === String(mistakenCompanyId)) {
        await bitrixCall("crm.contact.update", {
          ID: mistakenContactId,
          fields: { COMPANY_ID: 0 },
        });
      }
    } catch {}

    try {
      const company = await getCompany(mistakenCompanyId);
      if (company) {
        await bitrixCall("crm.company.delete", { id: mistakenCompanyId });
      }
    } catch {}

    console.log(JSON.stringify({
      source: "rollback",
      action: "mistaken-test16-target-restored",
      title: expectedRealSubject,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      source: "rollback",
      action: "mistaken-test16-target-restore-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function cleanupDuplicateRoutingTestDeals() {
  const keepId = "39702";
  const candidates = ["39700", "39704"];

  for (const id of candidates) {
    try {
      const deal = await fetchDeal(id);
      const titleOk = String(deal.TITLE || "").trim() === "AI WEBHOOK TEST 14";
      const comments = String(deal.COMMENTS || "");
      const markerOk =
        comments.includes("[AI-ROUTED-ACTIVITY:323134]") ||
        comments.includes("[AI-ROUTED-ACTIVITY:323552]");
      const companyOk = String(deal.COMPANY_ID || "") === "3974";
      const contactOk = String(deal.CONTACT_ID || "") === "39448";
      const sourceOk = String(deal.SOURCE_ID || "") === "EMAIL";
      const assignedOk = String(deal.ASSIGNED_BY_ID || "") === "130";

      // 39700 and 39704 are known failed TEST14 routing artifacts created by this service.
      // The comment marker may have been rewritten later, so exact ID + title/entities/source
      // is the deletion guard.
      if (!titleOk || !companyOk || !contactOk || !sourceOk || !assignedOk) {
        console.warn(JSON.stringify({
          source: "routing",
          action: "duplicate-test-deal-not-deleted",
          dealId: id,
          titleOk,
          markerOk,
          companyOk,
          contactOk,
          sourceOk,
          assignedOk,
        }));
        continue;
      }

      await bitrixCall("crm.deal.delete", { id: Number(id) });

      console.log(JSON.stringify({
        source: "routing",
        action: "duplicate-test-deal-deleted",
        dealId: id,
        keptDealId: keepId,
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        source: "routing",
        action: "duplicate-test-cleanup-skipped",
        dealId: id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}


function shortCompanyName(value) {
  let name = String(value || "").trim();
  if (!name) return "";

  name = name
    .replace(/^Общество с ограниченной ответственностью\s*/i, "")
    .replace(/^Публичное акционерное общество\s*/i, "")
    .replace(/^Акционерное общество\s*/i, "")
    .replace(/^Закрытое акционерное общество\s*/i, "")
    .replace(/^Открытое акционерное общество\s*/i, "")
    .replace(/^ООО\s*/i, "")
    .replace(/^ПАО\s*/i, "")
    .replace(/^АО\s*/i, "")
    .replace(/^ЗАО\s*/i, "")
    .replace(/^ОАО\s*/i, "")
    .replace(/^ИП\s*/i, "")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return name;
}

function shortenCommonCompanyWords(value) {
  return shortCompanyName(value)
    .replace(/\bМосковский\b/gi, "Моск.")
    .replace(/\bМосковская\b/gi, "Моск.")
    .replace(/\bМосковское\b/gi, "Моск.")
    .replace(/\bнефтеперерабатывающий завод\b/gi, "НПЗ")
    .replace(/\bгазоперерабатывающий завод\b/gi, "ГПЗ")
    .replace(/\bметаллургический завод\b/gi, "МЗ")
    .replace(/\bнаучно-производственное предприятие\b/gi, "НПП")
    .replace(/\bнаучно-производственное объединение\b/gi, "НПО")
    .replace(/\s+/g, " ")
    .trim();
}

function shortDeviceType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";

  if (/стационар/.test(raw)) return "стац.";
  if (/перенос|портатив/.test(raw)) return "порт.";
  if (/персонал|индивидуал/.test(raw)) return "персон.";
  if (/многоканал/.test(raw)) return "многокан.";
  if (/газоанализ/.test(raw)) return "газоан.";

  return String(value || "")
    .trim()
    .replace(/газоанализатор\w*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function gasFormula(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  if (/^[A-Z][A-Za-z]?\d*(?:[A-Z][A-Za-z]?\d*)*$/.test(compact)) {
    return compact;
  }

  const lower = raw.toLowerCase().replace(/ё/g, "е");
  const aliases = [
    [/угарн|монооксид углерод|оксид углерод\b/, "CO"],
    [/углекисл|диоксид углерод/, "CO2"],
    [/сероводород/, "H2S"],
    [/\bметан\b/, "CH4"],
    [/\bпропан\b/, "C3H8"],
    [/\bбутан\b/, "C4H10"],
    [/\bкислород\b/, "O2"],
    [/\bаммиак\b/, "NH3"],
    [/\bхлор\b/, "Cl2"],
    [/\bводород\b/, "H2"],
    [/\bозон\b/, "O3"],
    [/диоксид серы|сернистый газ/, "SO2"],
    [/диоксид азота/, "NO2"],
    [/оксид азота/, "NO"],
    [/\bацетилен\b/, "C2H2"],
    [/\bэтилен\b/, "C2H4"],
    [/\bэтан\b/, "C2H6"],
    [/\bпропилен\b/, "C3H6"],
    [/\bфосфин\b/, "PH3"],
    [/циановодород|синильн/, "HCN"],
    [/фтороводород|фтористый водород/, "HF"],
    [/хлороводород|соляная кислота/, "HCl"],
    [/диоксид хлора/, "ClO2"],
    [/формальдегид/, "CH2O"],
  ];

  for (const [pattern, formula] of aliases) {
    if (pattern.test(lower)) return formula;
  }

  return raw.toUpperCase();
}

function normalizeQuantity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(",", ".") : "";
}

function isDealerForTitle(analysis) {
  const type = String(analysis?.client_type || "").toLowerCase();
  if (type.includes("дилер")) return true;

  return Array.isArray(analysis?.company?.roles) &&
    analysis.company.roles.some(role =>
      String(role || "").toLowerCase().includes("дилер")
    );
}

async function formattedDealTitle(deal, analysis) {
  const parts = analysis?.title_components || {};
  const quantity = normalizeQuantity(parts.quantity);
  const device = shortDeviceType(parts.device_type);

  const gases = Array.from(new Set(
    (Array.isArray(parts.gases) ? parts.gases : [])
      .map(gasFormula)
      .filter(Boolean)
  ));

  let companyName = String(analysis?.company?.name || "").trim();

  if (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0") {
    try {
      const linkedCompany = await getCompany(deal.COMPANY_ID);
      if (linkedCompany?.TITLE) companyName = linkedCompany.TITLE;
    } catch {}
  }

  const companyShort = shortenCommonCompanyWords(companyName) || "компании";
  const endCustomerRaw =
    String(parts.end_customer || "").trim() ||
    String(deal.UF_CRM_1728208529434 || "").trim();

  const endCustomer = isDealerForTitle(analysis) && endCustomerRaw
    ? shortenCommonCompanyWords(endCustomerRaw)
    : "";

  const chunks = [];
  if (quantity) chunks.push(quantity + " шт.");
  if (device) chunks.push(device);
  if (gases.length) chunks.push("на " + gases.join("/"));

  let title = chunks.join(" ").trim();
  if (!title) title = "Приборы";

  title += " для " + companyShort;
  if (endCustomer) title += " (" + endCustomer + ")";

  return title.replace(/\s+/g, " ").trim();
}

function titleComponentsTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "deal_title_components",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          quantity: { type: "string" },
          device_type: { type: "string" },
          gases: {
            type: "array",
            items: { type: "string" }
          },
          end_customer: { type: "string" }
        },
        required: ["quantity", "device_type", "gases", "end_customer"]
      }
    }
  };
}

async function extractTitleComponentsOnly(deal) {
  const activities = await getRecentDealActivities(deal.ID);
  const inbound = activities
    .filter(isInboundEmailActivity)
    .sort((a, b) => {
      const ta = Date.parse(a.created || "") || 0;
      const tb = Date.parse(b.created || "") || 0;
      return ta - tb;
    })
    .map(item => ({
      subject: item.subject,
      body: currentEmailBody(item.description),
      created: item.created,
    }));

  let companyName = "";
  if (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0") {
    try {
      const company = await getCompany(deal.COMPANY_ID);
      companyName = company?.TITLE || "";
    } catch {}
  }

  const payload = await callOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-6-luna",
    store: false,
    max_output_tokens: 700,
    text: titleComponentsTextFormat(),
    instructions: [
      "Извлеки компоненты названия CRM-сделки из текущей коммерческой потребности.",
      "Игнорируй технические метки AI WEBHOOK TEST.",
      "Если последнее письмо лишь досылает документы/реквизиты, используй содержательную потребность из предыдущего письма этой же сделки.",
      "quantity: только количество приборов цифрами, без шт.",
      "device_type: стационарный, портативный, персональный и т.п.; слово переносной нормализуй в портативный.",
      "gases: только химические формулы, например CO, CO2, H2S, CH4, O2, NH3. Не пиши названия газов словами.",
      "end_customer: только явно названный конечный заказчик, иначе пустая строка.",
      "Ничего не выдумывай."
    ].join("\n"),
    input: [{
      role: "user",
      content: JSON.stringify({
        current_title: deal.TITLE || "",
        company: companyName,
        inbound_emails: inbound,
      }),
    }],
  });

  const text = extractResponseText(payload);
  return parseJsonText(text);
}

async function migrateKnownTestDealTitles() {
  const knownTestDeals = [39626, 39702, 39710];

  for (const id of knownTestDeals) {
    try {
      const deal = await fetchDeal(id);
      const activities = await getRecentDealActivities(id);
      const haystack = [
        deal.TITLE,
        deal.COMMENTS,
        ...activities.flatMap(item => [item.subject, item.description]),
      ].filter(Boolean).join("\n").toUpperCase();

      if (!haystack.includes("AI WEBHOOK TEST")) continue;

      const currentTitle = String(deal.TITLE || "").trim();

      // Already in the business naming convention: do not spend another model call.
      if (
        /\bшт\.\b/i.test(currentTitle) &&
        /\sдля\s/i.test(currentTitle) &&
        !currentTitle.toUpperCase().includes("AI WEBHOOK TEST")
      ) {
        continue;
      }

      const titleComponents = await extractTitleComponentsOnly(deal);
      const analysisForTitle = {
        title_components: titleComponents,
        client_type: deal[AI_FIELDS.dealType] || "",
        company: {
          name: "",
          roles: [],
        },
      };

      if (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0") {
        try {
          const company = await getCompany(deal.COMPANY_ID);
          analysisForTitle.company.name = company?.TITLE || "";
          analysisForTitle.company.roles = String(company?.[AI_FIELDS.companyRoles] || "")
            .split(",")
            .map(x => x.trim())
            .filter(Boolean);
        } catch {}
      }

      const title = await formattedDealTitle(deal, analysisForTitle);
      if (title && title !== currentTitle) {
        await updateDealFields(deal.ID, { TITLE: title });
        console.log(JSON.stringify({
          source: "migration",
          action: "test-deal-title-migrated",
          oldTitle: currentTitle,
          newTitle: title,
        }));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        source: "migration",
        action: "test-deal-title-migration-skipped",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function dealerAuditTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "dealer_audit",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          companies: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                company_name: { type: "string" },
                verdict: {
                  type: "string",
                  enum: [
                    "Дилер",
                    "Вероятный дилер",
                    "Не похоже на дилера",
                    "Недостаточно данных"
                  ]
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                rationale: { type: "string" },
                evidence: {
                  type: "array",
                  maxItems: 5,
                  items: { type: "string" }
                },
                mentioned_end_customers: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string" }
                }
              },
              required: [
                "company_name",
                "verdict",
                "confidence",
                "rationale",
                "evidence",
                "mentioned_end_customers"
              ]
            }
          }
        },
        required: ["companies"]
      }
    }
  };
}

async function runSmallDealerAudit() {
  try {
    const pages = [];
    for (const start of [0, 50]) {
      const batch = await bitrixCall("crm.deal.list", {
        order: { DATE_CREATE: "DESC" },
        filter: {},
        select: [
          "ID",
          "TITLE",
          "COMMENTS",
          "ADDITIONAL_INFO",
          "DATE_CREATE",
          "COMPANY_ID",
          "CONTACT_ID",
          "UF_CRM_1739950675115",
          "UF_CRM_1728208529434",
          AI_FIELDS.dealType,
          AI_FIELDS.dealReason
        ],
        start
      });
      if (Array.isArray(batch)) pages.push(...batch);
      if (!Array.isArray(batch) || batch.length < 50) break;
    }

    const byCompany = new Map();

    for (const deal of pages) {
      const companyId = String(deal.COMPANY_ID || "");
      if (!companyId || companyId === "0") continue;

      if (!byCompany.has(companyId)) {
        byCompany.set(companyId, []);
      }

      byCompany.get(companyId).push({
        title: String(deal.TITLE || "").slice(0, 500),
        comments: String(deal.COMMENTS || "").slice(0, 2500),
        additional_info: String(deal.ADDITIONAL_INFO || "").slice(0, 1500),
        end_customer: String(deal.UF_CRM_1728208529434 || "").slice(0, 500),
        legacy_type: String(deal.UF_CRM_1739950675115 || ""),
        ai_type: String(deal[AI_FIELDS.dealType] || ""),
        ai_reason: String(deal[AI_FIELDS.dealReason] || "").slice(0, 800),
        created: deal.DATE_CREATE || null
      });
    }

    const ranked = [...byCompany.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 18);

    const candidates = [];

    for (const [companyId, deals] of ranked) {
      try {
        const company = await getCompany(companyId);
        if (!company) continue;

        const aiType = String(company[AI_FIELDS.companyType] || "").trim();
        const roles = String(company[AI_FIELDS.companyRoles] || "").trim();
        const legacyDealerSeen = deals.some(d => d.legacy_type === "172");
        const alreadyDealer =
          aiType.toLowerCase() === "дилер" ||
          roles.toLowerCase().includes("дилер") ||
          legacyDealerSeen;

        if (alreadyDealer) continue;

        candidates.push({
          company_name: company.TITLE || "",
          existing_ai_type: aiType,
          existing_roles: roles,
          website: Array.isArray(company.WEB)
            ? company.WEB.map(x => x.VALUE).filter(Boolean).slice(0, 3)
            : [],
          recent_deal_count: deals.length,
          recent_deals: deals.slice(0, 8)
        });

        if (candidates.length >= 8) break;
      } catch {}
    }

    if (candidates.length < 4) {
      console.warn(JSON.stringify({
        source: "dealer-audit",
        action: "small-sample-insufficient",
        candidateCount: candidates.length
      }));
      return;
    }

    const payload = await callOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-6-luna",
      store: false,
      max_output_tokens: 3000,
      text: dealerAuditTextFormat(),
      instructions: [
        "Проведи аудит небольшой выборки компаний из CRM производителя промышленных газоанализаторов.",
        "Цель — выявить существующих дилеров, которые исторически не были помечены как дилеры.",
        "Используй только предоставленную историю CRM. Не делай веб-поиск и не выдумывай факты.",
        "Сильные признаки дилера: разные конечные заказчики в разных сделках, запросы 'для заказчика/клиента', регулярные запросы на разное оборудование под разные предприятия, перепродажа, дилерские/партнерские цены, запрос аналога для чужого объекта.",
        "Не считай дилером компанию только потому, что она много раз покупала оборудование или является подрядчиком/интегратором.",
        "Дилер = уверенное подтверждение по истории; Вероятный дилер = несколько косвенных признаков; Недостаточно данных = история не позволяет решить.",
        "В evidence укажи конкретные признаки из названий/комментариев/полей сделок, коротко.",
        "Не меняй CRM. Это только аналитическая выборка для последующей сверки с менеджерами."
      ].join("\n"),
      input: [{
        role: "user",
        content: JSON.stringify({ companies: candidates })
      }]
    });

    const text = extractResponseText(payload);
    const audit = parseJsonText(text);

    console.log(JSON.stringify({
      source: "dealer-audit",
      action: "small-sample-result",
      sampleBasis: "recent linked-company deals, CRM history only",
      companies: audit.companies || []
    }));
  } catch (error) {
    console.error(JSON.stringify({
      source: "dealer-audit",
      action: "small-sample-error",
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}


function contractorBenchmarkTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "contractor_benchmark",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          company_name: { type: "string" },
          inn: { type: "string" },
          website: { type: "string" },
          profile: { type: "string" },
          contractor_type: { type: "string" },
          industries: { type: "array", items: { type: "string" } },
          regions: { type: "array", items: { type: "string" } },
          branches: { type: "array", items: { type: "string" } },
          employee_count: { type: "string" },
          employee_count_year: { type: "string" },
          revenue: { type: "string" },
          revenue_year: { type: "string" },
          key_customers_or_objects: { type: "array", items: { type: "string" } },
          why_interesting_for_topsense: { type: "string" },
          quick_sale_score: { type: "number", minimum: 0, maximum: 100 },
          evidence: { type: "array", maxItems: 8, items: { type: "string" } }
        },
        required: [
          "company_name","inn","website","profile","contractor_type","industries",
          "regions","branches","employee_count","employee_count_year","revenue",
          "revenue_year","key_customers_or_objects","why_interesting_for_topsense",
          "quick_sale_score","evidence"
        ]
      }
    }
  };
}

const CONTRACTOR_SEED_ALIASES = {
  "Сибирская сервисная компания (ССК)": [
    "Сибирская сервисная компания"
  ],
};

const CONTRACTOR_SEED_EXCLUSIONS = {};

const CONTRACTOR_SEED_DOMAINS = {
  "Сибирская сервисная компания (ССК)": [
    "sibserv.com",
    "ssc.djiggo.ru"
  ],
};

function benchmarkSearchTerms(term) {
  return CONTRACTOR_SEED_ALIASES[term] || [term];
}

function benchmarkCandidateAllowed(seed, company) {
  const title = String(company?.TITLE || "").trim().toLowerCase();
  const exclusions = CONTRACTOR_SEED_EXCLUSIONS[seed] || [];
  return !exclusions.some(value => title.includes(String(value).toLowerCase()));
}

async function findBenchmarkCompanyCandidates(term) {
  const seen = new Set();
  const out = [];
  const searchTerms = benchmarkSearchTerms(term);

  for (const searchTerm of searchTerms) {
    try {
      const companies = await bitrixCall("crm.company.list", {
        order: { ID: "DESC" },
        filter: { "%TITLE": searchTerm },
        select: [
          "ID","TITLE","WEB","PHONE","EMAIL",
          AI_FIELDS.companyInn,
          AI_FIELDS.companyType,
          AI_FIELDS.companyRoles,
          AI_FIELDS.companyRevenue,
          AI_FIELDS.companyRevenueYear
        ],
        start: 0
      });

      for (const company of Array.isArray(companies) ? companies.slice(0, 12) : []) {
        const id = String(company.ID || "");
        if (!id || seen.has(id) || !benchmarkCandidateAllowed(term, company)) continue;
        seen.add(id);
        out.push(company);
      }
    } catch {}

    try {
      const deals = await bitrixCall("crm.deal.list", {
        order: { ID: "DESC" },
        filter: { "%TITLE": searchTerm },
        select: ["ID","TITLE","COMPANY_ID","CONTACT_ID","DATE_CREATE"],
        start: 0
      });

      for (const deal of Array.isArray(deals) ? deals.slice(0, 20) : []) {
        const companyId = String(deal.COMPANY_ID || "");
        if (!companyId || companyId === "0" || seen.has(companyId)) continue;
        try {
          const company = await getCompany(companyId);
          if (!company || !benchmarkCandidateAllowed(term, company)) continue;
          seen.add(companyId);
          out.push(company);
        } catch {}
      }
    } catch {}
  }


  const domains = CONTRACTOR_SEED_DOMAINS[term] || [];
  for (const domain of domains) {
    try {
      const companiesByWeb = await bitrixCall("crm.company.list", {
        order: { ID: "DESC" },
        filter: { "%WEB": domain },
        select: [
          "ID","TITLE","WEB","PHONE","EMAIL",
          AI_FIELDS.companyInn,
          AI_FIELDS.companyType,
          AI_FIELDS.companyRoles,
          AI_FIELDS.companyRevenue,
          AI_FIELDS.companyRevenueYear
        ],
        start: 0
      });

      for (const company of Array.isArray(companiesByWeb) ? companiesByWeb : []) {
        const id = String(company.ID || "");
        if (!id || seen.has(id) || !benchmarkCandidateAllowed(term, company)) continue;
        seen.add(id);
        out.push(company);
      }
    } catch {}

    try {
      const contactsByEmail = await bitrixCall("crm.contact.list", {
        order: { ID: "DESC" },
        filter: { "%EMAIL": domain },
        select: ["ID","COMPANY_ID","EMAIL"],
        start: 0
      });

      for (const contact of Array.isArray(contactsByEmail) ? contactsByEmail : []) {
        const companyId = String(contact.COMPANY_ID || "");
        if (!companyId || companyId === "0" || seen.has(companyId)) continue;
        try {
          const company = await getCompany(companyId);
          if (!company || !benchmarkCandidateAllowed(term, company)) continue;
          seen.add(companyId);
          out.push(company);
        } catch {}
      }
    } catch {}
  }

  return out.slice(0, 12);
}

async function profileBenchmarkCompany(seedLabel, company) {
  const inn = String(company?.[AI_FIELDS.companyInn] || "").trim();
  const websites = Array.isArray(company?.WEB)
    ? company.WEB.map(x => x.VALUE).filter(Boolean)
    : [];
  const website = websites[0] || "";

  if (!inn && !website) {
    return {
      seed: seedLabel,
      matched_company: company?.TITLE || "",
      status: "needs-disambiguation",
      reason: "В CRM нет ИНН и сайта; веб-поиск по одному названию может спутать компанию."
    };
  }

  const payload = await callOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-6-luna",
    store: false,
    max_output_tokens: 2200,
    text: contractorBenchmarkTextFormat(),
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    instructions: [
      "Ты анализируешь эталонную подрядную организацию для российского производителя промышленных газоанализаторов ТОП-СЕНС.",
      "Идентифицируй компанию строго по ИНН и/или официальному сайту из CRM. Не подменяй её одноимённой компанией.",
      "Определи, чем она занимается как подрядчик: строительство, монтаж, бурение, нефтесервис, остановочные ремонты, леса/изоляция, промышленный сервис и т.п.",
      "Найди отрасли и типы объектов, географию, филиалы/подразделения, численность сотрудников если есть надёжный открытый источник, последнюю выручку если доступна, а также известных заказчиков/объекты только по публичным источникам.",
      "Оцени quick_sale_score 0-100 именно по привлекательности для ТОП-СЕНС: быстрые прямые закупки, работа на опасных объектах, мобильные бригады, потребность в переносных/стационарных газоанализаторах, отсутствие необходимости долгого тендерного цикла повышают оценку.",
      "Если показатель не подтверждён, оставляй пустую строку/массив. Не выдумывай.",
      "В evidence кратко укажи подтверждающие факты и источники/годы."
    ].join("\n"),
    input: [{
      role: "user",
      content: JSON.stringify({
        seed_label: seedLabel,
        canonical_note: seedLabel === "Сибирская сервисная компания (ССК)"
          ? "ССК означает Сибирская сервисная компания. Идентифицируй по полному названию и известным корпоративным доменам."
          : "",
        crm_company_name: company?.TITLE || "",
        inn,
        website
      })
    }]
  });

  const text = extractResponseText(payload);
  return {
    seed: seedLabel,
    matched_company: company?.TITLE || "",
    status: "profiled",
    profile: parseJsonText(text)
  };
}

async function runContractorBenchmarkPilot() {
  const seeds = CONTRACTOR_BASELINE_RESULTS.map(item => item.seed);

  const results = [];

  DASHBOARD_STATE.contractorBenchmark = {
    status: "running",
    total: seeds.length,
    completed: 0,
    current: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  for (const seed of seeds) {
    DASHBOARD_STATE.contractorBenchmark.current = seed;
    try {
      const candidates = await findBenchmarkCompanyCandidates(seed);

      if (!candidates.length) {
        results.push({
          seed,
          status: "not-found-in-crm"
        });
        DASHBOARD_STATE.contractorBenchmark.completed = results.length;
        DASHBOARD_STATE.contractorBenchmark.results = results.slice();
        continue;
      }

      let chosen = candidates[0];

      // Prefer candidates with exact identity fields.
      const identified = candidates.find(company =>
        String(company?.[AI_FIELDS.companyInn] || "").trim() ||
        (Array.isArray(company?.WEB) && company.WEB.some(x => String(x.VALUE || "").trim()))
      );
      if (identified) chosen = identified;

      const profiled = await profileBenchmarkCompany(seed, chosen);
      results.push(profiled);
      DASHBOARD_STATE.contractorBenchmark.completed = results.length;
      DASHBOARD_STATE.contractorBenchmark.results = results.slice();
    } catch (error) {
      results.push({
        seed,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
      DASHBOARD_STATE.lastError = {
        at: new Date().toISOString(),
        source: "contractor-benchmark",
        message: error instanceof Error ? error.message : String(error),
      };
      DASHBOARD_STATE.contractorBenchmark.completed = results.length;
      DASHBOARD_STATE.contractorBenchmark.results = results.slice();
    }
  }

  DASHBOARD_STATE.contractorBenchmark.status = "completed";
  DASHBOARD_STATE.contractorBenchmark.current = "";
  DASHBOARD_STATE.contractorBenchmark.finishedAt = new Date().toISOString();
  DASHBOARD_STATE.contractorBenchmark.results = results.slice();

  console.log(JSON.stringify({
    source: "contractor-benchmark",
    action: "pilot-result",
    results
  }));
}

async function handleQualificationAnswersUpdate(deal) {
  const fieldText = String(deal.UF_CRM_1790850696723 || "");
  const blocks = parseQuestionBlocks(fieldText);

  // Only take over deals that already contain the AI manager-question structure.
  if (!blocks.length || !fieldText.includes("Ответ:")) return false;

  const answeredBlocks = blocks.filter(item =>
    isMeaningfulManagerAnswer(item.answer)
  );

  const total = blocks.length;
  const answered = answeredBlocks.length;
  const remaining = Math.max(0, total - answered);
  const status = remaining === 0
    ? "Квалифицировано"
    : "Нужно уточнить: " + remaining;

  const answers = answeredBlocks.map(item => ({
    question: item.question,
    answer: item.answer,
  }));

  const patch = {};

  if (String(deal[AI_FIELDS.dealStatus] || "") !== status) {
    patch[AI_FIELDS.dealStatus] = status;
  }

  const history = answerHistoryText(
    deal[AI_FIELDS.dealAnswers],
    answers
  );

  if (
    history &&
    String(deal[AI_FIELDS.dealAnswers] || "") !== history
  ) {
    patch[AI_FIELDS.dealAnswers] = history;
  }

  Object.assign(patch, answerFieldPatch(answers));

  if (Object.keys(patch).length) {
    await updateDealFields(deal.ID, patch);
  }

  console.log(JSON.stringify({
    source: "qualification-control",
    action: "manager-answers-checked",
    dealTitle: deal.TITLE || "",
    answered,
    total,
    remaining,
    status,
  }));

  return true;
}

async function processDeal(evt) {
  const eventName = String(evt.event || "").toUpperCase();
  const isAdd = eventName === "ONCRMDEALADD";
  const isUpdate = eventName === "ONCRMDEALUPDATE";

  if (!isAdd && !isUpdate) return;

  if (!evt.dealId) {
    console.warn("Bitrix event has no deal ID");
    return;
  }

  const dealId = String(evt.dealId);

  if (isUpdate) {
    const selfUpdatedAt = SELF_UPDATES.get(dealId) || 0;
    if (Date.now() - selfUpdatedAt < 30000) {
      console.log(JSON.stringify({
        source: "bitrix24",
        action: "self-update-skipped",
        dealId,
      }));
      return;
    }
  }

  try {
    let deal = await fetchDeal(evt.dealId);

    console.log(
      JSON.stringify({
        source: "bitrix24",
        action: "deal-read-ok",
        event: eventName,
        dealId: String(deal.ID),
        categoryId: deal.CATEGORY_ID || null,
        stageId: deal.STAGE_ID || null,
        assignedById: deal.ASSIGNED_BY_ID || null,
        companyLinked: Boolean(deal.COMPANY_ID && deal.COMPANY_ID !== "0"),
        contactLinked: Boolean(deal.CONTACT_ID && deal.CONTACT_ID !== "0"),
        sourceId: deal.SOURCE_ID || null,
        opportunity: deal.OPPORTUNITY || null,
        readAt: new Date().toISOString(),
      })
    );

    if (isUpdate) {
      const handled = await handleQualificationAnswersUpdate(deal);
      if (handled) return;
    }


    const testHaystack = [
      deal.TITLE,
      deal.COMMENTS,
      deal.ADDITIONAL_INFO,
    ]
      .filter(Boolean)
      .join("\n")
      .toUpperCase();

    let testActivity = null;
    let isTestDeal = Boolean(evt.forceTest) || testHaystack.includes("AI WEBHOOK TEST");

    if (!isTestDeal && String(deal.SOURCE_ID || "").toUpperCase() === "EMAIL") {
      const recentActivities = await getRecentDealActivities(deal.ID);
      testActivity = recentActivities.find(item => {
        if (!isInboundEmailActivity(item)) return false;
        const haystack = [item.subject, item.description]
          .filter(Boolean)
          .join("\n")
          .toUpperCase();
        return haystack.includes("AI WEBHOOK TEST");
      }) || null;

      isTestDeal = Boolean(testActivity);
    }

    // Until the test contour is approved, do not enrich or modify real deals.
    if (!isTestDeal) {
      console.log(JSON.stringify({
        source: "pipeline",
        action: "non-test-deal-skipped",
        dealId: String(deal.ID),
      }));
      return;
    }

    if (testActivity) {
      const emailBody = currentEmailBody(testActivity.description);
      const patch = {};

      if (testActivity.subject && String(deal.TITLE || "").trim() !== String(testActivity.subject).trim()) {
        patch.TITLE = String(testActivity.subject).trim();
      }

      const currentComments = String(deal.COMMENTS || "").trim();
      if (emailBody && !currentComments.includes(emailBody)) {
        patch.COMMENTS = currentComments
          ? currentComments + "\r\n\r\n" + emailBody
          : emailBody;
      }

      if (Object.keys(patch).length) {
        await updateDealFields(deal.ID, patch);
        deal = await fetchDeal(deal.ID);

        console.log(JSON.stringify({
          source: "bitrix24",
          action: "fresh-email-deal-synced",
          dealId: String(deal.ID),
          title: deal.TITLE || "",
          commentsUpdated: Boolean(patch.COMMENTS),
        }));
      }
    }

    await ensureAIFields();
    await ensureMultilineDealField("UF_CRM_1790850696723");

    // Re-read after possible custom-field creation so new fields are present.
    // Do not merge later inbound emails into an existing deal here:
    // a separate commercial need must first be routed as same-deal vs new-deal.
    deal = await fetchDeal(evt.dealId);

    const answers = parseQuestionAnswers(deal.UF_CRM_1790850696723);

    const result = await analyzeDeal(deal, true);

    console.log(
      JSON.stringify({
        source: "openai",
        action: "ai-analysis-ok",
        dealId: String(deal.ID),
        model: result.model,
        responseId: result.responseId,
        clientType: result.analysis?.client_type || null,
        confidence: result.analysis?.confidence ?? null,
        questionCount: Array.isArray(result.analysis?.context_questions) && result.analysis.context_questions.length
          ? result.analysis.context_questions.length
          : (Array.isArray(result.analysis?.question_keys)
              ? result.analysis.question_keys.length
              : 0),
        webUsed: result.webUsed,
        webSourceCount: result.webSources.length,
        analyzedAt: new Date().toISOString(),
      })
    );

    const analyzedTitle = await formattedDealTitle(deal, result.analysis);
    if (
      analyzedTitle &&
      analyzedTitle !== String(deal.TITLE || "").trim()
    ) {
      await updateDealFields(deal.ID, { TITLE: analyzedTitle });
      deal = await fetchDeal(deal.ID);
      console.log(JSON.stringify({
        source: "bitrix24",
        action: "deal-title-updated-from-need",
        dealTitle: analyzedTitle,
      }));
    }

    const company = await upsertCompany(deal, result.analysis);
    const contact = await upsertContact(deal, result.analysis, company);

    await linkDealEntities(deal, company, contact);

    // Refresh deal after linking so we only fill still-empty fields.
    deal = await fetchDeal(evt.dealId);

    const aiPatch = await writeDealAIFields(deal, result.analysis, answers);
    await updateDealFields(deal.ID, aiPatch);

    const workingText = formatManagerQuestions(result.analysis);
    if (String(deal.UF_CRM_1790850696723 || "") !== workingText) {
      await updateDealFields(deal.ID, {
        UF_CRM_1790850696723: workingText,
      });
    }

    await createQualificationActivity(deal, result.analysis);

    console.log(
      JSON.stringify({
        source: "pipeline",
        action: "test-pipeline-ok",
        dealId: String(deal.ID),
        companyId: company?.ID ? String(company.ID) : null,
        contactId: contact?.ID ? String(contact.ID) : null,
        answersCaptured: answers.length,
        qualificationStatus: qualificationStatus(result.analysis),
        at: new Date().toISOString(),
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "pipeline",
        action: "deal-processing-error",
        dealId,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      })
    );
  }
}



const CONTRACTOR_SCAN_CANDIDATES = new Map();
const PERSISTED_CONTRACTORS = new Map();
const PERSISTED_COMPANY_TYPES = new Map();
const PERSISTED_PENDING_COMPANIES = new Map();
const CONTRACTOR_SCAN_COMPANY_CACHE = new Map();
let CONTRACTOR_SCAN_RUNNING = false;
let CONTRACTOR_SCAN_TIMER = null;

function contractorScanPaused() {
  return String(process.env.CONTRACTOR_SCAN_PAUSED || "").trim() === "1";
}

function openAiPaused() {
  return String(process.env.OPENAI_PAUSED || "").trim() === "1";
}

function dailyContractorScanEnabled() {
  return String(process.env.DAILY_CONTRACTOR_SCAN_ENABLED || "").trim() === "1";
}

function asText(value) {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(asText).filter(Boolean).join(" ");
  return String(value || "");
}

function dealContractorSignals(deal) {
  const reasons = [];
  let weight = 0;
  let managerHint = false;

  const legacyType = asText(deal.UF_CRM_1739950675115);
  const legacyWho = asText(deal.UF_CRM_1728208341819);
  const aiType = asText(deal[AI_FIELDS.dealType]);
  const aiRoles = asText(deal[AI_FIELDS.dealRoles]);

  if (/(^|\D)180(\D|$)/.test(legacyType) || /(^|\D)60(\D|$)/.test(legacyWho)) {
    managerHint = true;
    reasons.push("CRM-подсказка: подрядчик (не доказательство)");
  }
  if (/(^|\D)182(\D|$)/.test(legacyType) || /(^|\D)196(\D|$)/.test(legacyWho)) {
    managerHint = true;
    reasons.push("CRM-подсказка: сервисная компания (не доказательство)");
  }
  if (/подряд|генподряд|\bepc\b|сервисн|интегратор|кипиа|асу\s*тп/i.test(aiType + " " + aiRoles)) {
    managerHint = true;
    reasons.push("CRM/AI-подсказка по роли (не доказательство)");
  }

  const haystack = [
    deal.TITLE, deal.COMMENTS, deal.ADDITIONAL_INFO
  ].filter(Boolean).join(" ").toLowerCase();

  const groups = [
    [/подряд|генподряд|субподряд/i, "в истории есть упоминание подрядных работ"],
    [/нефтесервис|бурен|буров|скважин/i, "в истории есть нефтесервис/бурение"],
    [/монтаж|пусконалад|\bпнр\b|\bсмр\b/i, "в истории есть монтаж/ПНР/СМР"],
    [/капитальн.{0,12}ремонт|ремонт.{0,20}(нпз|завод|труб|резервуар|оборуд)/i, "в истории есть промышленный ремонт"],
    [/кипиа|асу\s*тп|автоматизац/i, "в истории есть КИПиА/АСУ ТП"],
    [/изоляц|строительн.{0,12}лес/i, "в истории есть изоляция/леса"],
    [/опасн.{0,12}производ|газоопас|нефтехим|нефтеперераб/i, "в истории есть ОПО/нефтехимия"]
  ];

  for (const [rx, label] of groups) {
    if (rx.test(haystack)) {
      weight += 1;
      reasons.push(label);
    }
  }

  return {
    isCandidate: managerHint || weight >= 1,
    weight,
    managerHint,
    reasons: [...new Set(reasons)].slice(0, 6)
  };
}

function purchaseSignals(deal) {
  const raw = asText(deal.UF_CRM_1728208250222);
  return {
    direct: /(^|\D)50(\D|$)/.test(raw),
    tender: /(^|\D)(48|52)(\D|$)/.test(raw),
  };
}

function dateMs(value) {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function contractorCrmActivityScore(item) {
  let score = 10;

  score += Math.min(20, Number(item.dealCount || 0) * 4);
  if (Number(item.wonOpportunity || 0) > 0) score += 20;
  if (Number(item.openDeals || 0) > 0) score += 20;
  if (Number(item.directCount || 0) > 0) score += 10;
  if (Number(item.directCount || 0) === 0 && Number(item.tenderCount || 0) > 0) score -= 5;

  const ageDays = item.lastActivityMs
    ? (Date.now() - item.lastActivityMs) / 86400000
    : 9999;

  if (ageDays <= 90) score += 20;
  else if (ageDays <= 180) score += 15;
  else if (ageDays <= 365) score += 10;
  else if (ageDays <= 730) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}


function contractorStrategicScore(item) {
  if (item.verificationStatus !== "confirmed") return 0;

  const relevance = String(item.industrialRelevance || "").toLowerCase();
  const gasNeed = String(item.gasDetectionNeed || "").toLowerCase();
  const scale = String(item.scaleLevel || "").toLowerCase();
  const works = Array.isArray(item.relevantWorkTypes) ? item.relevantWorkTypes : [];

  let score = relevance === "high" ? 45
    : relevance === "medium" ? 25
      : relevance === "low" ? 5
        : 10;

  if (item.hazardousIndustrialSites) score += 20;
  score += Math.min(15, works.length * 5);

  if (scale === "large") score += 10;
  else if (scale === "medium") score += 5;

  if (gasNeed === "high") score += 10;
  else if (gasNeed === "medium") score += 5;

  // A company with low industrial relevance and no work on hazardous sites
  // must not outrank major industrial contractors just because CRM is active.
  if (relevance === "low" && !item.hazardousIndustrialSites) {
    score = Math.min(score, 25);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function contractorPotentialScore(item) {
  if (item.verificationStatus !== "confirmed") return 0;

  const strategic = contractorStrategicScore(item);
  const crm = contractorCrmActivityScore(item);

  // Overall priority should not punish a strategically valuable contractor
  // just because there is little recent CRM activity.
  if (strategic > 0) {
    return Math.max(0, Math.min(100, Math.round(strategic * 0.7 + crm * 0.3)));
  }

  return crm;
}

function publicCandidate(item) {
  const purchaseMode = item.directCount > 0 && item.tenderCount > 0
    ? "Смешанный"
    : item.directCount > 0
      ? "Прямая закупка"
      : item.tenderCount > 0
        ? "Тендер/торги"
        : "Неизвестно";

  const verifiedEvidence = [
    item.verificationReason,
    item.websiteEvidence,
    item.correspondenceEvidence,
  ].filter(Boolean);

  return {
    companyId: item.companyId,
    company: item.company || "",
    score: contractorPotentialScore(item),
    verificationStatus: item.verificationStatus || "pending",
    verificationConfidence: Number(item.verificationConfidence || 0),
    contractorType: item.contractorType || "",
    strategicScore: contractorStrategicScore(item),
    strategicReason: item.strategicReason || "",
    industrialRelevance: item.industrialRelevance || "",
    hazardousIndustrialSites: Boolean(item.hazardousIndustrialSites),
    relevantWorkTypes: Array.isArray(item.relevantWorkTypes) ? item.relevantWorkTypes : [],
    scaleLevel: item.scaleLevel || "",
    gasDetectionNeed: item.gasDetectionNeed || "",
    crmActivityScore: contractorCrmActivityScore(item),
    inn: item.verifiedInn || "",
    website: item.verifiedWebsite || "",
    purchasedProducts: Array.isArray(item.purchasedProducts)
      ? item.purchasedProducts.slice(0, 12)
      : [],
    dealCount: item.dealCount || 0,
    openDeals: item.openDeals || 0,
    totalOpportunity: Math.round(Number(item.totalOpportunity || 0)),
    wonOpportunity: Math.round(Number(item.wonOpportunity || 0)),
    openOpportunity: Math.round(Number(item.openOpportunity || 0)),
    lostOpportunity: Math.round(Number(item.lostOpportunity || 0)),
    unclassifiedOpportunity: Math.round(Number(item.unclassifiedOpportunity || 0)),
    lastActivity: item.lastActivity || "",
    purchaseMode,
    managers: [...(item.managers || new Set())].slice(0, 5),
    managerNames: item.managerNames instanceof Map
      ? [...item.managerNames.values()].filter(Boolean).slice(0, 8)
      : [],
    currentWork: Array.isArray(item.currentWork) ? item.currentWork.slice(0, 8) : [],
    relationshipStatus: item.relationshipStatus || "",
    managerQualityScore: Number(item.managerQualityScore || 0),
    managerQualityLevel: item.managerQualityLevel || "",
    managerQualitySummary: item.managerQualitySummary || "",
    managerQualificationScore: Number(item.managerQualificationScore || 0),
    managerQualificationSummary: item.managerQualificationSummary || "",
    managerProcessIssue: item.managerProcessIssue || "",
    evidence: verifiedEvidence.slice(0, 5),
    sampleDeals: (item.sampleDeals || []).slice(0, 4),
  };
}

async function contractorCompanyName(companyId) {
  if (!companyId || companyId === "0") return "";
  if (CONTRACTOR_SCAN_COMPANY_CACHE.has(companyId)) {
    return CONTRACTOR_SCAN_COMPANY_CACHE.get(companyId);
  }

  let title = "";
  try {
    const company = await getCompany(companyId);
    title = String(company?.TITLE || "");
  } catch {}

  CONTRACTOR_SCAN_COMPANY_CACHE.set(companyId, title);
  return title;
}


const CONTRACTOR_VERIFY_COMPANY_CACHE = new Map();
const CONTRACTOR_VERIFICATION_CACHE = new Map();

async function contractorCompanyForVerification(companyId) {
  if (!companyId || companyId === "0") return null;
  if (CONTRACTOR_VERIFY_COMPANY_CACHE.has(companyId)) {
    return CONTRACTOR_VERIFY_COMPANY_CACHE.get(companyId);
  }
  let company = null;
  try { company = await getCompany(companyId); } catch {}
  CONTRACTOR_VERIFY_COMPANY_CACHE.set(companyId, company);
  return company;
}

function contractorCompanyDomain(company) {
  const web = Array.isArray(company?.WEB) ? company.WEB : [];
  for (const item of web) {
    let value = String(item?.VALUE || "").trim();
    if (!value) continue;
    try {
      if (!/^https?:\/\//i.test(value)) value = "https://" + value;
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
      if (host) return host;
    } catch {}
  }

  const emails = Array.isArray(company?.EMAIL) ? company.EMAIL : [];
  for (const item of emails) {
    const domain = emailDomain(item?.VALUE || "");
    if (isCorporateDomain(domain)) return domain.replace(/^www\./, "");
  }
  return "";
}

async function contractorCompanyInn(companyId, company) {
  const stored = String(company?.[AI_FIELDS.companyInn] || "").replace(/\D/g, "");
  if (stored.length === 10 || stored.length === 12) return stored;

  try {
    const rows = await bitrixCall("crm.requisite.list", {
      order: { ID: "ASC" },
      filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: Number(companyId) },
      select: ["ID", "RQ_INN", "RQ_KPP", "NAME"],
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      const inn = String(row.RQ_INN || "").replace(/\D/g, "");
      if (inn.length === 10 || inn.length === 12) return inn;
    }
  } catch (error) {
    console.warn(JSON.stringify({
      source: "contractor-verification",
      action: "requisite-read-failed",
      companyId: String(companyId),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return "";
}

function contractorVerificationFormat() {
  return {
    format: {
      type: "json_schema",
      name: "contractor_verification",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["confirmed", "not_contractor", "unclear"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          contractor_type: { type: "string" },
          reason: { type: "string" },
          strategic_score: { type: "number", minimum: 0, maximum: 100 },
          strategic_reason: { type: "string" },
          industrial_relevance: { type: "string", enum: ["high", "medium", "low", "unknown"] },
          hazardous_industrial_sites: { type: "boolean" },
          relevant_work_types: { type: "array", items: { type: "string" }, maxItems: 8 },
          scale_level: { type: "string", enum: ["large", "medium", "small", "unknown"] },
          gas_detection_need: { type: "string", enum: ["high", "medium", "low", "unknown"] },
          identity_evidence: { type: "string" },
          website_evidence: { type: "string" },
          correspondence_evidence: { type: "string" }
        },
        required: [
          "status","confidence","contractor_type","reason",
          "strategic_score","strategic_reason",
          "industrial_relevance","hazardous_industrial_sites","relevant_work_types","scale_level","gas_detection_need",
          "identity_evidence","website_evidence","correspondence_evidence"
        ]
      }
    }
  };
}

async function contractorCorrespondence(item) {
  const result = [];
  for (const deal of (item.sampleDealContexts || []).slice(0, 2)) {
    try {
      const activities = await getRecentDealActivities(deal.id);
      for (const activity of activities.slice(0, 6)) {
        const subject = String(activity.subject || "").trim();
        const description = String(activity.description || "").trim();
        if (!subject && !description) continue;
        result.push({
          deal_title: deal.title || "",
          direction: String(activity.direction || ""),
          provider: String(activity.provider_id || ""),
          subject: subject.slice(0, 500),
          text: description.slice(0, 5000),
          created: activity.created || null,
        });
        if (result.length >= 10) return result;
      }
    } catch {}
  }
  return result;
}

async function persistedClassificationForItem(item) {
  const companyId = String(item?.companyId || "").trim();

  if (companyId) {
    const byId = PERSISTED_COMPANY_TYPES.get("b24:" + companyId);
    if (byId) return byId;
  }

  let company = null;
  try { company = await contractorCompanyForVerification(companyId); } catch {}
  if (!company) return null;

  const inn = await contractorCompanyInn(companyId, company);
  const domain = contractorCompanyDomain(company);

  if (inn) {
    const byInn = PERSISTED_COMPANY_TYPES.get("inn:" + inn);
    if (byInn) return byInn;
  }

  if (domain) {
    const bySite = PERSISTED_COMPANY_TYPES.get("site:" + domain);
    if (bySite) return bySite;
  }

  return null;
}

function applyPersistedClassification(item, row) {
  if (!item || !row) return;

  item.verificationStatus = row.verificationStatus || item.verificationStatus;
  item.verificationConfidence = Number(row.verificationConfidence || 0);
  item.contractorType = row.contractorType || "";
  item.strategicScore = Number(row.strategicScore || 0);
  item.strategicReason = row.strategicReason || "";
  item.industrialRelevance = row.industrialRelevance || "unknown";
  item.hazardousIndustrialSites = Boolean(row.hazardousIndustrialSites);
  item.relevantWorkTypes = Array.isArray(row.relevantWorkTypes) ? row.relevantWorkTypes : [];
  item.scaleLevel = row.scaleLevel || "unknown";
  item.gasDetectionNeed = row.gasDetectionNeed || "unknown";
  item.verificationReason = Array.isArray(row.evidence) ? (row.evidence[0] || "") : "";
  item.verifiedInn = row.inn || "";
  item.verifiedWebsite = row.website || "";

  console.log(JSON.stringify({
    source: "contractor-store",
    action: "classification-reused",
    companyId: String(item.companyId || ""),
    company: item.company || row.company || "",
    verificationStatus: item.verificationStatus,
  }));
}

async function verifyContractorCompany(item) {
  const persisted = await persistedClassificationForItem(item);
  if (persisted) {
    applyPersistedClassification(item, persisted);
    return;
  }

  const cached = CONTRACTOR_VERIFICATION_CACHE.get(item.companyId);
  if (cached && Date.now() - cached.checkedAt < 12 * 60 * 60 * 1000) {
    Object.assign(item, cached.result);
    return;
  }

  item.verificationStatus = "checking";
  const company = await contractorCompanyForVerification(item.companyId);
  if (!company) {
    item.verificationStatus = "unclear";
    item.verificationReason = "Карточка компании в Bitrix24 не читается.";
    return;
  }

  item.company = String(company.TITLE || item.company || "");
  const inn = await contractorCompanyInn(item.companyId, company);
  const domain = contractorCompanyDomain(company);

  let website = null;
  if (domain) {
    try { website = await fetchDomainWebsite(domain); } catch {}
  }

  if (!inn && !domain) {
    const result = {
      verificationStatus: "unclear",
      verificationConfidence: 0,
      contractorType: "",
      strategicScore: 0,
      strategicReason: "",
      industrialRelevance: "unknown",
      hazardousIndustrialSites: false,
      relevantWorkTypes: [],
      scaleLevel: "unknown",
      gasDetectionNeed: "unknown",
      verificationReason: "Нет подтверждённого ИНН и официального корпоративного домена. Тип компании в B24 не считается доказательством.",
      identityEvidence: "",
      websiteEvidence: "",
      correspondenceEvidence: "",
      verifiedInn: "",
      verifiedWebsite: "",
    };
    Object.assign(item, result);
    CONTRACTOR_VERIFICATION_CACHE.set(item.companyId, { checkedAt: Date.now(), result });
    return;
  }

  // Strict order requested by the user: identity/site first, B24 correspondence second.
  const correspondence = await contractorCorrespondence(item);

  const response = await callOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-6-luna",
    store: false,
    max_output_tokens: 1400,
    text: contractorVerificationFormat(),
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: [
      "Определи, является ли компания промышленным подрядчиком или реальной сервисной организацией.",
      "Поля Bitrix24 «тип компании», «подрядчик», «сервисная компания», AI-роли и мнение менеджера могут быть ошибочными. Никогда не используй их как доказательство.",
      "Порядок строгий: сначала идентифицируй юрлицо по ИНН и/или официальному домену; затем проверь официальный сайт и связанные с тем же ИНН/доменом надёжные открытые источники; только после этого используй реальную переписку B24 как дополнительное подтверждение.",
      "Подтверждай подрядчика только если компания сама выполняет работы/услуги для заказчиков на их объектах: строительство, монтаж, ПНР/СМР, промышленный ремонт/ТО, бурение/нефтесервис, работы на ОПО, КИПиА/АСУ ТП-интеграцию, промышленную очистку, ремонт резервуаров/трубопроводов, монтаж лесов/изоляции и подобные услуги.",
      "Производитель, завод, конечный пользователь, дилер, поставщик или продавец не становится подрядчиком из-за слов «монтаж», «КИПиА», «ремонт» в сделке или CRM.",
      "Если сайт показывает только поставки/продажи/производство и нет явных работ на объектах заказчиков — status=not_contractor.",
      "Если идентичность или деятельность недостаточно подтверждена — status=unclear. Не угадывай.",
      "Для status=confirmed требуется содержательное внешнее подтверждение подрядной/сервисной деятельности, а не поле CRM.",
      "Отдельно оцени strategic_score 0-100 — стратегическую привлекательность компании для продаж ТОП-СЕНС независимо от текущей активности в CRM.",
      "Для strategic_score учитывай: масштаб компании и географию работ; число/класс промышленных объектов и проектов; работу на нефтегазовых, нефтеперерабатывающих, химических, металлургических и других ОПО; наличие строительно-монтажных, пусконаладочных, ремонтных, сервисных, EPC/EPCm работ; вероятность регулярной потребности в переносных/стационарных газоанализаторах для собственных бригад и объектов.",
      "Крупный многопрофильный промышленный подрядчик с большим числом проектов и работами на ОПО должен иметь высокий strategic_score даже если в Bitrix24 мало недавних сделок.",
      "Компании ЖКХ, благоустройства, озеленения, санитарной обработки, клининга, обычного строительства без подтверждённых работ на ОПО или промышленного сервиса должны иметь industrial_relevance=low и низкий strategic_score, даже если у них много активности в CRM.",
      "industrial_relevance=high ставь только когда профиль напрямую связан с промышленными объектами/ОПО и релевантными подрядными работами.",
      "hazardous_industrial_sites=true только при подтверждении работы на нефтегазовых, НПЗ/НХЗ, химических, металлургических, горнодобывающих, энергетических или иных опасных производственных объектах.",
      "relevant_work_types перечисли подтверждённые типы работ: СМР, ПНР, EPC/EPCm, ремонт, обслуживание, бурение, КИПиА/АСУ ТП, изоляция/леса и т.п.",
      "gas_detection_need=high ставь, если по профилю работ у собственных бригад/объектов регулярно вероятна потребность в газоанализаторах; medium — если потребность возможна, но не системна.",
      "Не повышай strategic_score только за известность бренда: нужны подтверждённые факты о масштабе и релевантных работах.",
      "strategic_reason — краткое объяснение оценки на основании внешних фактов.",
      "website_evidence: конкретный факт с сайта/надёжного источника. correspondence_evidence: только факты из предоставленной переписки."
    ].join("\n"),
    input: [{
      role: "user",
      content: JSON.stringify({
        company: {
          title: item.company || "",
          inn,
          corporate_domain: domain,
          official_site: website ? {
            url: website.url || "",
            title: website.title || "",
            description: website.description || "",
            text: String(website.text || "").slice(0, 16000),
          } : null,
        },
        crm_hints_not_evidence: [...(item.evidence || new Set())].slice(0, 8),
        b24_correspondence_after_identity_check: correspondence,
      })
    }]
  });

  const parsed = parseJsonText(extractResponseText(response));
  const status = String(parsed.status || "unclear");
  const result = {
    verificationStatus: status === "confirmed"
      ? "confirmed"
      : status === "not_contractor" ? "rejected" : "unclear",
    verificationConfidence: Number(parsed.confidence || 0),
    contractorType: String(parsed.contractor_type || ""),
    strategicScore: Number(parsed.strategic_score || 0),
    strategicReason: String(parsed.strategic_reason || ""),
    industrialRelevance: String(parsed.industrial_relevance || "unknown"),
    hazardousIndustrialSites: Boolean(parsed.hazardous_industrial_sites),
    relevantWorkTypes: Array.isArray(parsed.relevant_work_types) ? parsed.relevant_work_types : [],
    scaleLevel: String(parsed.scale_level || "unknown"),
    gasDetectionNeed: String(parsed.gas_detection_need || "unknown"),
    verificationReason: String(parsed.reason || ""),
    identityEvidence: String(parsed.identity_evidence || ""),
    websiteEvidence: String(parsed.website_evidence || ""),
    correspondenceEvidence: String(parsed.correspondence_evidence || ""),
    verifiedInn: inn,
    verifiedWebsite: website?.url || (domain ? "https://" + domain : ""),
  };

  Object.assign(item, result);
  CONTRACTOR_VERIFICATION_CACHE.set(item.companyId, { checkedAt: Date.now(), result });

  DASHBOARD_STATE.contractorScan.recentDiscoveries.unshift({
    at: new Date().toISOString(),
    company: item.company || "Компания без названия",
    reason: result.verificationStatus === "confirmed"
      ? "ПОДТВЕРЖДЁН: " + (result.verificationReason || result.contractorType)
      : result.verificationStatus === "rejected"
        ? "НЕ ПОДРЯДЧИК: " + (result.verificationReason || "")
        : "НЕЯСНО: " + (result.verificationReason || ""),
  });
  DASHBOARD_STATE.contractorScan.recentDiscoveries =
    DASHBOARD_STATE.contractorScan.recentDiscoveries.slice(0, 20);
}



function compactDate(value) {
  const t = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return String(d.getUTCDate()).padStart(2, "0") + "." +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "." +
    d.getUTCFullYear();
}

function activityText(activity) {
  return [activity?.subject || "", activity?.description || ""].join(" ").toLowerCase();
}

function looksLikeInvoice(text) {
  return /\bсч[её]т\b|invoice|оплат/i.test(String(text || ""));
}

function looksLikeQuote(text) {
  return /\bкп\b|коммерческ.{0,20}предлож/i.test(String(text || ""));
}


function normalizeDashboardProductName(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  // TOP-SENSE models are shown in the shortest commercial form: ТС260, ТС220, etc.
  const topSense = raw.match(/(?:ТОП[\s-]*СЕНС|TOP[\s-]*SENSE|TOPSENSE|ТС|TS)\s*[-–—]?\s*(\d{2,4}[A-ZА-Я0-9-]*)/i);
  if (topSense?.[1]) {
    return "ТС" + String(topSense[1]).replace(/\s+/g, "").toUpperCase();
  }

  // Preserve other concise model codes if they are explicitly present.
  const modelCode = raw.match(/\b([A-ZА-ЯЁ]{2,8}[- ]?\d{2,5}[A-ZА-ЯЁ0-9-]*)\b/i);
  if (modelCode?.[1]) {
    return String(modelCode[1]).replace(/\s+/g, "").toUpperCase();
  }

  // If the source explicitly says "сенсор", use that exact unambiguous term.
  if (/сенсор/i.test(raw)) return "Сенсор";

  // Never display the ambiguous generic term "датчик".
  return "";
}

function extractGasList(text) {
  const source = " " + String(text || "").toUpperCase().replace(/[А-ЯЁ]/g, " ") + " ";
  const gases = [
    "H2S","CO2","CH4","NH3","SO2","NO2","CL2","O3","PH3","HCN","HCL","HF",
    "C2H4","C3H8","C4H10","H2","CO","O2","NO"
  ];
  const found = [];
  for (const gas of gases) {
    const re = new RegExp("(^|[^A-Z0-9])" + gas + "([^A-Z0-9]|$)", "i");
    if (re.test(source) && !found.includes(gas)) found.push(gas);
  }
  return found.slice(0, 5);
}

function commercialActionKind(activity) {
  if (!activity) return "";
  const text = [
    activity.subject || "",
    activity.description || "",
    ...(activity.files || []).map(f => f.name || ""),
  ].join(" ");

  if (looksLikeInvoice(text)) return "Счёт";
  if (looksLikeQuote(text)) return "КП";

  if (
    /(^|\D)\d[\d\s]{2,}(?:[,.]\d+)?\s*(?:₽|руб(?:\.|лей)?|р\.)/i.test(text) ||
    /\b(?:цена|стоимость)\b/i.test(text)
  ) {
    return "Цена в письме";
  }

  return "Письмо";
}


async function commercialActionKindResolved(activity) {
  if (!activity) return "";

  let kind = commercialActionKind(activity);
  if (kind !== "Письмо") return kind;

  const resolvedNames = [];
  for (const file of (activity.files || []).slice(0, 5)) {
    if (file?.name) {
      resolvedNames.push(file.name);
      continue;
    }
    const id = String(file?.id || "").trim();
    if (!id) continue;
    try {
      const diskFile = await bitrixCall("disk.file.get", { id: Number(id) });
      const name = String(diskFile?.NAME || diskFile?.name || "").trim();
      if (name) resolvedNames.push(name);
    } catch {}
  }

  if (resolvedNames.length) {
    kind = commercialActionKind({
      ...activity,
      files: resolvedNames.map(name => ({ name })),
    });
  }

  return kind;
}

function hasStoredDealFile(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return Boolean(text && text !== "0" && text !== "[]");
}

function relationshipFollowupTask(activities, afterMs) {
  const taskRx = /связ|перезвон|узнат|результат|решен|уточн|контакт|follow/i;

  const validDeadline = value => {
    const ms = dateMs(value);
    if (!ms) return false;
    const year = new Date(ms).getUTCFullYear();

    // Bitrix can expose sentinel deadlines around year 9999 for "no real deadline".
    // Such placeholders must never appear on the dashboard.
    return year >= 2000 && year < 2100;
  };

  const rows = (activities || [])
    .filter(x => !x.completed && x.deadline)
    .filter(x => validDeadline(x.deadline))
    .filter(x => dateMs(x.deadline) >= Number(afterMs || 0));

  const explicit = rows
    .filter(x => taskRx.test([x.subject || "", x.description || ""].join(" ")))
    .sort((a,b) => dateMs(a.deadline) - dateMs(b.deadline))[0];

  if (explicit) return explicit;

  return rows
    .filter(x => String(x.direction || "") !== "1")
    .sort((a,b) => dateMs(a.deadline) - dateMs(b.deadline))[0] || null;
}

async function latestOfferSummary(latest, activities) {
  const rows = await contractorDealProductRows(latest.id);
  const outbound = (activities || [])
    .filter(x => String(x?.direction || "") === "2")
    .sort((a,b) => dateMs(b.created) - dateMs(a.created));

  let commercial = null;
  let commercialKind = "";

  for (const activity of outbound.slice(0, 12)) {
    const kind = await commercialActionKindResolved(activity);
    if (kind === "Счёт" || kind === "КП" || kind === "Цена в письме") {
      commercial = activity;
      commercialKind = kind;
      break;
    }
  }

  if (!commercial) {
    commercial = outbound[0] || null;
    commercialKind = await commercialActionKindResolved(commercial);
  }

  if (
    (!commercialKind || commercialKind === "Письмо") &&
    hasStoredDealFile(latest.invoiceFilesRaw)
  ) {
    commercialKind = "Счёт в сделке";
  } else if (
    (!commercialKind || commercialKind === "Письмо") &&
    hasStoredDealFile(latest.quoteFilesRaw)
  ) {
    commercialKind = "КП в сделке";
  }

  const textForGas = [
    latest.title || "",
    latest.comments || "",
    latest.additionalInfo || "",
    commercial?.subject || "",
    commercial?.description || "",
    ...rows.map(x => x.product || ""),
  ].join(" ");

  const gases = extractGasList(textForGas);

  let product = "";
  let quantity = 0;
  let productSum = 0;

  if (rows.length) {
    product = normalizeDashboardProductName(rows[0].product);
    quantity = rows.reduce((sum, x) => sum + Number(x.quantity || 0), 0);
    productSum = rows.reduce((sum, x) => sum + Number(x.sum || 0), 0);
  }

  if (!product) {
    product = normalizeDashboardProductName(
      String(latest.title || "")
        .replace(/\b\d+\s*(?:шт\.?|штук[аи]?)\b/ig, "")
        .replace(/\b(?:CO|CO2|CH4|O2|H2S|NH3|SO2|NO2|CL2|H2|O3|PH3|HCN|HCL|HF)\b/ig, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 55)
    );
  }

  if (!quantity) {
    const m = String(latest.title || "").match(/\b(\d+)\s*(?:шт\.?|штук[аи]?)\b/i);
    if (m) quantity = Number(m[1] || 0);
  }

  const amount = Number(latest.opportunity || 0) || Number(productSum || 0) || 0;
  const sentAtMs = dateMs(commercial?.created);
  const task = relationshipFollowupTask(activities, sentAtMs);

  return {
    product,
    gases,
    quantity,
    amount,
    action: commercialKind,
    sentDate: compactDate(commercial?.created),
    followupDate: compactDate(task?.deadline),
    hasFollowupTask: Boolean(task),
  };
}

function shortRequestTopic(latest, lastInbound) {
  const candidates = [
    String(lastInbound?.subject || "").trim(),
    String(latest?.title || "").trim(),
  ].filter(Boolean);

  let text = candidates[0] || "Запрос";
  text = text
    .replace(/^(re|fw|fwd)\s*:\s*/ig, "")
    .replace(/^запрос\s*(коммерческого\s+предложения|кп)?\s*[:\-–—]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 3) text = "Запрос";
  if (text.length > 46) text = text.slice(0, 43).trim() + "…";
  return text;
}

function outboundActionLabel(activity) {
  if (!activity) return "";
  const text = activityText(activity);

  if (looksLikeInvoice(text)) return "счёт отправлен";
  if (looksLikeQuote(text)) return "КП отправлено";

  const provider = String(activity.provider_id || "").toUpperCase();
  const typeId = String(activity.type_id || "");

  if (provider.includes("EMAIL") || typeId === "4") return "ответили письмом";
  if (provider.includes("VOX") || provider.includes("CALL") || typeId === "2") return "созвонились";
  return "ответили";
}

async function hydrateContractorRelationshipStatus(item) {
  if (item.verificationStatus !== "confirmed") return;

  const snapshots = item.dealSnapshots instanceof Map
    ? [...item.dealSnapshots.values()]
    : [];

  if (!snapshots.length) {
    item.relationshipStatus = "Нет истории в B24";
    item.relationshipCheckedAt = Date.now();
    return;
  }

  snapshots.sort((a,b) => dateMs(b.lastActivity) - dateMs(a.lastActivity));
  const latest = snapshots[0];

  const activities = await getDealActivitiesForRelationship(latest.id);
  const offer = await latestOfferSummary(latest, activities);

  const lastContactMs = Math.max(
    0,
    ...activities.map(x => dateMs(x.created)),
    dateMs(latest.lastActivity),
    dateMs(item.lastActivity)
  );

  const ageDays = lastContactMs
    ? Math.max(0, Math.floor((Date.now() - lastContactMs) / 86400000))
    : 9999;

  const parts = [];
  const productParts = [];

  if (offer.product) {
    productParts.push(
      offer.product + (offer.gases.length ? " (" + offer.gases.join("/") + ")" : "")
    );
  } else if (offer.gases.length) {
    productParts.push(offer.gases.join("/"));
  }
  if (offer.quantity) productParts.push(String(offer.quantity) + " шт.");
  if (productParts.length) parts.push(productParts.join(" · "));

  if (offer.amount) {
    parts.push(new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(offer.amount) + " ₽");
  }

  if (offer.action) {
    parts.push(offer.action + (offer.sentDate ? " " + offer.sentDate : ""));
  }

  if (offer.followupDate) {
    parts.push("связаться " + offer.followupDate);
  } else if (latest.isOpen) {
    parts.push("⚠ НЕТ ЗАДАЧИ СВЯЗАТЬСЯ");
  }

  if (ageDays > 7 && ageDays < 9999) {
    parts.push(ageDays + " дн. без работы");
  }

  if (!parts.length) {
    parts.push(
      latest.semantic === "S" ? "Продажа завершена"
        : latest.semantic === "F" ? "Не продали"
          : latest.isOpen ? "Открытая сделка"
            : "Контакт завершён"
    );
  }

  item.relationshipStatus = parts.join(" · ");
  item.relationshipCheckedAt = Date.now();
}


const CONTRACTOR_PRODUCT_ROWS_CACHE = new Map();

async function contractorDealProductRows(dealId) {
  const id = String(dealId || "").trim();
  if (!id) return [];
  if (CONTRACTOR_PRODUCT_ROWS_CACHE.has(id)) {
    return CONTRACTOR_PRODUCT_ROWS_CACHE.get(id);
  }

  let rows = [];
  try {
    const result = await bitrixCall("crm.deal.productrows.get", { id: Number(id) });
    rows = (Array.isArray(result) ? result : []).map(row => {
      const quantity = Number(row.QUANTITY || 0) || 0;
      const price = Number(row.PRICE || row.PRICE_EXCLUSIVE || 0) || 0;
      return {
        product: String(row.PRODUCT_NAME || row.NAME || "").trim(),
        quantity,
        price,
        sum: quantity * price,
      };
    }).filter(x => x.product);
  } catch {}

  CONTRACTOR_PRODUCT_ROWS_CACHE.set(id, rows);
  return rows;
}

async function hydrateContractorPurchasedProducts(item) {
  if (item.verificationStatus !== "confirmed") return;

  const wonDeals = item.dealSnapshots instanceof Map
    ? [...item.dealSnapshots.values()]
        .filter(x => x.semantic === "S")
        .sort((a,b) => dateMs(b.lastActivity) - dateMs(a.lastActivity))
        .slice(0, 12)
    : [];

  const grouped = new Map();

  for (const deal of wonDeals) {
    const rows = await contractorDealProductRows(deal.id);
    for (const row of rows) {
      const key = row.product.toLowerCase();
      const current = grouped.get(key) || {
        product: row.product,
        quantity: 0,
        sum: 0,
      };
      current.quantity += Number(row.quantity || 0);
      current.sum += Number(row.sum || 0);
      grouped.set(key, current);
    }
  }

  item.purchasedProducts = [...grouped.values()]
    .sort((a,b) => b.sum - a.sum || b.quantity - a.quantity)
    .slice(0, 12);
}

async function verifyNextContractorCandidate(filterFn = null) {
  const next = [...CONTRACTOR_SCAN_CANDIDATES.values()].find(
    item =>
      (!item.verificationStatus || item.verificationStatus === "pending") &&
      (!filterFn || filterFn(item))
  );
  if (!next) return;

  try {
    await verifyContractorCompany(next);
    if (next.verificationStatus === "confirmed") {
      await hydrateContractorPurchasedProducts(next);
      await hydrateContractorRelationshipStatus(next);
      await hydrateContractorManagerQuality(next);
    }

    if (next.verificationStatus === "confirmed" || next.verificationStatus === "rejected") {
      await persistContractorCandidate(next);
    }
  } catch (error) {
    next.verificationStatus = "error";
    next.verificationReason = error instanceof Error ? error.message : String(error);
    DASHBOARD_STATE.lastError = {
      at: new Date().toISOString(),
      source: "contractor-verification",
      message: next.verificationReason,
    };
  }
}



async function contractorCompanyContacts(companyId) {
  try {
    const rows = await bitrixCall("crm.contact.list", {
      order: { ID: "DESC" },
      filter: { COMPANY_ID: Number(companyId) },
      select: ["ID","NAME","LAST_NAME","POST","EMAIL","PHONE","DATE_CREATE"],
      start: 0,
    });
    return Array.isArray(rows) ? rows.slice(0, 50) : [];
  } catch {
    return [];
  }
}

function contactLooksLikeDecisionMaker(contact) {
  const post = String(contact?.POST || "").toLowerCase();
  return /директор|руковод|начальник|главн|снабж|закуп|кип|автомат|промбез|промышленн.{0,12}безопас|охран.{0,8}труд|hse|технич/i.test(post);
}

function managerAuditScoreClass(score) {
  if (score >= 80) return "сильно";
  if (score >= 60) return "нормально";
  if (score >= 40) return "слабо";
  return "плохо";
}

async function hydrateContractorManagerQuality(item) {
  if (item.verificationStatus !== "confirmed") return;

  const snapshots = item.dealSnapshots instanceof Map
    ? [...item.dealSnapshots.values()]
    : [];
  if (!snapshots.length) return;

  snapshots.sort((a,b) => dateMs(b.lastActivity) - dateMs(a.lastActivity));
  const latest = snapshots[0];

  const activities = await getDealActivitiesForRelationship(latest.id);
  const contacts = await contractorCompanyContacts(item.companyId);
  const offer = await latestOfferSummary(latest, activities);

  const qText = [latest.qualificationText || "", latest.qualificationHistory || ""]
    .filter(Boolean)
    .join("\n\n");
  const qBlocks = parseQuestionBlocks(qText)
    .filter(x => isMeaningfulManagerAnswer(x.answer));

  const answeredQuestion = re =>
    qBlocks.some(x => re.test((x.question + " " + x.answer).toLowerCase()));

  const communicationContactIds = new Set();
  const communicationValues = new Set();
  for (const activity of activities) {
    for (const c of activity.communications || []) {
      if (c.entity_id) communicationContactIds.add(String(c.entity_id));
      const v = String(c.value || "").trim().toLowerCase();
      if (v) communicationValues.add(v);
    }
  }

  const decisionContacts = contacts.filter(contactLooksLikeDecisionMaker);
  const decisionContactIds = new Set(
    decisionContacts.map(x => String(x.ID || "")).filter(Boolean)
  );
  const communicatedWithDecisionMaker = [...communicationContactIds]
    .some(id => decisionContactIds.has(id));

  const auditText = [
    latest.title || "",
    latest.comments || "",
    latest.additionalInfo || "",
    ...activities.map(x => [x.subject || "", x.description || ""].join(" ")),
  ].join(" ").toLowerCase();

  const explicitContactSearch = /кто.{0,20}(отвеч|заним|реш)|контакт.{0,25}(лпр|руковод|началь|кип|снабж|закуп)|лпр|выйти.{0,15}на|соедините|переключите/i.test(auditText);

  // Qualification score measures what the manager actually clarified,
  // not facts already present in the incoming request (model/gas/quantity/sum).
  let qualification = 0;
  const qualificationFacts = [];
  const qualificationMissing = [];

  const addQualification = (ok, points, label) => {
    if (ok) {
      qualification += points;
      qualificationFacts.push(label);
    } else {
      qualificationMissing.push(label);
    }
  };

  const lprAnswered = answeredQuestion(/лпр|принимает.{0,15}решен|кто.{0,15}реша|согласовывает|утверждает/);
  const lprKnown = lprAnswered || communicatedWithDecisionMaker;
  if (lprKnown) {
    qualification += 10;
    qualificationFacts.push("ЛПР");
  } else if (decisionContacts.length) {
    qualification += 5;
    qualificationFacts.push("ЛПР найден");
    qualificationMissing.push("контакт с ЛПР");
  } else {
    qualificationMissing.push("ЛПР");
  }

  const objectTask = answeredQuestion(/для какой.{0,20}(задач|объект)|на каком.{0,15}объект|где.{0,15}использ|назначен|услови.{0,10}эксплуатац/);
  addQualification(objectTask, 5, "объект/задача");

  const endCustomerKnown =
    answeredQuestion(/конечн.{0,15}заказчик|для кого|на чей.{0,10}объект|кто заказчик/) ||
    Boolean(String(latest.endCustomer || "").trim());
  addQualification(endCustomerKnown, 5, "конечный заказчик");

  const selectionRight = answeredQuestion(/сами.{0,15}выбира|кто.{0,15}выбира|готов.{0,15}спецификац|по спецификац|право.{0,10}выбор|кто.{0,15}определяет.{0,15}оборуд/);
  addQualification(selectionRight, 5, "кто выбирает");

  const alternativeKnown =
    answeredQuestion(/аналог|альтернатив|друг.{0,15}бренд|смен.{0,10}бренд|можно.{0,15}предлож/) ||
    Boolean(String(latest.analogs || "").trim());
  addQualification(alternativeKnown, 5, "аналог/бренд");

  const deadlineKnown =
    answeredQuestion(/срок|когда.{0,15}(нуж|постав|кп)|к какому/) ||
    Boolean(String(latest.deliveryDeadline || "").trim());
  addQualification(deadlineKnown, 5, "срок");

  const purchaseKnown =
    answeredQuestion(/тендер|прямая.{0,10}закуп|как.{0,15}закуп|формат.{0,10}закуп|через.{0,10}закуп/) ||
    Boolean(String(latest.purchaseFormatRaw || "").trim());
  addQualification(purchaseKnown, 5, "закупка");

  const competitorsKnown =
    answeredQuestion(/конкур|какие.{0,15}(бренд|производител)|что.{0,15}использ|текущ.{0,15}(прибор|поставщик)|цена.{0,15}конкур/) ||
    Boolean(String(latest.brands || "").trim()) ||
    Boolean(String(latest.competitorPrices || "").trim());
  addQualification(competitorsKnown, 5, "конкуренты");

  const choiceCriterion = answeredQuestion(/что.{0,15}важнее|главн.{0,20}при выборе|критери.{0,10}выбор|на что.{0,20}смотр|приоритет.{0,15}(цен|срок|характер)/);
  addQualification(choiceCriterion, 5, "критерий выбора");

  const winCondition = answeredQuestion(/что.{0,15}нужно.{0,20}(сделать|быть)|чтобы.{0,20}(выбра|куп|отдал)|что.{0,20}повысит.{0,15}шанс|услови.{0,15}побед|отдали.{0,15}нам/);
  addQualification(winCondition, 5, "как выиграть");

  qualification = Math.min(55, qualification);

  const additionalContacts = Math.max(
    contacts.length,
    communicationContactIds.size,
    communicationValues.size
  );

  let contactsScore = 0;
  if (additionalContacts >= 1) contactsScore += 5;
  if (additionalContacts >= 2) contactsScore += 5;
  if (additionalContacts >= 3) contactsScore += 3;
  if (decisionContacts.length) contactsScore += 5;
  if (explicitContactSearch) contactsScore += 2;
  contactsScore = Math.min(20, contactsScore);

  const approvalAttempt = /согласов|утверд|одобр|допуск|включ.{0,15}спецификац|залож.{0,15}проект|технич.{0,15}соглас|соглас.{0,15}аналог/i.test(auditText);
  const technicalWin = /аналог|альтернатив|замен|вариант|сертифик|опросн|технич.{0,15}(опис|док|реш)|подбор|испыт|образец|демо/i.test(auditText);
  const endCustomerWork = /конечн.{0,15}заказ|эксплуатир|проектн.{0,15}организац|генподряд|заказчик/i.test(auditText);

  let approvalScore = 0;
  if (approvalAttempt) approvalScore += 10;
  if (technicalWin) approvalScore += 6;
  if (endCustomerWork) approvalScore += 4;
  approvalScore = Math.min(20, approvalScore);

  const outbound = activities.filter(x => String(x?.direction || "") === "2");
  let commercial = null;
  for (const activity of outbound) {
    const kind = await commercialActionKindResolved(activity);
    if (["Счёт","КП","Цена в письме"].includes(kind)) {
      commercial = activity;
      break;
    }
  }

  const commercialMs = dateMs(commercial?.created);
  const followTask = relationshipFollowupTask(activities, commercialMs);
  const laterOutbound = commercialMs
    ? outbound.filter(x => dateMs(x.created) > commercialMs).length
    : 0;

  let followupScore = 0;
  if (commercial) followupScore += 5;
  if (followTask) followupScore += 8;
  if (laterOutbound >= 1) followupScore += 4;
  if (laterOutbound >= 2) followupScore += 3;
  followupScore = Math.min(20, followupScore);

  // Overall manager score remains 0-100:
  // qualification 55%, contacts 15%, approval 15%, follow-up 15%.
  const weightedTotal = Math.round(
    qualification +
    (contactsScore / 20) * 15 +
    (approvalScore / 20) * 15 +
    (followupScore / 20) * 15
  );

  const missingTaskFault = Boolean(latest.isOpen && !followTask);
  const total = missingTaskFault ? Math.min(weightedTotal, 59) : weightedTotal;

  const missingText = qualificationMissing.length
    ? "не выяснено: " + qualificationMissing.slice(0, 5).join(", ")
    : "квалификация полная";

  const tags = [
    "конт. " + Math.max(contacts.length, communicationContactIds.size),
    decisionContacts.length ? "ЛПР ✓" : "ЛПР —",
    approvalAttempt ? "соглас. ✓" : "соглас. —",
    followTask ? "задача ✓" : (latest.isOpen ? "ЗАДАЧИ НЕТ ⚠" : "задача —"),
  ];

  item.managerQualityScore = total;
  item.managerQualityLevel = managerAuditScoreClass(total);
  item.managerQualitySummary = tags.join(" · ");
  item.managerQualificationScore = qualification;
  item.managerQualificationSummary = missingText;
  item.managerQualificationFacts = qualificationFacts;
  item.managerQualificationMissing = qualificationMissing;
  item.managerContactsScore = contactsScore;
  item.managerApprovalScore = approvalScore;
  item.managerFollowupScore = followupScore;
  item.managerProcessIssue = missingTaskFault ? "Нет активной задачи на следующий контакт" : "";
  item.managerAuditCheckedAt = Date.now();
}

async function refreshOneContractorRelationshipStatus() {
  const now = Date.now();
  const candidate = [...CONTRACTOR_SCAN_CANDIDATES.values()]
    .filter(x => x.verificationStatus === "confirmed")
    .sort((a,b) => Number(a.relationshipCheckedAt || 0) - Number(b.relationshipCheckedAt || 0))
    .find(x => now - Number(x.relationshipCheckedAt || 0) > 15 * 60 * 1000);

  if (!candidate) return;
  try {
    await hydrateContractorRelationshipStatus(candidate);
    await hydrateContractorManagerQuality(candidate);
    await persistContractorCandidate(candidate);
  } catch {}
}


function normalizedCompanyTitle(value) {
  return String(value || "")
    .replace(/&(?:#x20|#32|nbsp);?/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizedWebsiteHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function contractorPersistenceKey(row) {
  const inn = String(row?.inn || "").replace(/\D/g, "");
  if (inn) return "inn:" + inn;

  const host = normalizedWebsiteHost(row?.website);
  if (host) return "site:" + host;

  const companyId = String(row?.companyId || "").trim();
  return companyId ? "b24:" + companyId : "";
}

function sameContractorEntity(a, b) {
  const aInn = String(a?.inn || "").replace(/\D/g, "");
  const bInn = String(b?.inn || "").replace(/\D/g, "");
  if (aInn && bInn && aInn === bInn) return true;

  const aHost = normalizedWebsiteHost(a?.website);
  const bHost = normalizedWebsiteHost(b?.website);
  if (aHost && bHost && aHost === bHost) return true;

  const aId = String(a?.companyId || "").trim();
  const bId = String(b?.companyId || "").trim();
  return Boolean(aId && bId && aId === bId);
}

function sheetStoreConfigured() {
  return Boolean(
    String(process.env.GOOGLE_SHEET_STORE_URL || "").trim() &&
    String(process.env.GOOGLE_SHEET_STORE_SECRET || "").trim()
  );
}

async function sheetStoreRequest(action, rows = null) {
  if (!sheetStoreConfigured()) return null;

  const url = String(process.env.GOOGLE_SHEET_STORE_URL || "").trim();
  const secret = String(process.env.GOOGLE_SHEET_STORE_SECRET || "").trim();

  const body = { action, secret };
  if (rows) body.rows = rows;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}

  if (!response.ok || payload?.ok === false) {
    throw new Error(
      "Google Sheet store failed: " +
      (payload?.error || ("HTTP " + response.status))
    );
  }

  return payload;
}

async function loadPersistedContractors() {
  if (!sheetStoreConfigured()) {
    console.log(JSON.stringify({
      source: "contractor-store",
      action: "load-skipped",
      reason: "Google Sheet store is not configured",
    }));
    return;
  }

  try {
    const payload = await sheetStoreRequest("load");
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];

    PERSISTED_CONTRACTORS.clear();
    PERSISTED_COMPANY_TYPES.clear();
    PERSISTED_PENDING_COMPANIES.clear();

    let lastDailyScanDate = "";

    for (const entry of rows) {
      const row = entry?.payload;
      const key = String(entry?.key || contractorPersistenceKey(row) || "").trim();
      if (!row || !key) continue;

      if (key === "meta:daily-contractor-scan") {
        lastDailyScanDate = String(row.lastCompletedDate || "");
        continue;
      }

      if (row.verificationStatus === "confirmed" || row.verificationStatus === "rejected") {
        PERSISTED_COMPANY_TYPES.set(key, row);
      }

      if (row.verificationStatus === "pending") {
        PERSISTED_PENDING_COMPANIES.set(key, row);
      }

      if (row.verificationStatus === "confirmed") {
        PERSISTED_CONTRACTORS.set(key, row);
      }
    }

    DASHBOARD_STATE.contractorScan.lastDailyScanDate = lastDailyScanDate || null;

    console.log(JSON.stringify({
      source: "contractor-store",
      action: "load-ok",
      contractorCount: PERSISTED_CONTRACTORS.size,
      classifiedCompanyCount: PERSISTED_COMPANY_TYPES.size,
      pendingCompanyCount: PERSISTED_PENDING_COMPANIES.size,
      lastDailyScanDate: lastDailyScanDate || null,
    }));

    refreshContractorScanSummary();
  } catch (error) {
    console.warn(JSON.stringify({
      source: "contractor-store",
      action: "load-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function persistContractorCandidate(item) {
  if (!item || !["confirmed", "rejected"].includes(item.verificationStatus)) return;

  const row = publicCandidate(item);
  const key = contractorPersistenceKey(row);
  if (!key) return;

  PERSISTED_COMPANY_TYPES.set(key, row);
  PERSISTED_PENDING_COMPANIES.delete(key);

  if (row.verificationStatus === "confirmed") {
    PERSISTED_CONTRACTORS.set(key, row);
  } else {
    PERSISTED_CONTRACTORS.delete(key);
  }

  if (!sheetStoreConfigured()) return;

  try {
    await sheetStoreRequest("upsert", [{ key, payload: row }]);
    console.log(JSON.stringify({
      source: "contractor-store",
      action: "classification-upsert-ok",
      key,
      company: row.company || "",
      verificationStatus: row.verificationStatus || "",
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      source: "contractor-store",
      action: "classification-upsert-failed",
      key,
      company: row.company || "",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function persistPendingCompany(item) {
  if (!item || !item.companyId) return null;

  const known = await persistedClassificationForItem(item);
  if (known) {
    applyPersistedClassification(item, known);
    return { reused: true, row: known };
  }

  // Identity lookup is Bitrix-only and does not spend OpenAI credits.
  const company = await contractorCompanyForVerification(item.companyId);
  if (company) {
    item.company = String(company.TITLE || item.company || "");
    const inn = await contractorCompanyInn(item.companyId, company);
    const domain = contractorCompanyDomain(company);
    item.verifiedInn = inn || item.verifiedInn || "";
    item.verifiedWebsite = domain ? "https://" + domain : (item.verifiedWebsite || "");
  }

  item.verificationStatus = "pending";
  const row = publicCandidate(item);
  row.recordType = "company-classification";
  row.queuedAt = new Date().toISOString();

  const key = contractorPersistenceKey(row);
  if (!key) return null;

  PERSISTED_PENDING_COMPANIES.set(key, row);

  if (sheetStoreConfigured()) {
    try {
      await sheetStoreRequest("upsert", [{ key, payload: row }]);
      console.log(JSON.stringify({
        source: "contractor-store",
        action: "pending-upsert-ok",
        key,
        company: row.company || "",
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        source: "contractor-store",
        action: "pending-upsert-failed",
        key,
        company: row.company || "",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return { reused: false, row };
}

function candidateFromPersistedRow(row) {
  const item = {
    companyId: String(row?.companyId || ""),
    company: String(row?.company || ""),
    dealCount: Number(row?.dealCount || 0),
    openDeals: Number(row?.openDeals || 0),
    directCount: row?.purchaseMode === "Прямая закупка" || row?.purchaseMode === "Смешанный" ? 1 : 0,
    tenderCount: row?.purchaseMode === "Тендер/торги" || row?.purchaseMode === "Смешанный" ? 1 : 0,
    totalOpportunity: Number(row?.totalOpportunity || 0),
    wonOpportunity: Number(row?.wonOpportunity || 0),
    openOpportunity: Number(row?.openOpportunity || 0),
    lostOpportunity: Number(row?.lostOpportunity || 0),
    unclassifiedOpportunity: Number(row?.unclassifiedOpportunity || 0),
    lastActivityMs: dateMs(row?.lastActivity),
    lastActivity: row?.lastActivity || "",
    maxSignalWeight: 0,
    managers: new Set(Array.isArray(row?.managers) ? row.managers : []),
    managerNames: new Map(),
    currentWork: Array.isArray(row?.currentWork) ? row.currentWork : [],
    dealSnapshots: new Map(),
    purchasedProducts: Array.isArray(row?.purchasedProducts) ? row.purchasedProducts : [],
    relationshipStatus: row?.relationshipStatus || "",
    managerQualityScore: Number(row?.managerQualityScore || 0),
    managerQualityLevel: row?.managerQualityLevel || "",
    managerQualitySummary: row?.managerQualitySummary || "",
    managerQualificationScore: Number(row?.managerQualificationScore || 0),
    managerQualificationSummary: row?.managerQualificationSummary || "",
    managerProcessIssue: row?.managerProcessIssue || "",
    managerAuditCheckedAt: 0,
    evidence: new Set(Array.isArray(row?.evidence) ? row.evidence : []),
    sampleDeals: Array.isArray(row?.sampleDeals) ? row.sampleDeals : [],
    sampleDealContexts: [],
    verificationStatus: "pending",
    verificationConfidence: 0,
    contractorType: "",
    strategicScore: 0,
    strategicReason: "",
    industrialRelevance: "unknown",
    hazardousIndustrialSites: false,
    relevantWorkTypes: [],
    scaleLevel: "unknown",
    gasDetectionNeed: "unknown",
    verificationReason: "",
    identityEvidence: "",
    websiteEvidence: "",
    correspondenceEvidence: "",
    verifiedInn: row?.inn || "",
    verifiedWebsite: row?.website || "",
  };

  if (Array.isArray(row?.managerNames)) {
    row.managerNames.forEach((name, idx) => {
      const id = [...item.managers][idx] || "name:" + idx;
      item.managerNames.set(String(id), String(name || ""));
    });
  }

  return item;
}

async function classifyPersistedPendingCompanies(limit = 25) {
  if (openAiPaused()) return { skipped: "openai-paused" };

  let classified = 0;
  const rows = [...PERSISTED_PENDING_COMPANIES.values()].slice(0, limit);

  for (const row of rows) {
    if (openAiPaused()) break;

    const item = candidateFromPersistedRow(row);
    if (!item.companyId) continue;

    CONTRACTOR_SCAN_CANDIDATES.set(item.companyId, item);

    await verifyContractorCompany(item);

    if (item.verificationStatus === "confirmed") {
      await hydrateContractorPurchasedProducts(item);
      await hydrateContractorRelationshipStatus(item);
      await hydrateContractorManagerQuality(item);
    }

    if (item.verificationStatus === "confirmed" || item.verificationStatus === "rejected") {
      await persistContractorCandidate(item);
      classified += 1;
    }
  }

  refreshContractorScanSummary();

  console.log(JSON.stringify({
    source: "contractor-daily-scan",
    action: "pending-classification-pass",
    classified,
    remaining: PERSISTED_PENDING_COMPANIES.size,
  }));

  return { classified, remaining: PERSISTED_PENDING_COMPANIES.size };
}

async function persistDailyContractorScanMeta(dateKey, stats = {}) {
  DASHBOARD_STATE.contractorScan.lastDailyScanDate = dateKey;

  if (!sheetStoreConfigured()) return;

  try {
    await sheetStoreRequest("upsert", [{
      key: "meta:daily-contractor-scan",
      payload: {
        recordType: "meta",
        lastCompletedDate: dateKey,
        completedAt: new Date().toISOString(),
        stats,
      },
    }]);
  } catch (error) {
    console.warn(JSON.stringify({
      source: "contractor-store",
      action: "daily-meta-upsert-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}


function combinePurchasedProducts(a = [], b = []) {
  const map = new Map();
  for (const row of [...a, ...b]) {
    const product = String(row?.product || "").trim();
    if (!product) continue;
    const key = product.toLowerCase();
    const current = map.get(key) || { product, quantity: 0, sum: 0 };
    current.quantity += Number(row?.quantity || 0);
    current.sum += Number(row?.sum || 0);
    map.set(key, current);
  }
  return [...map.values()]
    .sort((x,y) => y.sum - x.sum || y.quantity - x.quantity)
    .slice(0, 12);
}

function mergeConfirmedContractorRows(rows) {
  const groups = [];

  for (const row of rows || []) {
    const inn = String(row.inn || "").replace(/\D/g, "");
    const host = normalizedWebsiteHost(row.website);
    const name = normalizedCompanyTitle(row.company);

    let group = groups.find(g =>
      (inn && g.inns.has(inn)) ||
      (host && g.hosts.has(host))
    );

    if (!group) {
      group = {
        row: { ...row },
        inns: new Set(inn ? [inn] : []),
        hosts: new Set(host ? [host] : []),
        companyIds: new Set(row.companyId ? [String(row.companyId)] : []),
      };
      groups.push(group);
      continue;
    }

    const target = group.row;
    if (inn) group.inns.add(inn);
    if (host) group.hosts.add(host);
    if (row.companyId) group.companyIds.add(String(row.companyId));

    const rowIsNewer = dateMs(row.lastActivity) > dateMs(target.lastActivity);

    target.company = target.company || row.company;
    target.score = Math.max(Number(target.score || 0), Number(row.score || 0));
    target.strategicScore = Math.max(Number(target.strategicScore || 0), Number(row.strategicScore || 0));
    target.crmActivityScore = Math.max(Number(target.crmActivityScore || 0), Number(row.crmActivityScore || 0));
    target.dealCount = Number(target.dealCount || 0) + Number(row.dealCount || 0);
    target.openDeals = Number(target.openDeals || 0) + Number(row.openDeals || 0);
    target.totalOpportunity = Number(target.totalOpportunity || 0) + Number(row.totalOpportunity || 0);
    target.wonOpportunity = Number(target.wonOpportunity || 0) + Number(row.wonOpportunity || 0);
    target.openOpportunity = Number(target.openOpportunity || 0) + Number(row.openOpportunity || 0);
    target.lostOpportunity = Number(target.lostOpportunity || 0) + Number(row.lostOpportunity || 0);
    target.unclassifiedOpportunity = Number(target.unclassifiedOpportunity || 0) + Number(row.unclassifiedOpportunity || 0);
    target.purchasedProducts = combinePurchasedProducts(target.purchasedProducts, row.purchasedProducts);
    target.managers = [...new Set([...(target.managers || []), ...(row.managers || [])])].slice(0, 8);
    target.managerNames = [...new Set([...(target.managerNames || []), ...(row.managerNames || [])])].slice(0, 8);
    target.currentWork = [...(target.currentWork || []), ...(row.currentWork || [])]
      .sort((x,y) => dateMs(y.lastActivity) - dateMs(x.lastActivity))
      .slice(0, 8);
    target.sampleDeals = [...new Set([...(target.sampleDeals || []), ...(row.sampleDeals || [])])].slice(0, 8);
    target.evidence = [...new Set([...(target.evidence || []), ...(row.evidence || [])])].slice(0, 8);

    if (rowIsNewer) {
      target.lastActivity = row.lastActivity;
      target.relationshipStatus = row.relationshipStatus;
      target.managerQualityScore = row.managerQualityScore;
      target.managerQualityLevel = row.managerQualityLevel;
      target.managerQualitySummary = row.managerQualitySummary;
      target.managerProcessIssue = row.managerProcessIssue;
      target.companyId = row.companyId;
    }

    if (!target.inn && inn) target.inn = inn;
    if (!target.website && row.website) target.website = row.website;

    console.log(JSON.stringify({
      source: "contractor-dashboard",
      action: "contractor-duplicate-merged",
      company: row.company || target.company || "",
      normalizedCompany: name,
      companyIds: [...group.companyIds],
      inns: [...group.inns],
      websites: [...group.hosts],
    }));
  }

  return groups.map(g => ({
    ...g.row,
    mergedCompanyIds: [...g.companyIds],
    duplicateCardsMerged: Math.max(0, g.companyIds.size - 1),
  }));
}

function refreshContractorScanSummary() {
  const all = [...CONTRACTOR_SCAN_CANDIDATES.values()].map(publicCandidate);
  const confirmedCards = all.filter(x => x.verificationStatus === "confirmed");

  const persistedRows = [...PERSISTED_CONTRACTORS.values()]
    .filter(x => x && x.verificationStatus === "confirmed")
    .filter(persisted => !confirmedCards.some(live => sameContractorEntity(persisted, live)));

  const confirmed = mergeConfirmedContractorRows([
    ...persistedRows,
    ...confirmedCards,
  ]);

  confirmed.sort((a,b) =>
    b.score - a.score ||
    b.dealCount - a.dealCount ||
    dateMs(b.lastActivity) - dateMs(a.lastActivity)
  );

  const scan = DASHBOARD_STATE.contractorScan;
  scan.discoveredCandidates = all.length;
  scan.verifiedContractors = confirmed.length;
  scan.verifiedContractorCards = confirmedCards.length;
  scan.pendingVerification = all.filter(
    x => x.verificationStatus === "pending" ||
         x.verificationStatus === "checking" ||
         x.verificationStatus === "error"
  ).length;
  scan.unclearCandidates = all.filter(x => x.verificationStatus === "unclear").length;
  scan.rejectedCandidates = all.filter(x => x.verificationStatus === "rejected").length;

  scan.candidateCompanies = confirmed.length;
  scan.highPotential = confirmed.filter(x => x.score >= 70).length;
  scan.directPurchaseCompanies = confirmed.filter(
    x => x.purchaseMode === "Прямая закупка" || x.purchaseMode === "Смешанный"
  ).length;
  scan.tenderOnlyCompanies = confirmed.filter(x => x.purchaseMode === "Тендер/торги").length;
  scan.topCandidates = confirmed.slice(0, 100);

  DASHBOARD_STATE.similarContractors = {
    status: "verifying-bitrix-history",
    target: Math.max(30, all.length),
    completed: confirmed.length,
  };
}


const CONTRACTOR_USER_NAME_CACHE = new Map();

async function contractorUserName(userId) {
  const id = String(userId || "").trim();
  if (!id) return "";
  if (CONTRACTOR_USER_NAME_CACHE.has(id)) {
    return CONTRACTOR_USER_NAME_CACHE.get(id);
  }

  let user = null;
  let lastError = "";

  const attempts = [
    ["user.get", { ID: Number(id) }],
    ["user.get", { FILTER: { ID: Number(id) } }],
    ["user.search", { FILTER: { ID: Number(id) } }],
  ];

  for (const [method, params] of attempts) {
    try {
      const result = await bitrixCall(method, params);
      const row = Array.isArray(result) ? result[0] : result;
      if (row && (row.LAST_NAME || row.NAME)) {
        user = row;
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const surname = String(user?.LAST_NAME || "").trim();
  const firstName = String(user?.NAME || "").trim();
  const display = surname || firstName || "";

  if (!user && lastError) {
    console.warn(JSON.stringify({
      source: "contractor-dashboard",
      action: "manager-name-resolve-failed",
      userId: id,
      error: lastError,
    }));
    // Do not cache failed lookups: after webhook scope is expanded,
    // surnames will start appearing automatically without a restart.
    return "";
  }

  if (display) CONTRACTOR_USER_NAME_CACHE.set(id, display);
  return display;
}

function recomputeContractorDealMetrics(item) {
  const snapshots = item.dealSnapshots instanceof Map
    ? [...item.dealSnapshots.values()]
    : [];

  item.dealCount = snapshots.length;
  item.openDeals = snapshots.filter(x => x.isOpen).length;
  item.directCount = snapshots.filter(x => x.direct).length;
  item.tenderCount = snapshots.filter(x => x.tender).length;
  item.totalOpportunity = snapshots.reduce((sum, x) => sum + Number(x.opportunity || 0), 0);
  item.wonOpportunity = snapshots
    .filter(x => x.semantic === "S")
    .reduce((sum, x) => sum + Number(x.opportunity || 0), 0);
  item.lostOpportunity = snapshots
    .filter(x => x.semantic === "F")
    .reduce((sum, x) => sum + Number(x.opportunity || 0), 0);
  item.openOpportunity = snapshots
    .filter(x => x.isOpen)
    .reduce((sum, x) => sum + Number(x.opportunity || 0), 0);
  item.unclassifiedOpportunity = Math.max(
    0,
    item.totalOpportunity - item.wonOpportunity - item.lostOpportunity - item.openOpportunity
  );

  item.maxSignalWeight = snapshots.reduce(
    (max, x) => Math.max(max, Number(x.signalWeight || 0)),
    0
  );

  item.currentWork = snapshots
    .filter(x => x.isOpen)
    .sort((a,b) => dateMs(b.lastActivity) - dateMs(a.lastActivity))
    .slice(0, 8)
    .map(x => ({
      id: x.id,
      title: x.title,
      amount: x.opportunity,
      stage: x.stage,
      assignedById: x.assignedById,
      responsible: x.assignedById
        ? (item.managerNames?.get(String(x.assignedById)) || String(x.assignedById))
        : "",
      lastActivity: x.lastActivity,
    }));
}

async function ingestDailyContractorDeal(deal, dateKey) {
  const companyId = String(deal.COMPANY_ID || "");
  if (!companyId || companyId === "0") {
    DASHBOARD_STATE.contractorScan.unlinkedCandidateDeals += 1;
    return null;
  }

  const sig = dealContractorSignals(deal);

  let item = CONTRACTOR_SCAN_CANDIDATES.get(companyId);
  const isNew = !item;

  if (!item) {
    item = {
      companyId,
      company: "",
      dealCount: 0,
      openDeals: 0,
      directCount: 0,
      tenderCount: 0,
      totalOpportunity: 0,
      wonOpportunity: 0,
      openOpportunity: 0,
      lostOpportunity: 0,
      unclassifiedOpportunity: 0,
      lastActivityMs: 0,
      lastActivity: "",
      maxSignalWeight: 0,
      managers: new Set(),
      managerNames: new Map(),
      currentWork: [],
      dealSnapshots: new Map(),
      purchasedProducts: [],
      relationshipStatus: "",
      managerQualityScore: 0,
      managerQualityLevel: "",
      managerQualitySummary: "",
      managerQualificationScore: 0,
      managerQualificationSummary: "",
      managerProcessIssue: "",
      managerAuditCheckedAt: 0,
      evidence: new Set(),
      sampleDeals: [],
      sampleDealContexts: [],
      verificationStatus: "pending",
      verificationConfidence: 0,
      contractorType: "",
      strategicScore: 0,
      strategicReason: "",
      industrialRelevance: "unknown",
      hazardousIndustrialSites: false,
      relevantWorkTypes: [],
      scaleLevel: "unknown",
      gasDetectionNeed: "unknown",
      verificationReason: "",
      identityEvidence: "",
      websiteEvidence: "",
      correspondenceEvidence: "",
      verifiedInn: "",
      verifiedWebsite: "",
      dailyScanDate: dateKey,
    };
    CONTRACTOR_SCAN_CANDIDATES.set(companyId, item);
  } else {
    item.dailyScanDate = dateKey;
  }

  if (!item.company) item.company = await contractorCompanyName(companyId);

  const opportunity = Number(deal.OPPORTUNITY || 0) || 0;
  const semantic = String(deal.STAGE_SEMANTIC_ID || "").toUpperCase();
  const isOpen = String(deal.CLOSED || "").toUpperCase() !== "Y";
  const ps = purchaseSignals(deal);
  const activity = deal.LAST_ACTIVITY_TIME || deal.DATE_MODIFY || deal.DATE_CREATE || "";
  const dealKey = String(deal.ID || "");

  if (dealKey) {
    item.dealSnapshots.set(dealKey, {
      id: dealKey,
      title: String(deal.TITLE || "").trim(),
      opportunity,
      semantic,
      isOpen,
      direct: Boolean(ps.direct),
      tender: Boolean(ps.tender),
      signalWeight: Number(sig.weight || 0),
      stage: String(deal.STAGE_ID || ""),
      assignedById: String(deal.ASSIGNED_BY_ID || ""),
      lastActivity: activity,
      comments: String(deal.COMMENTS || "").slice(0, 5000),
      additionalInfo: String(deal.ADDITIONAL_INFO || "").slice(0, 3000),
      purchaseFormatRaw: asText(deal.UF_CRM_1728208250222),
      endCustomer: String(deal.UF_CRM_1728208529434 || ""),
      deliveryDeadline: String(deal.UF_CRM_1728208560055 || ""),
      brands: String(deal.UF_CRM_1728208353618 || ""),
      competitorPrices: String(deal.UF_CRM_1728208500678 || ""),
      analogs: asText(deal.UF_CRM_1728208192427),
      qualificationText: String(deal.UF_CRM_1790850696723 || "").slice(0, 10000),
      qualificationHistory: String(deal[AI_FIELDS.dealAnswers] || "").slice(0, 10000),
      quoteFilesRaw: deal.UF_CRM_1728208597522 || null,
      invoiceFilesRaw: deal.UF_CRM_1728208621363 || null,
    });
  }

  sig.reasons.forEach(x => item.evidence.add(x));

  if (deal.ASSIGNED_BY_ID) {
    const managerId = String(deal.ASSIGNED_BY_ID);
    item.managers.add(managerId);
    if (!item.managerNames.get(managerId)) {
      const resolvedSurname = await contractorUserName(managerId);
      if (resolvedSurname) item.managerNames.set(managerId, resolvedSurname);
    }
  }

  recomputeContractorDealMetrics(item);

  const ms = dateMs(activity);
  if (ms > item.lastActivityMs) {
    item.lastActivityMs = ms;
    item.lastActivity = activity;
  }

  const title = String(deal.TITLE || "").trim();
  if (title && !item.sampleDeals.includes(title)) {
    item.sampleDeals.unshift(title);
    item.sampleDeals = item.sampleDeals.slice(0, 6);
  }

  if (deal.ID && !item.sampleDealContexts.some(x => String(x.id) === String(deal.ID))) {
    item.sampleDealContexts.unshift({ id: String(deal.ID), title });
    item.sampleDealContexts = item.sampleDealContexts.slice(0, 4);
  }

  if (isNew) {
    DASHBOARD_STATE.contractorScan.recentDiscoveries.unshift({
      at: new Date().toISOString(),
      company: item.company || "Компания без названия",
      reason: "Новая компания за день — проверяем тип один раз",
    });
    DASHBOARD_STATE.contractorScan.recentDiscoveries =
      DASHBOARD_STATE.contractorScan.recentDiscoveries.slice(0, 20);
  }

  return item;
}

function moscowDateKey(value = Date.now()) {
  const d = new Date(Number(value) + 3 * 60 * 60 * 1000);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

function nextDateKey(dateKey) {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function previousDateKey(dateKey) {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

let DAILY_CONTRACTOR_SCAN_RUNNING = false;

async function runDailyContractorScan(dateKey) {
  if (!dailyContractorScanEnabled()) return { skipped: "disabled" };
  if (DAILY_CONTRACTOR_SCAN_RUNNING) return { skipped: "already-running" };

  DAILY_CONTRACTOR_SCAN_RUNNING = true;
  const scan = DASHBOARD_STATE.contractorScan;
  scan.status = "daily-scan";
  scan.dailyScanDate = dateKey;

  const startDate = dateKey + "T00:00:00+03:00";
  const endDate = nextDateKey(dateKey) + "T00:00:00+03:00";

  let cursor = 0;
  let dealsRead = 0;
  const companyIds = new Set();

  try {
    while (true) {
      const raw = await bitrixCallRaw("crm.deal.list", {
        order: { ID: "DESC" },
        filter: {
          ">=DATE_CREATE": startDate,
          "<DATE_CREATE": endDate,
        },
        select: [
          "ID","TITLE","COMPANY_ID","CONTACT_ID","STAGE_ID","STAGE_SEMANTIC_ID","CLOSED",
          "OPPORTUNITY","CURRENCY_ID","ASSIGNED_BY_ID",
          "DATE_CREATE","DATE_MODIFY","LAST_ACTIVITY_TIME",
          "COMMENTS","ADDITIONAL_INFO",
          "UF_CRM_1739950675115","UF_CRM_1728208341819",
          "UF_CRM_1728208250222","UF_CRM_1728208292193",
          "UF_CRM_1728208353618","UF_CRM_1728208500678",
          "UF_CRM_1728208529434","UF_CRM_1728208560055",
          "UF_CRM_1728208192427","UF_CRM_1790850696723",
          "UF_CRM_1728208597522","UF_CRM_1728208621363",
          AI_FIELDS.dealAnswers,
          AI_FIELDS.dealType,AI_FIELDS.dealRoles,AI_FIELDS.dealServices
        ],
        start: cursor,
      });

      const deals = Array.isArray(raw.result) ? raw.result : [];

      for (const deal of deals) {
        dealsRead += 1;
        if (deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0") {
          companyIds.add(String(deal.COMPANY_ID));
        }
        await ingestDailyContractorDeal(deal, dateKey);
      }

      if (raw.next === undefined || raw.next === null || String(raw.next) === "") break;
      cursor = Number(raw.next);
    }

    let queuedNow = 0;
    let reusedKnown = 0;

    const dailyItems = [...CONTRACTOR_SCAN_CANDIDATES.values()]
      .filter(item => item.dailyScanDate === dateKey);

    for (const item of dailyItems) {
      if (item.verificationStatus && item.verificationStatus !== "pending") continue;
      const persisted = await persistPendingCompany(item);
      if (persisted?.reused) reusedKnown += 1;
      else if (persisted?.row) queuedNow += 1;
    }

    let classifiedNow = 0;

    if (!openAiPaused()) {
      const result = await classifyPersistedPendingCompanies(50);
      classifiedNow = Number(result?.classified || 0);
    }

    refreshContractorScanSummary();

    await persistDailyContractorScanMeta(dateKey, {
      dealsRead,
      uniqueCompanies: companyIds.size,
      queuedNow,
      reusedKnown,
      classifiedNow,
      openAiPaused: openAiPaused(),
    });

    scan.lastDailyScanAt = new Date().toISOString();
    scan.status = "daily-scan-complete";

    console.log(JSON.stringify({
      source: "contractor-daily-scan",
      action: "complete",
      date: dateKey,
      dealsRead,
      uniqueCompanies: companyIds.size,
      queuedNow,
      reusedKnown,
      classifiedNow,
      openAiPaused: openAiPaused(),
    }));

    return { dealsRead, uniqueCompanies: companyIds.size, classifiedNow };
  } catch (error) {
    scan.status = "daily-scan-error";
    DASHBOARD_STATE.lastError = {
      at: new Date().toISOString(),
      source: "contractor-daily-scan",
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    DAILY_CONTRACTOR_SCAN_RUNNING = false;
  }
}

async function dailyContractorScanTick() {
  if (!dailyContractorScanEnabled() || DAILY_CONTRACTOR_SCAN_RUNNING) return;

  if (!openAiPaused() && PERSISTED_PENDING_COMPANIES.size) {
    await classifyPersistedPendingCompanies(25);
  }

  const nowMsk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = moscowDateKey();
  const yesterday = previousDateKey(today);
  const hour = nowMsk.getUTCHours();
  const last = String(DASHBOARD_STATE.contractorScan.lastDailyScanDate || "");

  // If yesterday was missed because Render slept, recover it on the next wake.
  if (!last || last < yesterday) {
    await runDailyContractorScan(yesterday);
    return;
  }

  // End-of-day run: first wake/check at or after 19:00 MSK.
  if (hour >= 19 && last < today) {
    await runDailyContractorScan(today);
  }
}

async function contractorScanStep() {
  if (contractorScanPaused()) {
    DASHBOARD_STATE.contractorScan.status = "paused";
    CONTRACTOR_SCAN_RUNNING = false;
    CONTRACTOR_SCAN_TIMER = null;
    return;
  }

  if (CONTRACTOR_SCAN_RUNNING) return;

  CONTRACTOR_SCAN_RUNNING = true;
  const scan = DASHBOARD_STATE.contractorScan;
  if (!scan.startedAt) scan.startedAt = new Date().toISOString();
  scan.status = "running";

  let nextDelay = 900;

  try {
    const raw = await bitrixCallRaw("crm.deal.list", {
      order: { ID: "DESC" },
      filter: {},
      select: [
        "ID","TITLE","COMPANY_ID","CONTACT_ID","STAGE_ID","STAGE_SEMANTIC_ID","CLOSED",
        "OPPORTUNITY","CURRENCY_ID","ASSIGNED_BY_ID",
        "DATE_CREATE","DATE_MODIFY","LAST_ACTIVITY_TIME",
        "COMMENTS","ADDITIONAL_INFO",
        "UF_CRM_1739950675115","UF_CRM_1728208341819",
        "UF_CRM_1728208250222","UF_CRM_1728208292193",
        "UF_CRM_1728208353618","UF_CRM_1728208500678",
        "UF_CRM_1728208529434","UF_CRM_1728208560055",
        "UF_CRM_1728208192427","UF_CRM_1790850696723",
        "UF_CRM_1728208597522","UF_CRM_1728208621363",
        AI_FIELDS.dealAnswers,
        AI_FIELDS.dealType,AI_FIELDS.dealRoles,AI_FIELDS.dealServices
      ],
      start: Number(scan.cursor || 0)
    });

    const deals = Array.isArray(raw.result) ? raw.result : [];
    scan.totalDeals = Number(raw.total || scan.totalDeals || 0);

    for (const deal of deals) {
      scan.scannedDealsPass += 1;
      scan.scannedDealsLifetime += 1;

      const sig = dealContractorSignals(deal);
      if (!sig.isCandidate) continue;

      const companyId = String(deal.COMPANY_ID || "");
      if (!companyId || companyId === "0") {
        scan.unlinkedCandidateDeals += 1;
        continue;
      }

      let item = CONTRACTOR_SCAN_CANDIDATES.get(companyId);
      const isNew = !item;

      if (!item) {
        item = {
          companyId,
          company: "",
          dealCount: 0,
          openDeals: 0,
          directCount: 0,
          tenderCount: 0,
          totalOpportunity: 0,
          wonOpportunity: 0,
          openOpportunity: 0,
          lostOpportunity: 0,
          unclassifiedOpportunity: 0,
          lastActivityMs: 0,
          lastActivity: "",
          maxSignalWeight: 0,
          managers: new Set(),
          managerNames: new Map(),
          currentWork: [],
          dealSnapshots: new Map(),
          purchasedProducts: [],
          relationshipStatus: "",
          managerQualityScore: 0,
          managerQualityLevel: "",
          managerQualitySummary: "",
          managerQualificationScore: 0,
          managerQualificationSummary: "",
          managerProcessIssue: "",
          managerAuditCheckedAt: 0,
          evidence: new Set(),
          sampleDeals: [],
          sampleDealContexts: [],
          verificationStatus: "pending",
          verificationConfidence: 0,
          contractorType: "",
          strategicScore: 0,
          strategicReason: "",
          industrialRelevance: "unknown",
          hazardousIndustrialSites: false,
          relevantWorkTypes: [],
          scaleLevel: "unknown",
          gasDetectionNeed: "unknown",
          verificationReason: "",
          identityEvidence: "",
          websiteEvidence: "",
          correspondenceEvidence: "",
          verifiedInn: "",
          verifiedWebsite: "",
        };
        CONTRACTOR_SCAN_CANDIDATES.set(companyId, item);
      }

      if (!item.company) {
        item.company = await contractorCompanyName(companyId);
      }

      const opportunity = Number(deal.OPPORTUNITY || 0) || 0;
      const semantic = String(deal.STAGE_SEMANTIC_ID || "").toUpperCase();
      const isOpen = String(deal.CLOSED || "").toUpperCase() !== "Y";
      const ps = purchaseSignals(deal);
      const activity = deal.LAST_ACTIVITY_TIME || deal.DATE_MODIFY || deal.DATE_CREATE || "";
      const dealKey = String(deal.ID || "");

      if (dealKey) {
        item.dealSnapshots.set(dealKey, {
          id: dealKey,
          title: String(deal.TITLE || "").trim(),
          opportunity,
          semantic,
          isOpen,
          direct: Boolean(ps.direct),
          tender: Boolean(ps.tender),
          signalWeight: Number(sig.weight || 0),
          stage: String(deal.STAGE_ID || ""),
          assignedById: String(deal.ASSIGNED_BY_ID || ""),
          lastActivity: activity,
          comments: String(deal.COMMENTS || "").slice(0, 5000),
          additionalInfo: String(deal.ADDITIONAL_INFO || "").slice(0, 3000),
          purchaseFormatRaw: asText(deal.UF_CRM_1728208250222),
          endCustomer: String(deal.UF_CRM_1728208529434 || ""),
          deliveryDeadline: String(deal.UF_CRM_1728208560055 || ""),
          brands: String(deal.UF_CRM_1728208353618 || ""),
          competitorPrices: String(deal.UF_CRM_1728208500678 || ""),
          analogs: asText(deal.UF_CRM_1728208192427),
          qualificationText: String(deal.UF_CRM_1790850696723 || "").slice(0, 10000),
          qualificationHistory: String(deal[AI_FIELDS.dealAnswers] || "").slice(0, 10000),
          quoteFilesRaw: deal.UF_CRM_1728208597522 || null,
          invoiceFilesRaw: deal.UF_CRM_1728208621363 || null,
        });
      }

      sig.reasons.forEach(x => item.evidence.add(x));
      if (deal.ASSIGNED_BY_ID) {
        const managerId = String(deal.ASSIGNED_BY_ID);
        item.managers.add(managerId);
        if (!item.managerNames.get(managerId)) {
          const resolvedSurname = await contractorUserName(managerId);
          if (resolvedSurname) item.managerNames.set(managerId, resolvedSurname);
        }
      }

      recomputeContractorDealMetrics(item);

      const ms = dateMs(activity);
      if (ms > item.lastActivityMs) {
        item.lastActivityMs = ms;
        item.lastActivity = activity;
      }

      const title = String(deal.TITLE || "").trim();
      if (title && !item.sampleDeals.includes(title)) {
        item.sampleDeals.unshift(title);
        item.sampleDeals = item.sampleDeals.slice(0, 6);
      }

      if (
        deal.ID &&
        !item.sampleDealContexts.some(x => String(x.id) === String(deal.ID))
      ) {
        item.sampleDealContexts.unshift({ id: String(deal.ID), title });
        item.sampleDealContexts = item.sampleDealContexts.slice(0, 4);
      }

      if (isNew) {
        scan.lastCandidateAt = new Date().toISOString();
        scan.recentDiscoveries.unshift({
          at: scan.lastCandidateAt,
          company: item.company || "Компания без названия",
          reason: sig.reasons.join(", "),
        });
        scan.recentDiscoveries = scan.recentDiscoveries.slice(0, 20);
      }
    }

    await verifyNextContractorCandidate();
    await refreshOneContractorRelationshipStatus();

    scan.lastBatchAt = new Date().toISOString();
    refreshContractorScanSummary();

    if (raw.next !== undefined && raw.next !== null && String(raw.next) !== "") {
      scan.cursor = Number(raw.next);
    } else {
      scan.lastCompletedPassAt = new Date().toISOString();
      scan.pass += 1;
      scan.cursor = 0;
      scan.scannedDealsPass = 0;
      nextDelay = 15000;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scan.status = "error";
    DASHBOARD_STATE.lastError = {
      at: new Date().toISOString(),
      source: "contractor-continuous-scan",
      message,
    };
    nextDelay = 10000;
  } finally {
    CONTRACTOR_SCAN_RUNNING = false;
    clearTimeout(CONTRACTOR_SCAN_TIMER);

    if (contractorScanPaused()) {
      DASHBOARD_STATE.contractorScan.status = "paused";
      CONTRACTOR_SCAN_TIMER = null;
    } else {
      CONTRACTOR_SCAN_TIMER = setTimeout(contractorScanStep, nextDelay);
    }
  }
}

function startContractorContinuousScan() {
  if (contractorScanPaused()) {
    DASHBOARD_STATE.contractorScan.status = "paused";
    console.log(JSON.stringify({
      source: "contractor-scan",
      action: "paused-by-env",
    }));
    return;
  }

  if (CONTRACTOR_SCAN_TIMER || CONTRACTOR_SCAN_RUNNING) return;
  DASHBOARD_STATE.contractorScan.status = "running";
  contractorScanStep().catch(error => {
    console.error("Unexpected continuous contractor scan error", error);
  });
}

function dashboardStatus() {
  const benchmark = DASHBOARD_STATE.contractorBenchmark || {};
  const results = Array.isArray(benchmark.results) ? benchmark.results : [];
  const scan = DASHBOARD_STATE.contractorScan || {};

  const counts = results.reduce((acc, item) => {
    const status = String(item.status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    service: "topsense-bitrix-ai",
    serviceStartedAt: DASHBOARD_STATE.serviceStartedAt,
    now: new Date().toISOString(),
    lastBitrixEventAt: DASHBOARD_STATE.lastBitrixEventAt,
    lastBitrixEvent: DASHBOARD_STATE.lastBitrixEvent,
    lastError: DASHBOARD_STATE.lastError,
    contractorScan: {
      status: scan.status || "starting",
      mode: scan.mode || "continuous-read-only",
      pass: Number(scan.pass || 1),
      cursor: Number(scan.cursor || 0),
      totalDeals: Number(scan.totalDeals || 0),
      scannedDealsPass: Number(scan.scannedDealsPass || 0),
      scannedDealsLifetime: Number(scan.scannedDealsLifetime || 0),
      candidateCompanies: Number(scan.candidateCompanies || 0),
      discoveredCandidates: Number(scan.discoveredCandidates || 0),
      verifiedContractors: Number(scan.verifiedContractors || 0),
      pendingVerification: Number(scan.pendingVerification || 0),
      rejectedCandidates: Number(scan.rejectedCandidates || 0),
      unclearCandidates: Number(scan.unclearCandidates || 0),
      highPotential: Number(scan.highPotential || 0),
      directPurchaseCompanies: Number(scan.directPurchaseCompanies || 0),
      tenderOnlyCompanies: Number(scan.tenderOnlyCompanies || 0),
      unlinkedCandidateDeals: Number(scan.unlinkedCandidateDeals || 0),
      startedAt: scan.startedAt || null,
      lastBatchAt: scan.lastBatchAt || null,
      lastCompletedPassAt: scan.lastCompletedPassAt || null,
      topCandidates: Array.isArray(scan.topCandidates) ? scan.topCandidates : [],
      recentDiscoveries: Array.isArray(scan.recentDiscoveries) ? scan.recentDiscoveries : [],
      persistedContractors: PERSISTED_CONTRACTORS.size,
      persistentStoreConfigured: sheetStoreConfigured(),
      classifiedCompanyRegistry: PERSISTED_COMPANY_TYPES.size,
      pendingCompanyRegistry: PERSISTED_PENDING_COMPANIES.size,
      pendingCompanies: [...PERSISTED_PENDING_COMPANIES.values()]
        .sort((a,b) => dateMs(b?.queuedAt || b?.lastActivity) - dateMs(a?.queuedAt || a?.lastActivity))
        .slice(0, 100),
      lastDailyScanDate: scan.lastDailyScanDate || null,
      lastDailyScanAt: scan.lastDailyScanAt || null,
      dailyScanEnabled: dailyContractorScanEnabled(),
      openAiPaused: openAiPaused(),
    },
    similarContractors: DASHBOARD_STATE.similarContractors || {
      status: "scanning-bitrix",
      target: 30,
      completed: 0,
    },
    contractorBenchmark: {
      status: benchmark.status || "idle",
      total: Number(benchmark.total || 0),
      completed: Number(benchmark.completed || 0),
      current: benchmark.current || "",
      startedAt: benchmark.startedAt || null,
      finishedAt: benchmark.finishedAt || null,
      counts,
      results: results.map(item => ({
        seed: item.seed || "",
        matched_company: item.matched_company || item.profile?.company_name || "",
        status: item.status || "",
        quick_sale_score: item.profile?.quick_sale_score ?? null,
        profile: item.profile?.profile || "",
        reason: item.reason || item.profile?.why_interesting_for_topsense || item.error || "",
      })),
    },
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bitrixCompanyUrl(companyId) {
  const id = String(companyId || "").trim();
  return id ? "https://topsense.bitrix24.ru/crm/company/details/" + encodeURIComponent(id) + "/" : "";
}

function dashboardHtml(status = dashboardStatus()) {
  const scan = status.contractorScan || {};
  const totalDeals = Number(scan.totalDeals || 0);
  const scanned = Number(scan.scannedDealsPass || 0);
  const pct = totalDeals ? Math.min(100, Math.round(scanned / totalDeals * 100)) : 0;
  const top = Array.isArray(scan.topCandidates) ? scan.topCandidates : [];
  const pending = Array.isArray(scan.pendingCompanies) ? scan.pendingCompanies : [];
  const recent = Array.isArray(scan.recentDiscoveries) ? scan.recentDiscoveries : [];

  const money = value => {
    const n = Number(value || 0);
    if (!n) return "—";
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  };

  const dateOnly = value => {
    const t = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) return "—";
    const d = new Date(t);
    return String(d.getUTCDate()).padStart(2, "0") + "." +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "." +
      d.getUTCFullYear();
  };

  const strategicShort = item => {
    const parts = [];
    if (item.hazardousIndustrialSites) parts.push("ОПО");
    if (String(item.scaleLevel || "") === "large") parts.push("крупная");
    for (const x of (item.relevantWorkTypes || []).slice(0, 2)) {
      const v = String(x || "").trim();
      if (v && !parts.includes(v)) parts.push(v);
    }
    return parts.slice(0, 3).join(" · ");
  };

  const visibleNameCounts = new Map();
  for (const item of top) {
    const key = normalizedCompanyTitle(item.company);
    if (key) visibleNameCounts.set(key, (visibleNameCounts.get(key) || 0) + 1);
  }

  const topRows = top.slice(0, 50).map((item, idx) => {
    const score = Number(item.score || 0);
    const cls = score >= 70 ? "ok" : score >= 50 ? "warn" : "";
    return `<tr>
      <td>${idx + 1}</td>
      <td><b>${bitrixCompanyUrl(item.companyId) ? `<a class="companylink" href="${escapeHtml(bitrixCompanyUrl(item.companyId))}" target="_blank" rel="noopener">${escapeHtml(item.company || "—")}</a>` : escapeHtml(item.company || "—")}</b>${visibleNameCounts.get(normalizedCompanyTitle(item.company)) > 1 ? '<span class="mini">ИНН ' + escapeHtml(item.inn || "не найден") + '</span>' : ''}</td>
      <td><span class="badge ${cls}">${score}/100</span></td>
      <td class="compact"><span class="badge">${Number(item.strategicScore || 0)}</span><span class="mini">${escapeHtml(strategicShort(item) || "—")}</span></td>
      <td class="center">${Number(item.dealCount || 0)}${Number(item.openDeals || 0) ? " / " + Number(item.openDeals || 0) : ""}</td>
      <td class="nowrap">${escapeHtml(dateOnly(item.lastActivity))}</td>
      <td class="moneycell">✓ ${escapeHtml(money(item.wonOpportunity))}<br>↗ ${escapeHtml(money(item.openOpportunity))}<br>× ${escapeHtml(money(item.lostOpportunity))}</td>
      <td class="productcell" title="${escapeHtml((item.purchasedProducts || []).map(x => x.product).join(" • "))}">${escapeHtml((item.purchasedProducts || []).slice(0,2).map(x => {
        const qty = Number(x.quantity || 0);
        const model = normalizeDashboardProductName(x.product);
        const gases = extractGasList(x.product);
        const label = model
          ? model + (gases.length ? " (" + gases.join("/") + ")" : "")
          : (gases.length ? gases.join("/") : "—");
        return label + (qty ? " ×" + new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(qty) : "");
      }).join(" · ") || "—")}</td>
      <td class="managercell">${escapeHtml((item.managerNames || []).join(", ") || "—")}<br><span class="qualbadge">Квал. ${Number(item.managerQualificationScore || 0)}/55</span><br><span class="qualsummary">${escapeHtml(item.managerQualificationSummary || "")}</span><br><span class="auditbadge">Работа ${Number(item.managerQualityScore || 0)}/100 · ${escapeHtml(item.managerQualityLevel || "—")}</span><br><span class="audittags">${escapeHtml(item.managerQualitySummary || "")}</span></td>
      <td class="statuscell" title="${escapeHtml(item.relationshipStatus || "")}">${escapeHtml(item.relationshipStatus || "—")}</td>
    </tr>`;
  }).join("");

  const pendingRows = pending.map((item, idx) => {
    const inn = String(item.inn || "").trim();
    const latestDeal = Array.isArray(item.sampleDeals) && item.sampleDeals.length
      ? item.sampleDeals[0]
      : "—";
    const statusText = scan.openAiPaused
      ? "Ждёт пополнения API"
      : "Ждёт AI-проверки";
    return `<tr>
      <td>${idx + 1}</td>
      <td><b>${bitrixCompanyUrl(item.companyId) ? `<a class="companylink" href="${escapeHtml(bitrixCompanyUrl(item.companyId))}" target="_blank" rel="noopener">${escapeHtml(item.company || "—")}</a>` : escapeHtml(item.company || "—")}</b></td>
      <td class="nowrap">${escapeHtml(inn || "—")}</td>
      <td class="nowrap">${escapeHtml(item.companyId || "—")}</td>
      <td>${escapeHtml(latestDeal)}</td>
      <td class="nowrap">${escapeHtml(dateOnly(item.queuedAt || item.lastActivity))}</td>
      <td><span class="badge warn">${escapeHtml(statusText)}</span></td>
    </tr>`;
  }).join("");

  const recentRows = recent.slice(0, 12).map(item => `<tr>
    <td>${escapeHtml(item.at || "")}</td>
    <td><b>${escapeHtml(item.company || "")}</b></td>
    <td>${escapeHtml(item.reason || "")}</td>
  </tr>`).join("");

  const errorText = status.lastError
    ? `${escapeHtml(status.lastError.at || "")} — ${escapeHtml(status.lastError.source || "")}: ${escapeHtml(status.lastError.message || "")}`
    : "Нет";

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>TOP-SENSE — Подрядчики</title>
<style>
:root{color-scheme:dark;background:#0b1020;color:#e8edf7;font-family:Inter,Arial,sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:#0b1020}.wrap{max-width:none;width:100%;margin:0;padding:14px 16px}
h1{font-size:27px;margin:0 0 5px}.sub{color:#9aa7bd;margin-bottom:11px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:11px}
.card{background:#131b2f;border:1px solid #25314e;border-radius:10px;padding:10px 12px}.k{color:#92a1ba;font-size:12px;text-transform:uppercase}.v{font-size:23px;font-weight:700;margin-top:3px}.small{font-size:12px;color:#aab6c9;margin-top:2px}
.bar{height:6px;background:#24304b;border-radius:999px;overflow:hidden;margin-top:5px}.fill{height:100%;background:#5d8cff}
.section{margin-top:10px}.section h2{font-size:19px;margin:0 0 7px}
table{width:100%;min-width:1580px;border-collapse:collapse;table-layout:fixed;background:#131b2f}
table.queue{min-width:1100px}
.col-num{width:34px}.col-company{width:180px}.col-priority{width:76px}.col-strategy{width:150px}.col-deals{width:82px}.col-contact{width:106px}.col-money{width:108px}.col-bought{width:92px}.col-manager{width:370px}.col-now{width:430px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #25314e;font-size:15px;line-height:1.28;vertical-align:middle}
th{color:#9aa7bd;font-size:12px;text-transform:uppercase;position:sticky;top:0;background:#131b2f}
th:first-child,td:first-child{text-align:center;padding-left:2px;padding-right:2px}
th:nth-child(3),td:nth-child(3){text-align:center;padding-left:3px;padding-right:3px}
th:nth-child(8),td:nth-child(8){padding-left:4px;padding-right:4px}
.badge{display:inline-block;padding:3px 6px;border-radius:999px;background:#263653;font-size:13px}.ok{background:#173b2b;color:#9ce4bd}.warn{background:#4a3718;color:#ffd37a}.err{background:#4a2027;color:#ff9aa7}.companylink{color:#e8edf7;text-decoration:none;border-bottom:1px dotted #667895}.companylink:hover{color:#fff;border-bottom-color:#fff}
.scroll{overflow:auto;max-height:calc(100vh - 235px);border-radius:10px}.note{margin-top:6px;color:#8290a7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.live{color:#9ce4bd}
.productcell{white-space:normal;overflow:visible;line-height:1.2}.statuscell{white-space:normal;overflow:visible;line-height:1.24}.compact{white-space:normal;overflow:visible}.mini{display:block;font-size:13px;color:#b7c2d6;margin-top:3px;white-space:normal;line-height:1.22;overflow:visible}
.nowrap{white-space:nowrap}.center{text-align:center}.moneycell{white-space:nowrap;font-size:13px}.managercell{white-space:normal;line-height:1.25}.qualbadge{display:inline-block;margin-top:4px;font-size:18px;font-weight:800}.qualsummary{display:block;margin-top:3px;font-size:14px;color:#d3dced}.auditbadge{display:inline-block;margin-top:6px;font-size:15px;font-weight:700}.audittags{display:block;margin-top:3px;font-size:13px;color:#aebbd0}
@media(max-width:1400px){table{min-width:1500px}th,td{font-size:14px;padding:8px}.mini{font-size:12px}.qualbadge{font-size:17px}.qualsummary{font-size:13px}.auditbadge{font-size:14px}.audittags{font-size:12px}.grid{grid-template-columns:repeat(6,1fr)}}
</style>
</head>
<body><div class="wrap">
<h1>ДАШБОРД — ПОДРЯДЧИКИ</h1>
<div class="sub">Новые компании из CRM → очередь → однократная AI-классификация → постоянный реестр. <span class="live">● live</span></div>

<div class="grid">
  <div class="card"><div class="k">Режим</div><div class="v">${scan.openAiPaused ? "Без AI" : "AI включён"}</div><div class="small">${scan.openAiPaused ? "кредиты не расходуются" : "новые компании классифицируются"}</div></div>
  <div class="card"><div class="k">Последний проход</div><div class="v">${escapeHtml(scan.lastDailyScanDate || "—")}</div><div class="small">${scan.lastDailyScanAt ? "завершён " + escapeHtml(dateOnly(scan.lastDailyScanAt)) : "ежедневный сбор новых компаний"}</div></div>
  <div class="card"><div class="k">Подтверждённых подрядчиков</div><div class="v">${Number(scan.verifiedContractors || 0)}</div><div class="small">после внешней проверки</div></div>
  <div class="card"><div class="k">Ждут AI-проверки</div><div class="v">${Number(scan.pendingCompanyRegistry || 0)}</div><div class="small">новые компании сохранены в Google Таблице</div></div>
  <div class="card"><div class="k">Прямая закупка</div><div class="v">${Number(scan.directPurchaseCompanies || 0)}</div><div class="small">включая смешанный формат</div></div>
  <div class="card"><div class="k">Только тендеры</div><div class="v">${Number(scan.tenderOnlyCompanies || 0)}</div><div class="small">по заполненным полям B24</div></div>
</div>


<div class="section"><h2>Новые компании — очередь на проверку</h2>
<div class="scroll"><table class="queue">
<thead><tr><th>#</th><th>Компания</th><th>ИНН</th><th>Bitrix ID</th><th>Последняя сделка</th><th>Добавлена</th><th>Статус</th></tr></thead>
<tbody>${pendingRows || `<tr><td colspan="7">Очередь пуста.</td></tr>`}</tbody>
</table></div></div>

<div class="section"><h2>Подтверждённые подрядчики</h2>
<div class="scroll"><table>
<colgroup>
  <col class="col-num">
  <col class="col-company">
  <col class="col-priority">
  <col class="col-strategy">
  <col class="col-deals">
  <col class="col-contact">
  <col class="col-money">
  <col class="col-bought">
  <col class="col-manager">
  <col class="col-now">
</colgroup>
<thead><tr><th>#</th><th>Компания</th><th>Приоритет</th><th>Стратегия</th><th>Сделки / откр.</th><th>Последний контакт</th><th>Деньги<br>✓ / ↗ / ×</th><th>Что купили</th><th>Менеджер / работа</th><th>Сейчас</th></tr></thead>
<tbody>${topRows || `<tr><td colspan="10">Пока нет компаний, прошедших проверку ИНН/официального сайта. CRM-тип сам по себе больше не считается доказательством.</td></tr>`}</tbody>
</table></div></div>

<div class="note">✓ выиграно · ↗ открыто · × проиграно. «Сейчас» — краткий итог последнего общения. Успешная сделка ≠ подтверждённая оплата.</div>
</div></body></html>`;
}


const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";

  // Secure visual analytics; CRM data is read on demand from the existing Bitrix integration.
  if (require("./crm-dashboard").route(req, res, pathname, () => [...PERSISTED_COMPANY_TYPES.values()])) return;


  if (
    req.method === "GET" &&
    (
      pathname === "/dashboard" ||
      pathname === "/contractors" ||
      pathname === "/dashboard/contractors"
    )
  ) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(dashboardHtml(dashboardStatus()));
  }

  if (
    req.method === "GET" &&
    (
      pathname === "/dashboard/status" ||
      pathname === "/contractors/status" ||
      pathname === "/dashboard/contractors/status"
    )
  ) {
    return json(res, 200, dashboardStatus());
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return json(res, 200, {
      ok: true,
      service: "topsense-bitrix-ai",
      status: "ready",
      bitrixReadConfigured: Boolean(process.env.BITRIX_WEBHOOK_BASE),
      openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
      openAIModel: process.env.OPENAI_MODEL || "gpt-6-sol",
      bitrixWriteEnabled: "test-deals-only",
    });
  }

  if (req.method === "POST" && req.url === "/bitrix/events") {
    let raw = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413);
        res.end("payload too large");
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });

    req.on("end", () => {
      const parsed = parseBody(raw, req.headers["content-type"]);
      const evt = extractEvent(parsed);

      const expectedToken = process.env.BITRIX_OUTBOUND_TOKEN;
      if (expectedToken && evt.applicationToken !== expectedToken) {
        console.warn("Rejected Bitrix event: invalid application token");
        return json(res, 401, { ok: false, error: "invalid token" });
      }

      DASHBOARD_STATE.lastBitrixEventAt = new Date().toISOString();
      DASHBOARD_STATE.lastBitrixEvent = String(evt.event || "");

      console.log(
        JSON.stringify({
          source: "bitrix24",
          action: "event-received",
          event: evt.event,
          dealId: evt.dealId,
          activityId: evt.activityId || null,
          activityProviderId: evt.activityProviderId || null,
          activityDirection: evt.activityDirection || null,
          activityOwnerTypeId: evt.activityOwnerTypeId || null,
          receivedAt: new Date().toISOString(),
        })
      );

      json(res, 200, {
        ok: true,
        event: evt.event,
        dealId: evt.dealId,
        activityId: evt.activityId || null,
      });

      const upperEvent = String(evt.event || "").toUpperCase();
      const work = upperEvent === "ONCRMACTIVITYADD"
        ? processActivityEvent(evt)
        : processDeal(evt);

      work.catch(error => {
        console.error("Unexpected Bitrix event processing error", error);
      });
    });

    return;
  }

  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TOP-SENSE Bitrix receiver listening on port ${PORT}`);

  // Old test maintenance is opt-in only. It must not silently consume API credits.
  if (String(process.env.TEST_MAINTENANCE_ENABLED || "").trim() === "1") {
    setTimeout(() => {
      reconcileRecentTestDeals().catch(error => {
        console.error("Unexpected reconciliation error", error);
      });
      cleanupDuplicateRoutingTestDeals().catch(error => {
        console.error("Unexpected test routing cleanup error", error);
      });
      rollbackMistakenTest16Target().catch(error => {
        console.error("Unexpected TEST16 rollback error", error);
      });
      reprocessCurrentTitleFormatTest().catch(error => {
        console.error("Unexpected title-format test reprocess error", error);
      });
      migrateKnownTestDealTitles().catch(error => {
        console.error("Unexpected test title migration error", error);
      });
    }, 4000);
  }

  // Isolated read-only pilot: only if deliberately enabled on Render.
  // The legacy contractor automation retains its independent OPENAI_PAUSED setting.
  if (String(process.env.TOPSENSE_PILOT_ENABLED || "").trim() === "1") {
    setTimeout(() => {
      require("./pilot").runPilot().catch((error) => {
        console.error(JSON.stringify({
          component: "topsense-pilot",
          event: "fatal",
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }));
      });
    }, 10000);
  }

  // Load the permanent company registry. Continuous historical scanning stays opt-in.
  setTimeout(async () => {
    await loadPersistedContractors();
    startContractorContinuousScan();
    dailyContractorScanTick().catch(error => {
      console.error("Unexpected daily contractor scan error", error);
    });
  }, 6500);

  // Check periodically while awake. If Render slept through the evening,
  // the next wake catches up the missed previous day.
  setInterval(() => {
    dailyContractorScanTick().catch(error => {
      console.error("Unexpected daily contractor scan error", error);
    });

    if (String(process.env.TEST_MAINTENANCE_ENABLED || "").trim() === "1") {
      reconcileRecentTestDeals().catch(error => {
        console.error("Unexpected reconciliation error", error);
      });
    }
  }, 15 * 60 * 1000);
});

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
            signal: AbortSignal.timeout(20000),
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
    "company должен содержать: name, inn, website, phone, email, region, city, address, is_manufacturer, manufactured_products, manufacturer_reason, services, roles, revenue, revenue_year, revenue_previous, revenue_previous_year, revenue_growth_percent, net_profit, financial_source. Неизвестные текстовые значения оставляй пустой строкой.",
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
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

  // Reconcile missed Bitrix events after wake/redeploy.
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

  // While the free instance is awake, re-check periodically.
  setInterval(() => {
    reconcileRecentTestDeals().catch(error => {
      console.error("Unexpected reconciliation error", error);
    });
  }, 5 * 60 * 1000);
});

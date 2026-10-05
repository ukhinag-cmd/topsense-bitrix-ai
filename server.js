const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");

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
    return {
      event: body.event || body.EVENT || null,
      dealId:
        getNested(body, ["data", "FIELDS", "ID"]) ||
        getNested(body, ["data", "ID"]) ||
        body.dealId ||
        null,
      applicationToken:
        getNested(body, ["auth", "application_token"]) ||
        body.application_token ||
        null,
    };
  }

  const p = parsed.value;
  return {
    event: p.get("event") || p.get("EVENT"),
    dealId:
      p.get("data[FIELDS][ID]") ||
      p.get("data[ID]") ||
      p.get("dealId"),
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
    if (
      analysis.client_type &&
      analysis.client_type !== "Не определено" &&
      String(company[AI_FIELDS.companyType] || "") !== analysis.client_type
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
      const rolesText = analysis.company.roles.join(", ");
      if (String(company[AI_FIELDS.companyRoles] || "") !== rolesText) {
        patch[AI_FIELDS.companyRoles] = rolesText;
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

function parseQuestionAnswers(text) {
  const source = String(text || "");
  const re = /(\d+)\.\s*([^\r\n]+)\r?\nОтвет:\s*([\s\S]*?)(?=(?:\r?\n){2,}\d+\.|$)/g;
  const answers = [];
  let match;

  while ((match = re.exec(source)) !== null) {
    const question = String(match[2] || "").trim();
    const answer = String(match[3] || "").trim();
    if (question && answer) answers.push({ question, answer });
  }

  return answers;
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

  const count = Array.isArray(analysis.question_keys) ? analysis.question_keys.length : 0;
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
  const count = Array.isArray(analysis.question_keys) ? analysis.question_keys.length : 0;
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

  const keys = Array.isArray(analysis.question_keys)
    ? analysis.question_keys.slice(0, 6)
    : [];

  const questions = keys
    .map(key => questionText(analysis.client_type, key))
    .filter(Boolean);

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

async function buildDealContext(deal) {
  let linkedContact = null;

  try {
    linkedContact = await getContact(deal.CONTACT_ID);
  } catch {}

  const activities = await getRecentDealActivities(deal.ID);
  const attachments = await downloadRecentAttachments(activities);

  const baseContext = {
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
    linked_contact: context.linked_contact || null,
    recent_activities: context.recent_activities || [],
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
          client_type: { type: "string" },
          classification_reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          purchase_format: { type: "string" },
          delivery_deadline: { type: "string" },
          question_keys: {
            type: "array",
            items: { type: "string" },
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
          "client_type",
          "classification_reason",
          "confidence",
          "purchase_format",
          "delivery_deadline",
          "question_keys",
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
    "client_type — это основной тип компании именно для текущей продажи и выбора вопросов, но он не должен скрывать другие роли компании.",
    "Если компания реально производит продукцию, это должно быть явно отражено даже если она одновременно продаёт, комплектует, интегрирует или оказывает сервис.",
    "Если собственное производство — основная деятельность, не классифицируй компанию как чистую Торговую компанию / комплектатора. Обычно выбирай Завод / промышленное предприятие, а для производителя газоаналитического оборудования — Производитель газоаналитического оборудования / конкурент.",
    "Тип компании определяй по основной деятельности компании, а не только по товару в текущем запросе и не по должности отправителя.",
    "Если официальный сайт прямо говорит о собственной разработке или производстве газоанализаторов, газоаналитического оборудования, датчиков газа или близкой продукции, классифицируй как Производитель газоаналитического оборудования / конкурент. Не относить такого клиента к торговой компании только потому, что на сайте есть каталог или продажи.",
    "Если есть sender_domain, используй его сразу как один из главных идентификаторов компании. Название из подписи сверяй с этим доменом.",
    "Если есть domain_website, это содержимое сайта домена отправителя. Используй его как первичный источник для определения деятельности компании, её названия и типа.",
    "Для company.phone и company.email приоритет имеют контакты с официального сайта domain_website. Не копируй персональный телефон отправителя в карточку компании, если на сайте есть отдельный общий телефон.",
    "Для contact.phone и contact.email используй только данные самого письма/подписи/контакта Bitrix, не контакты с сайта компании.",
    "Если тип нельзя определить уверенно, используй Не определено.",
    "classification_reason — одно короткое предложение, почему выбран этот тип.",
    "После определения типа выбери question_keys только из правил соответствующего типа.",
    "Не придумывай новые вопросы и не меняй формулировки: текст вопросов хранится в коде.",
    "Не выбирай вопрос, если ответ уже явно есть в названии, комментарии или полях сделки.",
    "Обычно выбери 3–6 вопросов. Из них 1–2 могут быть продающими, если базовая потребность уже понятна.",
    "Не требуй имя конечного заказчика.",
    "Извлеки из сделки данные компании и контактного лица. Для входящих email-заявок обязательно анализируй recent_activities: там может находиться тема, текст письма, подпись отправителя и коммуникации.",
    "company должен содержать: name, inn, website, phone, email, region, city, address, is_manufacturer, manufactured_products, manufacturer_reason, services, roles. Неизвестные текстовые значения оставляй пустой строкой.",
    "contact должен содержать: name, first_name, last_name, second_name, position, email, phone. Неизвестные значения оставляй пустой строкой.",
    "Для contact используй персональные данные только если они явно есть в самой заявке/подписи. Не ищи персональные контакты людей в интернете.",
    "Правила вопросов: " + JSON.stringify(QUESTION_RULES),
    "Ответь только валидным JSON без markdown.",
    "JSON должен содержать: client_type, classification_reason, confidence, purchase_format, delivery_deadline, question_keys, known_facts, company, contact."
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
      analysis = parseJsonText(domainText);
      finalPayload = domainPayload;
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
        analysis = parseJsonText(researchText);
        finalPayload = researchPayload;
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
      if (haystack.includes("AI WEBHOOK TEST 15")) return true;
      if (!questions.includes("Тип:")) return true;
      if (questions.includes("Тип: Не определено")) return true;
      if (
        String(deal.ID) === "39626" &&
        !questions.includes("Роли:")
      ) return true;
      return false;
    });

    // Some email-created deals don't keep the original subject in TITLE/COMMENTS.
    // If no direct match is found, inspect recent email activities for the test marker.
    if (!candidates.length) {
      const recent = deals.slice(0, 12).filter(deal => {
        const createdAt = Date.parse(deal.DATE_CREATE || "");
        return createdAt && createdAt >= cutoff;
      });

      for (const deal of recent) {
        try {
          const activities = await bitrixCall("crm.activity.list", {
            order: { ID: "DESC" },
            filter: {
              OWNER_TYPE_ID: 2,
              OWNER_ID: Number(deal.ID),
            },
            select: ["ID", "SUBJECT", "DESCRIPTION"],
          });

          const activityHaystack = Array.isArray(activities)
            ? activities
                .slice(0, 5)
                .flatMap(item => [item.SUBJECT, stripHtml(item.DESCRIPTION)])
                .filter(Boolean)
                .join("\n")
                .toUpperCase()
            : "";

          if (activityHaystack.includes("AI WEBHOOK TEST 15")) {
            candidates = [deal];
            break;
          }
        } catch {}
      }
    }

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
    if (Date.now() - selfUpdatedAt < 15000) {
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

    const testHaystack = [
      deal.TITLE,
      deal.COMMENTS,
      deal.ADDITIONAL_INFO,
    ]
      .filter(Boolean)
      .join("\n")
      .toUpperCase();

    const isTestDeal = testHaystack.includes("AI WEBHOOK TEST");

    // Until the test contour is approved, do not enrich or modify real deals.
    if (!isTestDeal) {
      console.log(JSON.stringify({
        source: "pipeline",
        action: "non-test-deal-skipped",
        dealId: String(deal.ID),
      }));
      return;
    }

    await ensureAIFields();
    await ensureMultilineDealField("UF_CRM_1790850696723");

    // Re-read after possible custom-field creation so new fields are present.
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
        questionCount: Array.isArray(result.analysis?.question_keys)
          ? result.analysis.question_keys.length
          : 0,
        webUsed: result.webUsed,
        webSourceCount: result.webSources.length,
        analyzedAt: new Date().toISOString(),
      })
    );

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
          receivedAt: new Date().toISOString(),
        })
      );

      json(res, 200, {
        ok: true,
        event: evt.event,
        dealId: evt.dealId,
      });

      processDeal(evt).catch(error => {
        console.error("Unexpected deal processing error", error);
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
  }, 4000);

  // While the free instance is awake, re-check periodically.
  setInterval(() => {
    reconcileRecentTestDeals().catch(error => {
      console.error("Unexpected reconciliation error", error);
    });
  }, 5 * 60 * 1000);
});

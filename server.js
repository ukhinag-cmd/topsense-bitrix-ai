const http = require("http");

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
  companyType: "UF_CRM_AI_CLIENT_TYPE",
  companyReason: "UF_CRM_AI_CLASS_REASON",
  companyInn: "UF_CRM_AI_INN",
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
  await ensureUserField("company", "AI_CLIENT_TYPE", "ИИ: Тип компании", 1);
  await ensureUserField("company", "AI_CLASS_REASON", "ИИ: Основание классификации", 3);
  await ensureUserField("company", "AI_INN", "ИИ: ИНН", 1);
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
    if (isEmpty(company[AI_FIELDS.companyType]) && analysis.client_type && analysis.client_type !== "Не определено") {
      patch[AI_FIELDS.companyType] = analysis.client_type;
    }
    if (isEmpty(company[AI_FIELDS.companyReason]) && analysis.classification_reason) {
      patch[AI_FIELDS.companyReason] = cleanReason(analysis.classification_reason);
    }

    addMultifieldPatch(patch, company, "PHONE", companyData.phone, normalizePhone);
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

function dealForAI(deal) {
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

function analysisInstructions() {
  return [
    "Ты квалификатор входящих B2B-заявок российского производителя промышленных газоанализаторов ТОП-СЕНС.",
    "Сначала определи тип компании по данным сделки. Не выдумывай факты.",
    "Допустимые типы: " + Object.keys(QUESTION_RULES).concat(["Не определено"]).join(", ") + ".",
    "СНГ — это география, а тендер — способ закупки, не тип компании.",
    "Тип компании определяй по основной деятельности компании, а не только по товару в текущем запросе и не по должности отправителя.",
    "Если тип нельзя определить уверенно, используй Не определено.",
    "classification_reason — одно короткое предложение, почему выбран этот тип.",
    "После определения типа выбери question_keys только из правил соответствующего типа.",
    "Не придумывай новые вопросы и не меняй формулировки: текст вопросов хранится в коде.",
    "Не выбирай вопрос, если ответ уже явно есть в названии, комментарии или полях сделки.",
    "Обычно выбери 3–6 вопросов. Из них 1–2 могут быть продающими, если базовая потребность уже понятна.",
    "Не требуй имя конечного заказчика.",
    "Извлеки из сделки данные компании и контактного лица. Данные можно брать только из сделки и, при веб-поиске, из открытых источников.",
    "company должен содержать: name, inn, website, phone, email, region, city, address. Неизвестные значения оставляй пустой строкой.",
    "contact должен содержать: name, first_name, last_name, second_name, position, email, phone. Неизвестные значения оставляй пустой строкой.",
    "Для contact используй персональные данные только если они явно есть в самой заявке/подписи. Не ищи персональные контакты людей в интернете.",
    "Правила вопросов: " + JSON.stringify(QUESTION_RULES),
    "Ответь только валидным JSON без markdown.",
    "JSON должен содержать: client_type, classification_reason, confidence, purchase_format, delivery_deadline, question_keys, known_facts, company, contact."
  ].join("\n");
}

async function analyzeDeal(deal, allowWebSearch = false) {
  const model = (process.env.OPENAI_MODEL || "gpt-6-luna").trim();
  const input = dealForAI(deal);

  const firstPayload = await callOpenAI({
    model,
    store: false,
    max_output_tokens: 1200,
    instructions: analysisInstructions(),
    input: [
      {
        role: "user",
        content:
          "Проанализируй новую сделку и верни квалификацию. Данные сделки:\n" +
          JSON.stringify(input),
      },
    ],
  });

  const firstText = extractResponseText(firstPayload);
  if (!firstText) {
    throw new Error("OpenAI returned no text output");
  }

  let analysis = parseJsonText(firstText);
  let finalPayload = firstPayload;
  let webUsed = false;
  let webSources = [];

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
      max_output_tokens: 1600,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      instructions: [
        analysisInstructions(),
        "Перед ответом обязательно выполни веб-поиск.",
        "Ищи компанию по названию, ИНН и сайту, если они присутствуют в данных сделки.",
        "Приоритет: официальный сайт компании, затем надёжные бизнес-реестры и каталоги.",
        "Определи тип по фактической основной деятельности компании.",
        "Найди и заполни по открытым источникам компанию: официальное название, ИНН, сайт, общий телефон, общий email, регион, город и адрес, если они надёжно подтверждаются.",
        "Не ищи в интернете персональные телефон, email или ФИО контактного лица.",
        "Не делай вывод только по текущему товару, который компания запрашивает.",
        "Если найденных данных всё равно недостаточно, оставь тип Не определено."
      ].join("\n"),
      input: [
        {
          role: "user",
          content:
            "Уточни тип компании через открытые источники и заново выбери вопросы. " +
            "Данные сделки:\n" +
            JSON.stringify(input) +
            "\nПервичный анализ:\n" +
            JSON.stringify(analysis),
        },
      ],
    });

    const researchText = extractResponseText(researchPayload);
    if (!researchText) {
      throw new Error("OpenAI web research returned no text output");
    }

    analysis = parseJsonText(researchText);
    finalPayload = researchPayload;
    webUsed = true;
    webSources = extractWebSources(researchPayload);
  }

  return {
    model: finalPayload.model || model,
    responseId: finalPayload.id || null,
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

    const candidates = deals.slice(0, 50).filter(deal => {
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
      return !questions.includes("Тип:");
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

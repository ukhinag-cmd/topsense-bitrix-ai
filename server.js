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
  const url = new URL("crm.deal.get.json", bitrixBaseUrl());
  url.searchParams.set("ID", String(dealId));

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Bitrix deal read failed with HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.error) {
    throw new Error(
      `Bitrix deal read failed: ${payload.error_description || payload.error}`
    );
  }

  if (!payload.result || !payload.result.ID) {
    throw new Error("Bitrix deal read returned no deal");
  }

  return payload.result;
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

function formatManagerQuestions(analysis) {
  const blocks = [];

  if (analysis.client_type && analysis.client_type !== "Не определено") {
    blocks.push("Клиент: " + analysis.client_type);
  }

  if (analysis.purchase_format && analysis.purchase_format !== "unknown") {
    blocks.push("Закупка: " + analysis.purchase_format);
  }

  if (analysis.delivery_deadline && analysis.delivery_deadline !== "unknown") {
    blocks.push("Срок: " + analysis.delivery_deadline);
  }

  const questions = Array.isArray(analysis.manager_questions)
    ? analysis.manager_questions.slice(0, 6)
    : [];

  questions.forEach((q, i) => blocks.push(`${i + 1}. ${q}`));

  return blocks.join("\r\n\r\n");
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
  };
}

async function analyzeDeal(deal) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = (process.env.OPENAI_MODEL || "gpt-6-sol").trim();
  const input = dealForAI(deal);

  const instructions = [
    "Ты квалификатор входящих B2B-заявок российского производителя промышленных газоанализаторов ТОП-СЕНС.",
    "Работай только по данным сделки. Не выдумывай факты.",
    "Если данных недостаточно, явно укажи unknown и сформулируй вопрос менеджеру.",
    "Не придумывай новые направления квалификации и не меняй смысл вопросов.",
    "manager_questions выбирай только из этого фиксированного списка и сохраняй формулировки дословно:",
    "Какая модель, газ и диапазон измерения нужны?",
    "Кто конечный заказчик?",
    "Тендер или прямая закупка?",
    "К какому сроку нужна поставка?",
    "В какой регион нужна поставка?",
    "Рассматриваете аналоги?",
    "Каких производителей ещё рассматриваете?",
    "Есть ли цены конкурентов?",
    "Как часто бывают запросы на газоанализаторы?",
    "Готовы рассмотреть дилерский договор?",
    "Выбирай только вопросы, ответы на которые отсутствуют в сделке.",
    "Не задавай вопросы про оплату, взрывозащиту и другие темы вне этого списка.",
    "Оставляй максимум 6 вопросов.",
    "Допустимые типы клиента: Дилер, Потенциальный дилер, Дистрибьютор, Завод, Подрядчик, Сервисная компания, Тендерщики, СНГ, Не определено.",
    "Не выводи телефоны, email и другие персональные контакты.",
    "Ответь только валидным JSON без markdown.",
    "JSON должен содержать поля: summary (string), client_type (string), confidence (number 0..1), purchase_format (string), end_customer (string), delivery_deadline (string), analogs (string), competitor_prices (string), manager_questions (array of strings, максимум 10), risks (array of strings), evidence (array of strings).",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 1200,
      instructions,
      input: [
        {
          role: "user",
          content:
            "Проанализируй новую сделку и верни квалификацию. Данные сделки:\n" +
            JSON.stringify(input),
        },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload.error) {
    const message =
      payload?.error?.message ||
      payload?.error_description ||
      `OpenAI API HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = extractResponseText(payload);
  if (!text) {
    throw new Error("OpenAI returned no text output");
  }

  const analysis = parseJsonText(text);

  return {
    model: payload.model || model,
    responseId: payload.id || null,
    analysis,
  };
}

async function processDeal(evt) {
  if (String(evt.event || "").toUpperCase() !== "ONCRMDEALADD") {
    return;
  }

  if (!evt.dealId) {
    console.warn("Bitrix event has no deal ID");
    return;
  }

  try {
    const deal = await fetchDeal(evt.dealId);

    console.log(
      JSON.stringify({
        source: "bitrix24",
        action: "deal-read-ok",
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

    const result = await analyzeDeal(deal);

    console.log(
      JSON.stringify({
        source: "openai",
        action: "ai-analysis-ok",
        dealId: String(deal.ID),
        model: result.model,
        responseId: result.responseId,
        analysis: result.analysis,
        analyzedAt: new Date().toISOString(),
      })
    );

    const isTestDeal = String(deal.TITLE || "").startsWith("AI WEBHOOK TEST");
    const targetField = "UF_CRM_1790850696723";
    const fieldEmpty = !String(deal[targetField] || "").trim();

    if (isTestDeal && fieldEmpty) {
      await ensureMultilineDealField(targetField);
      const text = formatManagerQuestions(result.analysis);
      await updateDealField(deal.ID, targetField, text);

      console.log(
        JSON.stringify({
          source: "bitrix24",
          action: "test-write-ok",
          dealId: String(deal.ID),
          field: targetField,
          writtenAt: new Date().toISOString(),
        })
      );
    } else {
      console.log(
        JSON.stringify({
          source: "bitrix24",
          action: "write-skipped",
          dealId: String(deal.ID),
          reason: !isTestDeal ? "not-test-deal" : "target-field-not-empty",
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "pipeline",
        action: "deal-processing-error",
        dealId: String(evt.dealId),
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
});

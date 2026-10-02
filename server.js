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

    // Log only operational metadata, not message bodies, emails, phones or webhook secrets.
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
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "bitrix24",
        action: "deal-read-error",
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

      // Respond to Bitrix immediately, then read the deal in the background.
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

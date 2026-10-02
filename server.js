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
  return path.reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), obj);
}

function parseBody(raw, contentType) {
  if ((contentType || "").includes("application/json")) {
    try {
      return { kind: "json", value: JSON.parse(raw || "{}") };
    } catch {
      return { kind: "json", value: {} };
    }
  }

  const params = new URLSearchParams(raw);
  return { kind: "form", value: params };
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return json(res, 200, {
      ok: true,
      service: "topsense-bitrix-ai",
      status: "ready",
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

      // Intentionally log only non-secret event metadata.
      console.log(JSON.stringify({
        source: "bitrix24",
        event: evt.event,
        dealId: evt.dealId,
        receivedAt: new Date().toISOString(),
      }));

      return json(res, 200, {
        ok: true,
        event: evt.event,
        dealId: evt.dealId,
      });
    });

    return;
  }

  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TOP-SENSE Bitrix receiver listening on port ${PORT}`);
});

const http = require("http");
const { timingSafeEqual } = require("crypto");
const { fork } = require("child_process");
const sales = require("./sales");

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const APP_PORT = PUBLIC_PORT + 1;

const child = fork(require.resolve("./server.js"), [], {
  env: Object.fromEntries(Object.entries({ ...process.env, PORT: String(APP_PORT) }).filter(([key]) => !key.startsWith("SALES_"))),
  stdio: "inherit",
});

sales.start().catch(error => {
  console.error(JSON.stringify({
    source: "sales-mvp",
    action: "startup-error",
    error: error instanceof Error ? error.message : String(error),
  }));
});


// Separate dashboard authentication. Refuse access if its secret is missing.
function dashboardAuthorized(req) {
  const expected = String(process.env.SALES_DASHBOARD_TOKEN || "");
  if (!expected) return false;
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "sales") return false;
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

const gateway = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/sales" || pathname.startsWith("/sales/")) {
    if (!process.env.SALES_DASHBOARD_TOKEN) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("Dashboard is not configured");
    }
    if (!dashboardAuthorized(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="TOP-SENS Sales", charset="UTF-8"', "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("Authentication required");
    }
  }

  if (req.method === "GET" && pathname === "/sales") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(sales.html());
  }

  if (req.method === "GET" && pathname === "/sales/status") {
    const body = JSON.stringify(sales.status());
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    return res.end(body);
  }

  const proxy = http.request({
    hostname: "127.0.0.1",
    port: APP_PORT,
    path: req.url,
    method: req.method,
    headers: (() => {
      const headers = { ...req.headers };
      const auth = String(headers.authorization || "");
      if (auth.startsWith("Basic ")) {
        try {
          const credentials = Buffer.from(auth.slice(6), "base64").toString("utf8");
          if (credentials.startsWith("sales:") ||
              credentials.slice(credentials.indexOf(":") + 1) === String(process.env.SALES_DASHBOARD_TOKEN || "")) {
            delete headers.authorization;
          }
        } catch {
          delete headers.authorization;
        }
      }
      return headers;
    })(),
  }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });

  proxy.on("error", error => {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "upstream unavailable" }));
    console.error(JSON.stringify({
      source: "sales-mvp",
      action: "gateway-error",
      error: error.message,
    }));
  });

  req.pipe(proxy);
});

gateway.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log("TOP-SENSE Sales gateway listening on port " + PUBLIC_PORT);
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  gateway.close();
});

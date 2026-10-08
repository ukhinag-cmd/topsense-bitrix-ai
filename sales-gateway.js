const http = require("http");
const { fork } = require("child_process");
const sales = require("./sales");

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const APP_PORT = PUBLIC_PORT + 1;

const child = fork(require.resolve("./server.js"), [], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: "inherit",
});

sales.start().catch(error => {
  console.error(JSON.stringify({
    source: "sales-mvp",
    action: "startup-error",
    error: error instanceof Error ? error.message : String(error),
  }));
});

const gateway = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";

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
    headers: req.headers,
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

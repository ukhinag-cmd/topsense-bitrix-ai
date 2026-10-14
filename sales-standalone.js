"use strict";

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const token = process.env.SALES_DASHBOARD_TOKEN || "";
const port = Number(process.env.PORT || 10000);

if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Sales staging configuration is missing or invalid");
  process.exit(1);
}

function authorized(req) {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(
    req.headers.authorization || ""
  );
  if (!match) return false;

  const credentials = Buffer.from(match[1], "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  if (separator < 0 || credentials.slice(0, separator) !== "sales") {
    return false;
  }

  const actual = Buffer.from(credentials.slice(separator + 1));
  const expected = Buffer.from(token);

  return actual.length === expected.length &&
    timingSafeEqual(actual, expected);
}

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TOP-SENS Sales Staging</title>
</head>
<body style="font-family:system-ui;margin:40px;max-width:760px">
<h1>TOP-SENS Sales Control</h1>
<h2>Тестовая панель</h2>
<p>Защищённый сервер запущен.</p>
<p>Данные Bitrix24 пока не подключены.</p>
<p>Prospect Score, Risk Score и Next Step ожидают проверки.</p>
</body>
</html>`;

http.createServer((req, res) => {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };

  if (!authorized(req)) {
    res.writeHead(401, {
      ...headers,
      "WWW-Authenticate": 'Basic realm="TOP-SENS Sales"'
    });
    return res.end("Authentication required");
  }

  if (req.method !== "GET") {
    res.writeHead(405, { ...headers, Allow: "GET" });
    return res.end();
  }

  if (req.url === "/sales") {
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/html; charset=utf-8"
    });
    return res.end(page);
  }

  if (req.url === "/sales/status") {
    res.writeHead(200, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    });
    return res.end(JSON.stringify({
      ok: true,
      mode: "staging",
      crmConnected: false,
      dataSource: "none"
    }));
  }

  res.writeHead(404, headers);
  res.end("Not found");
}).listen(port, "0.0.0.0", () => {
  console.log("TOP-SENS staging server started");
});

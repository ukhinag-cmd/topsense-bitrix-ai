'use strict';

const http = require('http');
const { fork } = require('child_process');
const {
  MAX_EVENT_BODY,
  decodeBasicCredentials,
  parseBitrixEvent,
  sanitizeProxyHeaders,
} = require('./sales-gateway-helpers');

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const APP_PORT = PUBLIC_PORT + 1;

function dashboardAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  const credentials = decodeBasicCredentials(req.headers.authorization);
  if (!credentials || credentials.username !== 'sales') return false;
  const supplied = Buffer.from(credentials.password, 'utf8');
  const actual = Buffer.from(String(expectedToken), 'utf8');
  const { timingSafeEqual } = require('crypto');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function createGateway({
  upstreamPort = APP_PORT,
  dashboardToken = String(process.env.SALES_DASHBOARD_TOKEN || ''),
  bitrixToken = String(process.env.BITRIX_OUTBOUND_TOKEN || ''),
  salesModule,
} = {}) {
  const salesApi = salesModule || require('./sales');
  return http.createServer((req, res) => {
    let requestUrl;
    try { requestUrl = new URL(req.url || '/', 'http://localhost'); }
    catch {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Invalid request URL');
    }
    const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/sales' || pathname.startsWith('/sales/')) {
      if (!dashboardToken) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Dashboard is not configured');
      }
      if (!dashboardAuthorized(req, dashboardToken)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="TOP-SENS Sales", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Authentication required');
      }
    }

    if (req.method === 'GET' && pathname === '/sales') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(salesApi.html());
    }

    if (req.method === 'GET' && pathname === '/sales/status') {
      const body = JSON.stringify(salesApi.status());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    function forward(bodyBuffer, mirroredEvent) {
      const headers = sanitizeProxyHeaders(req.headers, dashboardToken);
      if (bodyBuffer) {
        delete headers['transfer-encoding'];
        headers['content-length'] = String(bodyBuffer.length);
      }
      const proxy = http.request({
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      }, upstream => {
        upstream.on('end', () => {
          if (mirroredEvent && upstream.statusCode >= 200 && upstream.statusCode < 300) {
            Promise.resolve(salesApi.handleEvent(mirroredEvent)).catch(error => {
              console.warn(JSON.stringify({
                source: 'sales-mvp', action: 'event-mirror-failed',
                error: error instanceof Error ? error.message : String(error),
              }));
            });
          }
        });
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      });

      proxy.on('error', error => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }));
        console.error(JSON.stringify({
          source: 'sales-mvp', action: 'gateway-error', error: error.message,
        }));
      });

      if (bodyBuffer) proxy.end(bodyBuffer);
      else req.pipe(proxy);
    }

    // Buffer only Bitrix's bounded event body so it can be mirrored without
    // consuming or altering the original request sent to the existing handler.
    if (req.method === 'POST' && req.url === '/bitrix/events') {
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', chunk => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_EVENT_BODY) {
          rejected = true;
          chunks.length = 0;
          res.writeHead(413, { 'cache-control': 'no-store' });
          res.end('payload too large');
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        const body = Buffer.concat(chunks, size);
        const event = parseBitrixEvent(body, req.headers['content-type'], bitrixToken);
        forward(body, event);
      });
      return;
    }

    forward(null, null);
  });
}

function start() {
  const sales = require('./sales');
  const child = fork(require.resolve('./server.js'), [], {
    env: Object.fromEntries(Object.entries({ ...process.env, PORT: String(APP_PORT) }).filter(([key]) => !key.startsWith('SALES_'))),
    stdio: 'inherit',
  });

  sales.start().catch(error => {
    console.error(JSON.stringify({
      source: 'sales-mvp', action: 'startup-error',
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  const gateway = createGateway({ salesModule: sales });
  gateway.listen(PUBLIC_PORT, '0.0.0.0', () => {
    console.log('TOP-SENSE Sales gateway listening on port ' + PUBLIC_PORT);
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    gateway.close();
  });
  return { gateway, child };
}

if (require.main === module) start();

module.exports = Object.freeze({ createGateway, dashboardAuthorized, start });

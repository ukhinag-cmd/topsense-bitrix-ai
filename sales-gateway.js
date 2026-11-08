'use strict';

const http = require('http');
const {
  MAX_EVENT_BODY,
  decodeBasicCredentials,
  parseBitrixEvent,
  sanitizeProxyHeaders,
} = require('./sales-gateway-helpers');

const PUBLIC_PORT = Number(process.env.PORT || 10000);

const SALES_RESPONSE_SECURITY_HEADERS = Object.freeze({
  // The Sales dashboard contains private deal and manager information.
  // It is pure server-rendered HTML: no scripts, frames, or external assets
  // are needed. Allow only the existing inline stylesheet.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

function dashboardAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  // The HTTP parser retains repeated header lines in rawHeaders, but
  // req.headers.authorization normally contains only the first value.
  // Different intermediaries may choose a different duplicate. Never
  // authorize a private Dashboard using ambiguous HTTP credentials.
  if (Array.isArray(req.rawHeaders)) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] === 'string' &&
          req.rawHeaders[i].toLowerCase() === 'authorization') count += 1;
    }
    if (count !== 1) return false;
  }
  const credentials = decodeBasicCredentials(req.headers.authorization);
  if (!credentials || credentials.username !== 'sales') return false;
  const supplied = Buffer.from(credentials.password, 'utf8');
  const actual = Buffer.from(String(expectedToken), 'utf8');
  const { timingSafeEqual } = require('crypto');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function canonicalRequestPath(rawPath) {
  let decoded = String(rawPath || '/');
  for (let depth = 0; depth < 8; depth += 1) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (next === decoded) break;
    decoded = next;
    if (depth === 7) {
      try { if (decodeURIComponent(decoded) !== decoded) return null; } catch { return null; }
    }
  }
  // Encoded query/fragment delimiters make route interpretation ambiguous.
  if (decoded.includes('?') || decoded.includes('#')) return null;
  decoded = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  // URL() removes dot segments. Reject them *before* normalization: otherwise
  // /sales/../legacy or /bitrix/events/%2e%2e/legacy escapes the protected
  // namespace and gets forwarded to an explicitly configured CRM upstream.
  if (decoded.split('/').some(segment => segment === '.' || segment === '..')) return null;
  try {
    decoded = new URL('http://localhost' + (decoded.startsWith('/') ? decoded : '/' + decoded)).pathname;
  } catch { return null; }
  return decoded.replace(/\/+$/, '') || '/';
}

function isProtectedPath(pathname) {
  const withoutMatrixParams = pathname.split('/').map(segment => segment.split(';', 1)[0]).join('/');
  const lower = withoutMatrixParams.toLowerCase();
  return lower === '/sales' || lower.startsWith('/sales/') ||
    lower === '/bitrix/events' || lower.startsWith('/bitrix/events/');
}

function createGateway({
  upstreamPort = null,
  dashboardToken = String(process.env.SALES_DASHBOARD_TOKEN || ''),
  bitrixToken = String(process.env.BITRIX_OUTBOUND_TOKEN || ''),
  salesModule,
} = {}) {
  const salesApi = salesModule || require('./sales');
  return http.createServer((req, res) => {
    // Proxy-style absolute-form targets (http://host/sales) and ambiguous
    // network-path targets (//host/bitrix/events) can hide a protected route
    // from canonicalRequestPath, then be forwarded unchanged to the legacy
    // CRM upstream. Accept only ordinary, unambiguous origin-form paths.
    const requestTarget = String(req.url || '');
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Unsupported HTTP request target');
    }
    const rawPath = requestTarget.split('?', 1)[0] || '/';
    const pathname = canonicalRequestPath(rawPath);
    if (!pathname) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Invalid or ambiguous request path');
    }
    const rawPathNormalized = rawPath.replace(/\/+$/, '') || '/';
    const protectedPath = pathname.split('/').map(segment => segment.split(';', 1)[0]).join('/');
    if (isProtectedPath(pathname) &&
        (rawPathNormalized !== pathname || pathname !== protectedPath.toLowerCase())) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Non-canonical protected route');
    }

    if (pathname === '/sales' || pathname.startsWith('/sales/')) {
      // Apply privacy headers to authenticated AND rejected Sales responses.
      // In particular, a saved Basic credential must not make the Dashboard
      // embeddable in a third-party frame.
      for (const [name, value] of Object.entries(SALES_RESPONSE_SECURITY_HEADERS)) {
        res.setHeader(name, value);
      }
      if (!dashboardToken) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Dashboard is not configured');
      }
      if (!dashboardAuthorized(req, dashboardToken)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="TOP-SENS Sales", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Authentication required');
      }
    }

    // Never proxy writes or unknown methods under the read-only dashboard.
    if ((pathname === '/sales' || pathname.startsWith('/sales/')) && req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
      return res.end('Method not allowed');
    }

    if (req.method === 'GET' && pathname === '/sales') {
      // Rendering derives from CRM/Sheet snapshots. A malformed row or an
      // accessor error must not escape the HTTP callback (crashing Node and
      // potentially logging a secret-bearing exception). Compute the body
      // before sending 200 and return only a generic read-only error.
      let page;
      try {
        page = salesApi.html();
        if (typeof page !== 'string') throw new Error('Invalid Sales HTML');
      } catch {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Sales Dashboard unavailable');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    }

    if (req.method === 'GET' && pathname === '/sales/status') {
      let body;
      let length;
      try {
        body = JSON.stringify(salesApi.status());
        if (typeof body !== 'string') throw new Error('Invalid Sales status');
        length = Buffer.byteLength(body);
      } catch {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Sales Dashboard unavailable');
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': length,
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    // Only /sales and /sales/status are implemented. An authenticated GET
    // to any other Sales path must never fall through to a legacy upstream:
    // older routes may expose private CRM data or cause unintended effects.
    if (pathname === '/sales' || pathname.startsWith('/sales/')) {
      res.writeHead(404, { 'cache-control': 'no-store' });
      return res.end('Unknown read-only Sales route');
    }

    function forward(bodyBuffer) {
      // The Sales process is isolated by default: no legacy server is started.
      // Only tests or an explicitly constructed gateway may provide upstreamPort.
      if (!upstreamPort) {
        res.writeHead(404, { 'cache-control': 'no-store' });
        return res.end('Route unavailable in read-only Sales gateway');
      }
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
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      });

      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }));
        console.error(JSON.stringify({
          source: 'sales-mvp', action: 'gateway-error', error: 'Legacy upstream request failed',
        }));
      });

      if (bodyBuffer) proxy.end(bodyBuffer);
      else req.pipe(proxy);
    }

    // The Bitrix webhook has one permitted method: authenticated POST.
    // Even an explicitly configured legacy upstream must never receive
    // GET/PUT/PATCH/DELETE/OPTIONS on this CRM event route. The legacy
    // handler may perform writes; proxying unexpected methods is unsafe.
    if (pathname === '/bitrix/events' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      return res.end('Method not allowed');
    }

    // Never let the existing handler accept events when its shared token is
    // absent; server.js intentionally preserves its legacy optional-token mode.
    if (req.method === 'POST' && pathname === '/bitrix/events' && req.url !== '/bitrix/events') {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Non-canonical Bitrix event route');
    }
    if (req.method === 'POST' && pathname === '/bitrix/events') {
      if (!bitrixToken) {
        req.resume();
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Bitrix event validation is not configured');
      }
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
        if (!event) {
          res.writeHead(401, { 'cache-control': 'no-store' });
          return res.end('Invalid or unsupported Bitrix event');
        }

        // Log only validated event identity, never the raw body or application
        // token. An HTTP 200 is a receipt, not proof that read-only CRM
        // processing completed; Render logs must distinguish both outcomes.
        const audit = {
          source: 'sales-mvp', event: event.event,
          dealId: event.dealId, activityId: event.activityId,
        };
        console.log(JSON.stringify({ ...audit, action: 'webhook-accepted' }));

        // Acknowledged authenticated events are processed by the read-only
        // Sales module only. NEVER pass events to the legacy server.js, whose
        // activity/deal handlers may create or modify Bitrix CRM records.
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, event: event.event, dealId: event.dealId, activityId: event.activityId }));
        // The real Sales handler normally absorbs CRM read errors to protect
        // direct callers. In the gateway request path, propagate them so an
        // unsuccessful read cannot be mistaken for a benign activity without
        // a deal owner in the receipt audit.
        Promise.resolve().then(() => salesApi.handleEvent(event, { propagateError: true })).then(result => {
          console.log(JSON.stringify({
            ...audit, action: result ? 'webhook-processed' : 'webhook-no-deal-snapshot',
          }));
        }).catch(() => {
          // Exceptions from REST clients and intermediaries may embed the
          // credential-bearing Bitrix webhook URL in their message. Keep the
          // failure signal but never put raw exception text in Render logs.
          console.warn(JSON.stringify({
            ...audit, action: 'event-processing-failed',
            error: 'Read-only CRM processing failed',
          }));
        });
      });
      return;
    }

    // Treat the whole Bitrix event namespace as read-only and isolated.
    // Unknown child routes must not fall through to a legacy CRM handler,
    // which might interpret them as mutating webhook or admin actions.
    if (pathname.startsWith('/bitrix/events/')) {
      req.resume();
      res.writeHead(404, { 'cache-control': 'no-store' });
      return res.end('Unknown Bitrix event route');
    }

    forward(null);
  });
}

function start() {
  const sales = require('./sales');
  sales.start().catch(() => {
    console.error(JSON.stringify({
      source: 'sales-mvp', action: 'startup-error',
      error: 'Sales startup failed',
    }));
  });

  const gateway = createGateway({ salesModule: sales });
  gateway.listen(PUBLIC_PORT, '0.0.0.0', () => {
    console.log('TOP-SENSE Sales gateway listening on port ' + PUBLIC_PORT);
  });

  process.on('SIGTERM', () => gateway.close());
  return { gateway, child: null };
}

if (require.main === module) start();

module.exports = Object.freeze({ createGateway, dashboardAuthorized, start });

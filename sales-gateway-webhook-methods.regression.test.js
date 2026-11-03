'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

// An explicitly configured legacy upstream must never receive an unexpected
// request method on the webhook endpoint. Only the authenticated, canonical
// POST is handled by the local read-only Sales module.
test('Bitrix webhook endpoint rejects all non-POST methods without proxying to legacy CRM', async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ method: req.method, path: req.url });
    res.writeHead(200);
    res.end('legacy upstream received request');
  });
  const listen = server => new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
  const close = server => new Promise(resolve => server.close(resolve));
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    upstreamPort,
    dashboardToken: 'test-only-dashboard-token',
    bitrixToken: 'test-only-bitrix-token',
    salesModule: {
      html: () => '<p>test</p>',
      status: () => ({ ok: true }),
      handleEvent: async () => null,
    },
  });
  const port = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  const request = (method, path) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow }));
    });
    req.on('error', reject);
    req.end();
  });

  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(method, '/bitrix/events');
    assert.equal(response.status, 405, method + ' must be rejected');
    assert.equal(response.allow, 'POST', method + ' must advertise only POST');
  }
  assert.deepEqual(forwarded, [], 'no unsupported webhook method may reach legacy upstream');
});

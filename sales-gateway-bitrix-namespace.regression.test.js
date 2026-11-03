'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const listen = server => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
);
const close = server => new Promise(resolve => server.close(resolve));

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Bitrix event namespace never falls through to a mutating legacy upstream', async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ method: req.method, path: req.url });
    res.writeHead(207);
    res.end('legacy');
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    upstreamPort,
    dashboardToken: 'test-only-dashboard-token',
    bitrixToken: 'test-only-webhook-token',
    salesModule: {
      html: () => '<p>mock</p>',
      status: () => ({ ok: true }),
      handleEvent: async () => null,
    },
  });
  const port = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  // An unknown child route must never reach an older Bitrix handler.
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const response = await request(port, method, '/bitrix/events/legacy');
    assert.equal(response.status, 404, method + ' under webhook namespace');
  }
  // Encoded and case-variant spellings must not evade protected route checks.
  for (const path of ['/bitrix/events%2Flegacy', '/BITRIX/EVENTS/legacy',
    '/bitrix/events//legacy', '/bitrix/events;param/legacy']) {
    const response = await request(port, 'POST', path);
    assert.equal(response.status, 400, path + ' is non-canonical');
  }
  assert.deepEqual(forwarded, [], 'no protected route may reach the legacy server');

  // Preserve the explicitly configured upstream's unrelated routes.
  assert.equal((await request(port, 'GET', '/legacy-health')).status, 207);
  assert.deepEqual(forwarded, [{ method: 'GET', path: '/legacy-health' }]);
});

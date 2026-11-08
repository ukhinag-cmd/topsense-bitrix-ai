'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const bitrixToken = 'test-only-content-type-token';
const payload = JSON.stringify({
  event: 'ONCRMDEALUPDATE',
  data: { FIELDS: { ID: '941002' } },
  auth: { application_token: bitrixToken },
});

function send(port, contentTypes) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/bitrix/events',
      // Node sends each array item as an independent raw HTTP header line.
      headers: { 'content-type': contentTypes },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('authenticated Bitrix webhook rejects ambiguous duplicate Content-Type lines', async t => {
  let processed = 0;
  const gateway = createGateway({
    bitrixToken,
    dashboardToken: 'test-only-dashboard-token',
    salesModule: {
      html: () => '<p>read-only</p>',
      status: () => ({ ok: true }),
      handleEvent: async () => { processed += 1; return { dealId: '941002' }; },
    },
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const port = gateway.address().port;

  assert.equal(await send(port, 'application/json'), 200,
    'single declared JSON type remains supported');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processed, 1, 'mock read-only processing completes');

  for (const types of [
    ['application/json', 'application/x-www-form-urlencoded'],
    ['application/x-www-form-urlencoded', 'application/json'],
    ['application/json', 'application/json'],
  ]) {
    assert.equal(await send(port, types), 400,
      'ambiguous HTTP media type must be rejected before parsing or processing');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processed, 1, 'ambiguous webhook must never reach the Sales handler');
});

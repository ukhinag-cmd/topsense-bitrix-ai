'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const token = 'test-only-webhook-token';

function send(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/bitrix/events',
      headers: { 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('read-only gateway logs authenticated Bitrix receipts and processing outcome without secrets', async t => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  t.after(() => { console.log = originalLog; });

  let processedResolve;
  const processed = new Promise(resolve => { processedResolve = resolve; });
  const gateway = createGateway({
    bitrixToken: token,
    dashboardToken: 'test-dashboard-token',
    salesModule: {
      html: () => '<h1>mock</h1>',
      status: () => ({ ok: true }),
      handleEvent: async event => {
        processedResolve();
        return { dealId: event.dealId };
      },
    },
  });
  const port = await new Promise(resolve =>
    gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port))
  );
  t.after(() => new Promise(resolve => gateway.close(resolve)));

  const accepted = await send(port, {
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: '887451' } },
    auth: { application_token: token },
  });
  assert.equal(accepted.status, 200);
  await processed;
  await new Promise(resolve => setImmediate(resolve));
  const entries = logs.flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  assert.ok(entries.some(e => e.source === 'sales-mvp' &&
    e.action === 'webhook-accepted' && e.event === 'ONCRMDEALUPDATE' &&
    e.dealId === '887451'), 'accepted event must be traceable in Render application logs');
  assert.ok(entries.some(e => e.source === 'sales-mvp' &&
    e.action === 'webhook-processed' && e.dealId === '887451'),
    'successful read-only processing must be distinguished from HTTP acceptance');
  assert.equal(logs.join('\n').includes(token), false, 'never log the Bitrix application token');

  const beforeRejected = logs.length;
  const rejected = await send(port, {
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: '887451' } },
    auth: { application_token: 'incorrect-token' },
  });
  assert.equal(rejected.status, 401);
  assert.equal(logs.length, beforeRejected,
    'unauthenticated events must not create trusted receipt or processing logs');
});

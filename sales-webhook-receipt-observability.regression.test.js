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


test('failed Bitrix read is not mislabeled as a harmless no-deal webhook', async t => {
  // No real CRM request is made: all reads fail inside this local stub.
  const originalUrl = process.env.BITRIX_WEBHOOK_BASE;
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const events = [];
  process.env.BITRIX_WEBHOOK_BASE = 'https://example.bitrix24.ru/rest/12345/test-only/';
  global.fetch = async () => { throw new Error('mock CRM read unavailable'); };
  const capture = (...args) => {
    for (const arg of args) {
      try {
        const event = JSON.parse(String(arg));
        if (event.source === 'sales-mvp') events.push(event);
      } catch {}
    }
  };
  console.log = capture;
  console.warn = capture;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.BITRIX_WEBHOOK_BASE;
    else process.env.BITRIX_WEBHOOK_BASE = originalUrl;
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  });

  const sales = require('./sales');
  const gateway = createGateway({
    bitrixToken: token,
    dashboardToken: 'test-dashboard-token',
    salesModule: sales,
  });
  const port = await new Promise(resolve =>
    gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port))
  );
  t.after(() => new Promise(resolve => gateway.close(resolve)));

  const received = await send(port, {
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: '887452' } },
    auth: { application_token: token },
  });
  assert.equal(received.status, 200, 'HTTP receipt is independent of asynchronous CRM read');
  for (let attempt = 0; attempt < 100 &&
      !events.some(event => event.action === 'event-processing-failed'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Flush the gateway's promise continuation after the sales handler exits.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.action === 'webhook-accepted'));
  assert.ok(events.some(event => event.action === 'event-processing-failed'));
  assert.equal(events.some(event => event.action === 'webhook-processed'), false);
  assert.equal(events.some(event => event.action === 'webhook-no-deal-snapshot'), false,
    'a failed CRM read must not be reported as a successful no-deal event');
  assert.equal(sales.status().lastError?.source, 'sales-event');
});

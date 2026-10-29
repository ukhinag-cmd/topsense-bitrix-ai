'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales history retries HTTP 200 store responses without an explicit acknowledgement', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  const storeUrl = 'https://private-store.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-only-secret';

  const scheduledFlushes = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      scheduledFlushes.push(() => fn(...args));
      return { unref() {} };
    }
    return originalSetTimeout(fn, ms, ...args);
  };

  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const id = '9900871';
  const deal = {
    ID: id,
    TITLE: 'Persistence acknowledgement regression',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '200000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
    DATE_MODIFY: new Date().toISOString(),
    LAST_ACTIVITY_TIME: new Date().toISOString(),
    ACTIVITY_TIME: new Date(Date.now() + 3600000).toISOString(),
  };
  const responses = [
    '<html>intermediary returned an HTML page</html>',
    '{"rows":[]}',
    '{"ok":true}',
  ];
  const writes = [];

  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (url === storeUrl) {
      const request = JSON.parse(options.body);
      assert.equal(request.action, 'upsert');
      writes.push(request.rows);
      assert.ok(writes.length <= responses.length, 'unexpected additional persistence request');
      return {
        ok: true,
        status: 200,
        text: async () => responses[writes.length - 1],
      };
    }
    throw new Error('Unexpected mocked request: ' + url);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(scheduledFlushes.length, 1);

  const settle = () => new Promise(resolve => originalSetTimeout(resolve, 0));

  scheduledFlushes[0]();
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(sales.status().lastError?.source, 'sales-store',
    'HTML returned with HTTP 200 must not be treated as a persisted history write');
  assert.equal(scheduledFlushes.length, 2, 'failed history write must remain dirty');

  scheduledFlushes[1]();
  await settle();
  assert.equal(writes.length, 2);
  assert.equal(scheduledFlushes.length, 3,
    'JSON without ok:true must not be mistaken for an acknowledged write');

  scheduledFlushes[2]();
  await settle();
  assert.equal(writes.length, 3);
  assert.equal(scheduledFlushes.length, 3, 'successful acknowledgement should clear the dirty history');
  assert.equal(writes[0][0].key, 'sales:deal:' + id);
  assert.deepEqual(writes[1], writes[0]);
  assert.deepEqual(writes[2], writes[0],
    'retries must preserve the original deal score and its history');
  assert.equal(writes[2][0].payload.scoreHistory.length, 1);
});

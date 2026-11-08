'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// A proxy/Sheet store can return conflicting JSON duplicate properties.
// JSON.parse keeps the last one, so an `ok:false` followed by `ok:true`
// must never acknowledge persistence or clear unsaved Sales score history.
test('Sales store preserves dirty history until a structurally unambiguous JSON acknowledgement', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  const storeUrl = 'https://store-duplicate-keys.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix-duplicate-keys.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'mock-only-store-secret';

  const scheduled = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      scheduled.push(() => fn(...args));
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

  const id = '9900872';
  const modified = new Date().toISOString();
  const deal = {
    ID: id, TITLE: 'Store duplicate key regression',
    STAGE_ID: 'C1:NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '200000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
    DATE_MODIFY: modified, LAST_ACTIVITY_TIME: modified,
    ACTIVITY_TIME: new Date(Date.now() + 3600000).toISOString(),
  };
  const responses = [
    '{"ok":false,"ok":true}',
    '{"\\u006fk":false,"ok":true}',
    '{"ok":true}',
  ];
  const writes = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.deal.get.json'))
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    if (url === storeUrl) {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'upsert');
      writes.push(body.rows);
      assert.ok(writes.length <= responses.length, 'unexpected persistence request');
      return { ok: true, status: 200, text: async () => responses[writes.length - 1] };
    }
    throw new Error('Unexpected mock-only URL: ' + url);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(scheduled.length, 1);
  const settle = () => new Promise(resolve => originalSetTimeout(resolve, 0));

  scheduled[0]();
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(sales.status().lastError?.source, 'sales-store',
    'conflicting JSON ok values must not be treated as persistence acknowledgement');
  assert.equal(scheduled.length, 2, 'store write must remain dirty after conflicting keys');

  scheduled[1]();
  await settle();
  assert.equal(writes.length, 2);
  assert.equal(scheduled.length, 3,
    'Unicode-escaped duplicate JSON property must also retain the dirty history');

  scheduled[2]();
  await settle();
  assert.equal(writes.length, 3);
  assert.equal(scheduled.length, 3, 'unambiguous ok:true must clear pending changes');
  assert.equal(sales.status().lastError?.source === 'sales-store', false);
  assert.deepEqual(writes[1], writes[0]);
  assert.deepEqual(writes[2], writes[0]);
  assert.equal(writes[2][0].payload.scoreHistory.length, 1);
});

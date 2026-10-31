'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales sync uses a unique ID tie-breaker for equal DATE_MODIFY values across pages', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let runSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      runSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  // Bitrix timestamps can be identical for many rapidly updated deals.
  // DATE_MODIFY alone does not define a stable order at offset boundaries.
  const sharedModifiedAt = new Date(now - 60000).toISOString();
  const deal = id => ({
    ID: String(id), TITLE: 'Tie-boundary ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '100000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: sharedModifiedAt,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  });
  const first = Array.from({ length: 50 }, (_, i) => deal(9990050 - i));
  const last = deal(9990000);
  const cursors = [];
  const orders = [];
  global.fetch = async (input, options = {}) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (!pathname.endsWith('/crm.deal.list.json')) {
      throw new Error('Unexpected mocked CRM call: ' + pathname);
    }
    const params = JSON.parse(options.body);
    cursors.push(params.start);
    orders.push(params.order);
    assert.equal(params.order.DATE_MODIFY, 'DESC');
    // Simulate the possible offset overlap from an undefined order among
    // equal timestamps. Explicit secondary ID ordering makes it stable.
    const stableOrder = params.order.ID === 'DESC';
    const payload = params.start === 0
      ? { result: first, next: 50, total: 51 }
      : { result: [stableOrder ? last : first[49]], total: 51 };
    return { ok: true, status: 200, json: async () => payload };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runSync, 'function');
  await runSync();

  const dashboard = sales.status();
  assert.deepEqual(cursors, [0, 50], 'the scan must visit both pages');
  assert.ok(orders.every(order => order.ID === 'DESC'),
    'each Bitrix page needs a unique ID tie-breaker in addition to DATE_MODIFY');
  assert.ok(dashboard.lastSyncAt, 'a stable two-page scan completes');
  assert.equal(dashboard.lastError, null);
  assert.equal(dashboard.counts.tracked, 51,
    'all deals tied on DATE_MODIFY must be present exactly once');
});

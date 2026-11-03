'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Offline-only: a full 50-record Bitrix page is not proof that the scan is
// complete when both pagination markers disappear from the response.
test('full page without next or total probes the next offset before declaring sync complete', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const env = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let runSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      runSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const deal = id => ({
    ID: String(id), TITLE: 'Unmarked page ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '100000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
  });
  const page = Array.from({ length: 50 }, (_, i) => deal(9971001 + i));
  const extra = deal(9971051);
  const starts = [];
  let mode = 'extra';
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: 'P' }],
      }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      const start = JSON.parse(options.body).start;
      starts.push(start);
      // Both `next` and `total` are deliberately absent.
      return { ok: true, status: 200, json: async () => ({
        result: start === 0 ? page : start === 50 && mode === 'extra' ? [extra] : [],
      }) };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runSync, 'function');
  await runSync();
  assert.deepEqual(starts, [0, 50],
    'a missing cursor on a full page must not hide the 51st deal');
  const first = sales.status();
  assert.equal(first.lastError, null);
  assert.equal(first.syncPartial, false);
  assert.ok(first.lastSyncAt);
  assert.equal(first.counts.tracked, 51, 'all 51 records must be visible');

  // Exactly 50 records is also legitimate: a zero-length look-ahead page
  // proves the end of a marker-less scan without a false sync error.
  mode = 'empty';
  starts.length = 0;
  await runSync();
  assert.deepEqual(starts, [0, 50]);
  assert.equal(sales.status().lastError, null);
});

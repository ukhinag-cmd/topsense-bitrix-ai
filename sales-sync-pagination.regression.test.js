'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('bounded Bitrix sync resumes later pages without claiming partial data is complete', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let sync = null;
  const cursors = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      sync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) return { unref() {} };
    return originalSetInterval(fn, ms, ...args);
  };
  global.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      const cursor = JSON.parse(options.body).start;
      cursors.push(cursor);
      // Bitrix next advances over actual records, never an empty page.
      // Populate each bounded page with distinct deals so resume testing
      // does not rely on an impossible page/cursor combination.
      const page = Array.from({ length: 50 }, (_, i) => ({
        ID: String(9940000 + cursor + i),
        TITLE: 'Deal from page ' + cursor + ' row ' + i,
        STAGE_ID: 'NEW',
        STAGE_SEMANTIC_ID: 'P',
        OPPORTUNITY: '0',
        CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
        DATE_MODIFY: new Date(Date.now() - 60000).toISOString(),
      }));
      const result = cursor < 200 ? { result: page, next: cursor + 50 } : { result: [] };
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof sync, 'function');

  await sync();
  const partial = sales.status();
  assert.deepEqual(cursors, [0, 50, 100, 150]);
  assert.equal(partial.lastSyncAt, null, 'page cap must not certify a completed sync');
  assert.equal(partial.syncPartial, true);
  assert.match(sales.html(), /Частичная синхронизация/);
  assert.doesNotMatch(sales.html(), /Синхронизация актуальна/);

  await sync();
  const complete = sales.status();
  assert.deepEqual(cursors, [0, 50, 100, 150, 200], 'next cycle must resume from stored cursor');
  assert.equal(complete.syncPartial, false);
  assert.ok(complete.lastSyncAt, 'only an exhausted cursor marks sync complete');
  assert.match(sales.html(), /Синхронизация актуальна/);
});

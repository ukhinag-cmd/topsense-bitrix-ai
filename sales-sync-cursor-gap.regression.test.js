'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a skipped Bitrix pagination cursor cannot certify an incomplete Sales scan', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
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

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync;
  let mode = 'skip';
  const cursors = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      const cursor = JSON.parse(options.body).start;
      cursors.push(cursor);
      // A real Bitrix next: 50 follows a full 50-record page; an empty
      // page with next would itself be malformed and is tested separately.
      const page = Array.from({ length: 50 }, (_, i) => ({
        ID: String(9930000 + i),
        TITLE: 'CRM pagination fixture ' + i,
        STAGE_ID: 'NEW',
        STAGE_SEMANTIC_ID: 'P',
        OPPORTUNITY: '0',
        CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
        DATE_MODIFY: new Date(Date.now() - 60000).toISOString(),
      }));
      const result = cursor === 0
        ? { result: mode === 'skip' ? [] : page, next: mode === 'skip' ? 5000 : 50 }
        : { result: [] };
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  await scheduledSync();
  const unsafe = sales.status();
  assert.equal(unsafe.lastSyncAt, null,
    'an impossible cursor jump must not mark skipped CRM records as synced');
  assert.equal(unsafe.lastError?.source, 'sales-sync');
  assert.deepEqual(cursors, [0],
    'stop before requesting a page after an impossible cursor jump');

  mode = 'normal';
  cursors.length = 0;
  await scheduledSync();
  const recovered = sales.status();
  assert.deepEqual(cursors, [0, 50], 'ordinary 50-row Bitrix cursor is supported');
  assert.equal(recovered.syncPartial, false);
  assert.ok(recovered.lastSyncAt, 'a complete valid scan should recover');
  assert.equal(recovered.lastError, null);
});

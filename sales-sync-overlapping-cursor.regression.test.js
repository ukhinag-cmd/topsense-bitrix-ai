'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('an overlapping Bitrix next cursor cannot certify incomplete Sales sync', async t => {
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

  let scheduledSync;
  let mode = 'overlap';
  const cursors = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
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
  const record = n => ({
    ID: String(9950000 + n), TITLE: 'Page record ' + n,
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
  });
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      const start = JSON.parse(options.body).start;
      cursors.push(start);
      const result = start === 0
        ? { result: Array.from({ length: 50 }, (_, i) => record(i + 1)), next: mode === 'overlap' ? 1 : 50 }
        : { result: [] };
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  await scheduledSync();
  const invalid = sales.status();
  assert.deepEqual(cursors, [0], 'reject an overlapping cursor before any second page is read');
  assert.equal(invalid.lastSyncAt, null, 'a contradictory cursor cannot mark sync complete');
  assert.equal(invalid.lastError?.source, 'sales-sync');
  assert.equal(invalid.counts.tracked, 0, 'invalid page must not enter Dashboard');

  mode = 'normal';
  cursors.length = 0;
  await scheduledSync();
  const recovered = sales.status();
  assert.deepEqual(cursors, [0, 50], 'normal next cursor is supported');
  assert.equal(recovered.counts.tracked, 50);
  assert.ok(recovered.lastSyncAt, 'valid pagination recovers Sales sync');
  assert.equal(recovered.lastError, null);
});

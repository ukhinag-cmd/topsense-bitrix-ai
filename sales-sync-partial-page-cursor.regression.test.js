'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a short Bitrix page with a jumping next cursor cannot certify a complete Sales scan', async t => {
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
  let mode = 'partial';
  const starts = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    if (ms === 1400) return originalSetTimeout(fn, 0, ...args);
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  const now = Date.now();
  const record = number => ({
    ID: String(9920000 + number),
    TITLE: 'Tracked deal ' + number,
    ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '0',
    CURRENCY_ID: 'RUB',
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
      starts.push(start);
      const result = start !== 0 ? { result: [] } :
        mode === 'partial' ? { result: [record(1)], next: 50 } :
        { result: Array.from({ length: 50 }, (_, i) => record(i + 1)), next: 50 };
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  await scheduledSync();
  const invalid = sales.status();
  assert.deepEqual(starts, [0],
    'a cursor advancing beyond one returned record would skip unseen deals');
  assert.equal(invalid.lastSyncAt, null,
    'a short page must not be reported as a complete sync');
  assert.equal(invalid.lastError?.source, 'sales-sync');

  mode = 'complete';
  starts.length = 0;
  await scheduledSync();
  const recovered = sales.status();
  assert.deepEqual(starts, [0, 50]);
  assert.equal(recovered.syncPartial, false);
  assert.equal(recovered.counts.tracked, 50);
  assert.ok(recovered.lastSyncAt, 'a complete 50-record page can finish');
  assert.equal(recovered.lastError, null);
});

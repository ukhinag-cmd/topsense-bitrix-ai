'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a duplicate Bitrix deal across bounded sync pages cannot certify a complete scan', async t => {
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

  let runInitialScan;
  let runPeriodicScan;
  let cleanScan = false;
  const cursors = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      runInitialScan = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) {
      runPeriodicScan = () => fn(...args);
      return { unref() {} };
    }
    return originalInterval(fn, ms, ...args);
  };

  const now = Date.now();
  const version = new Date(now - 120000).toISOString();
  const newerVersion = new Date(now - 60000).toISOString();
  const deal = (id, title, dateModify = version) => ({
    ID: String(id), TITLE: title, ASSIGNED_BY_ID: '',
    STAGE_ID: 'C1:WORK', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 7 * 86400000).toISOString(),
    DATE_MODIFY: dateModify,
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    NEXT_ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  });

  global.fetch = async (input, options = {}) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (!pathname.endsWith('/crm.deal.list.json')) {
      throw new Error('Unexpected Bitrix call: ' + pathname);
    }
    const cursor = JSON.parse(options.body).start;
    cursors.push(cursor);
    if (cleanScan) {
      return {
        ok: true, status: 200,
        json: async () => ({ result: [deal(9900005, 'Recovery record')] }),
      };
    }
    if (cursor < 4) {
      return {
        ok: true, status: 200,
        json: async () => ({
          result: [deal(9900001 + cursor, 'Original ' + cursor)],
          next: cursor + 1,
        }),
      };
    }
    // Simulate an unstable offset scan: a previously processed deal
    // reappears on a later page with a conflicting newer CRM version.
    return {
      ok: true, status: 200,
      json: async () => ({
        result: [deal(9900001, 'Conflicting duplicate', newerVersion)],
      }),
    };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runInitialScan, 'function');
  assert.equal(typeof runPeriodicScan, 'function');

  await runInitialScan();
  assert.deepEqual(cursors, [0, 1, 2, 3]);
  const partial = sales.status();
  assert.equal(partial.syncPartial, true);
  assert.equal(partial.lastSyncAt, null);
  assert.equal(partial.counts.tracked, 4);

  await runPeriodicScan();
  const rejected = sales.status();
  assert.deepEqual(cursors, [0, 1, 2, 3, 4]);
  assert.equal(rejected.lastSyncAt, null,
    'cross-page duplicates must not certify a complete scan');
  assert.equal(rejected.lastError?.source, 'sales-sync');
  assert.match(rejected.lastError?.message || '', /duplicate/i);
  assert.equal(rejected.prospects.find(row => row.dealId === '9900001')?.title,
    'Original 0', 'a duplicate must not replace a trusted snapshot');

  cleanScan = true;
  await runPeriodicScan();
  assert.equal(cursors.at(-1), 0, 'recovery must restart at the first page');
  const recovered = sales.status();
  assert.ok(recovered.lastSyncAt, 'a complete clean scan recovers sync health');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.syncPartial, false);
});

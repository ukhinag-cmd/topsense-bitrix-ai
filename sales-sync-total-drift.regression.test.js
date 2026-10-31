'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a changing or missing Bitrix page total cannot certify a truncated multi-page Sales sync', async t => {
  const previousFetch = global.fetch;
  const previousTimeout = global.setTimeout;
  const previousInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = previousFetch;
    global.setTimeout = previousTimeout;
    global.setInterval = previousInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
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
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return previousTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : previousInterval(fn, ms, ...args);

  const now = Date.now();
  const deal = id => ({
    ID: String(id), TITLE: 'Read-only page total fixture ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '100000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  });
  const firstPage = Array.from({ length: 50 }, (_, i) => deal(9943500 + i));
  const lastPage = [deal(9943550), deal(9943551)];
  const starts = [];
  let mode = 'drift';

  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (!pathname.endsWith('/crm.deal.list.json')) {
      throw new Error('Unexpected mocked REST call: ' + pathname);
    }
    const start = JSON.parse(options.body).start;
    starts.push(start);
    const payload = start === 0
      ? { result: firstPage, next: 50, total: 52 }
      : mode === 'stable'
        ? { result: lastPage, total: 52 }
        : mode === 'drift'
          // A deal disappeared in an earlier offset page: the new total 51
          // matches 50+1 and passes each page's independent consistency check.
          ? { result: lastPage.slice(0, 1), total: 51 }
          // Even if an intermediary drops total from the last page, the
          // first page's verified total must remain a scan-wide invariant.
          : { result: lastPage.slice(0, 1) };
    return { ok: true, status: 200, json: async () => payload };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runSync, 'function');

  await runSync();
  let dashboard = sales.status();
  assert.equal(dashboard.lastSyncAt, null,
    'a changed total must never certify a truncated scan');
  assert.equal(dashboard.lastError?.source, 'sales-sync');
  assert.equal(dashboard.counts.tracked, 50,
    'reject the inconsistent page before applying any of its records');

  mode = 'missing-total';
  await runSync();
  dashboard = sales.status();
  assert.equal(dashboard.lastSyncAt, null,
    'a missing total cannot silently override an earlier known total');
  assert.equal(dashboard.lastError?.source, 'sales-sync');
  assert.equal(dashboard.counts.tracked, 50);

  mode = 'stable';
  await runSync();
  dashboard = sales.status();
  assert.deepEqual(starts, [0, 50, 0, 50, 0, 50],
    'recovery after a changing list must restart at the first page');
  assert.ok(dashboard.lastSyncAt, 'a consistent full scan recovers health');
  assert.equal(dashboard.lastError, null);
  assert.equal(dashboard.syncPartial, false);
  assert.equal(dashboard.counts.tracked, 52);
});

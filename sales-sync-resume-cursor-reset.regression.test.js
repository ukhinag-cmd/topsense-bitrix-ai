'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a failed resumed Bitrix page discards its stale cursor before the next sync', async t => {
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

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync;
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
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const deal = id => ({
    ID: String(9988000 + id), TITLE: 'Safe sync fixture ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
  });
  const cursors = [];
  let mode = 'partial';
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (!path.endsWith('/crm.deal.list.json')) {
      throw new Error('Unexpected mocked Bitrix request: ' + path);
    }
    const start = JSON.parse(options.body).start;
    cursors.push(start);
    let payload;
    if (mode === 'partial') {
      assert.ok(start < 200, 'first scan is intentionally bounded to four pages');
      payload = {
        result: Array.from({ length: 50 }, (_, index) => deal(start + index)),
        next: start + 50,
      };
    } else if (mode === 'invalid') {
      assert.equal(start, 200, 'resume at the saved page cursor');
      // An invalid non-advancing cursor means this paginated view is no
      // longer trustworthy; it cannot be resumed safely on another tick.
      payload = { result: [deal(200)], next: 200 };
    } else {
      // The CRM list has changed since the interrupted scan. A fresh scan
      // must begin at zero rather than completing the old offset 200.
      payload = start === 0 ? { result: [deal(900)] } : { result: [] };
    }
    return { ok: true, status: 200, json: async () => payload };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  await scheduledSync();
  let state = sales.status();
  assert.equal(state.syncPartial, true);
  assert.equal(state.counts.tracked, 200);
  assert.equal(state.lastSyncAt, null);

  mode = 'invalid';
  await scheduledSync();
  state = sales.status();
  assert.equal(state.lastError?.source, 'sales-sync');
  assert.equal(state.lastSyncAt, null);
  assert.equal(state.counts.tracked, 200, 'invalid page must not apply changes');
  assert.equal(state.syncPartial, false, 'a failed resume invalidates the saved offset');

  mode = 'recovered';
  await scheduledSync();
  state = sales.status();
  assert.deepEqual(cursors, [0, 50, 100, 150, 200, 0],
    'recovery must recheck the list from page zero');
  assert.equal(state.lastError, null);
  assert.ok(state.lastSyncAt);
  assert.equal(state.syncPartial, false);
  assert.ok(state.prospects.some(row => row.dealId === String(9988900)) ||
    state.counts.tracked === 201,
    'freshly fetched records must reach the Dashboard');
});

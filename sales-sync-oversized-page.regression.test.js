'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('read-only deal sync rejects an oversized Bitrix list page before applying snapshots', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
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
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const created = new Date(now - 86400000).toISOString();
  const modified = new Date(now - 60000).toISOString();
  const deal = id => ({
    ID: String(id), TITLE: 'Pagination contract ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
    DATE_CREATE: created, DATE_MODIFY: modified,
  });
  const oversized = Array.from({length: 51}, (_, index) => deal(9981000 + index));
  let response = { result: oversized, total: 51 };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({result: []}) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => response };
    }
    throw new Error('Unexpected mock call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');
  await scheduledSync();
  const rejected = sales.status();
  assert.equal(rejected.lastSyncAt, null,
    'a 51-row page violates the 50-record Bitrix list contract');
  assert.equal(rejected.lastError?.source, 'sales-sync');
  assert.equal(rejected.counts.tracked, 0,
    'reject before mutating any trusted deal snapshot');

  response = { result: [deal(9981000)], total: 1 };
  await scheduledSync();
  const recovered = sales.status();
  assert.equal(recovered.lastError, null);
  assert.ok(recovered.lastSyncAt, 'valid bounded pagination restores sync health');
  assert.equal(recovered.counts.tracked, 1);
});

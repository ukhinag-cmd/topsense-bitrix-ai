'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a Bitrix total larger than the final page cannot certify an incomplete Sales sync', async t => {
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

  let runSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      runSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const deal = {
    ID: '9988941', TITLE: 'Pagination total gap', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '',
    OPPORTUNITY: '100000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let listReads = 0;
  global.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: 'P' }],
      }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      listReads += 1;
      return { ok: true, status: 200, json: async () =>
        // First response silently omits next while claiming another match.
        listReads === 1 ? { result: [deal], total: 2 } :
          { result: [deal], total: 1 } };
    }
    throw new Error('Unexpected mock request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runSync, 'function');

  await runSync();
  const failed = sales.status();
  assert.equal(failed.lastSyncAt, null,
    'a missing pagination cursor must not certify the scan');
  assert.equal(failed.lastError?.source, 'sales-sync');
  assert.equal(failed.counts.tracked, 0,
    'the inconsistent page must be rejected before any deal is applied');

  await runSync();
  const recovered = sales.status();
  assert.equal(listReads, 2);
  assert.ok(recovered.lastSyncAt, 'a consistent complete response recovers sync health');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.counts.tracked, 1);
  assert.equal(recovered.prospects[0]?.dealId, deal.ID);
});

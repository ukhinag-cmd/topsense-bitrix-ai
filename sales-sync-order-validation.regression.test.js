'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales sync rejects a Bitrix page outside requested DATE_MODIFY/ID descending order', async t => {
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
  const makeDeal = (id, modifiedAgoMs) => ({
    ID: String(id), TITLE: 'Sync order ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '150000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - modifiedAgoMs).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  });
  const newer = makeDeal(9989002, 60000);
  const older = makeDeal(9989001, 120000);
  let scan = 0;
  global.fetch = async (input, options = {}) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    assert.ok(pathname.endsWith('/crm.deal.list.json'));
    const params = JSON.parse(options.body);
    assert.deepEqual(params.order, { DATE_MODIFY: 'DESC', ID: 'DESC' });
    scan += 1;
    return {
      ok: true, status: 200,
      json: async () => ({ result: scan === 1 ? [older, newer] : [newer, older], total: 2 }),
    };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof runSync, 'function');

  await runSync();
  const invalid = sales.status();
  assert.equal(invalid.lastSyncAt, null, 'an out-of-order page cannot certify a complete scan');
  assert.equal(invalid.lastError?.source, 'sales-sync');
  assert.equal(invalid.counts.tracked, 0,
    'a malformed page must not apply its first row before rejecting later rows');

  await runSync();
  const recovered = sales.status();
  assert.equal(scan, 2);
  assert.ok(recovered.lastSyncAt, 'a sorted retry can complete synchronization');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.counts.tracked, 2);
});
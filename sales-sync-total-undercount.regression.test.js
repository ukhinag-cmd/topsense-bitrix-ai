'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a Bitrix total smaller than the returned page cannot certify Sales sync', async t => {
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

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return previousTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : previousInterval(fn, ms, ...args);

  const now = Date.now();
  const deal = {
    ID: '9988952', TITLE: 'Underreported pagination total', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let readCount = 0;
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: 'P' }],
      }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      readCount += 1;
      const total = readCount === 1 ? 0 : 1;
      return { ok: true, status: 200, json: async () => ({
        result: [deal], total,
      }) };
    }
    throw new Error('Unexpected Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  await scheduledSync();
  const failed = sales.status();
  assert.equal(failed.lastSyncAt, null,
    'a total of zero cannot certify one returned deal');
  assert.equal(failed.lastError?.source, 'sales-sync',
    'contradictory total must be visible in dashboard health');
  assert.equal(failed.counts.tracked, 0,
    'a contradictory page must not overwrite trusted deal data');

  await scheduledSync();
  const recovered = sales.status();
  assert.equal(readCount, 2);
  assert.ok(recovered.lastSyncAt, 'consistent retry recovers synchronization');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.counts.tracked, 1);
  assert.equal(recovered.prospects[0]?.dealId, deal.ID);
});

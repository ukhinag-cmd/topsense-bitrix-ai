'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored source version cannot outrun the displayed modification timestamp and freeze real CRM updates', async t => {
  // A persisted Google Sheet payload is not an authoritative CRM version.
  // The unit assertion and the startup/event integration use local mocks only.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;

  const now = Date.now();
  const old = new Date(now - 3 * 86400000).toISOString();
  const liveVersion = new Date(now - 3600000).toISOString();
  const newer = new Date(now - 60000).toISOString();
  const id = '9931582';
  const base = {
    kind: 'salesDeal', dealId: id, title: 'Old stored representation',
    managerId: '', manager: '—', categoryId: '0', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: 'P', stageSemanticKnown: true,
    open: true, amount: 250000, currency: 'RUB',
    createdAt: new Date(now - 7 * 86400000).toISOString(),
    updatedAt: old, sourceUpdatedAt: old, lastActivityAt: old,
    nextActivityAt: null, hasNext: false, qualificationIssue: false,
    prospectScore: 45, riskScore: 30, nextStep: 'Назначить следующее действие',
    scoreHistory: [], alerts: [],
  };
  assert.equal(validate({ ...base, updatedAt: newer }), true,
    'legacy observations recorded after the source timestamp remain compatible');
  assert.equal(validate({ ...base, updatedAt: newer, sourceUpdatedAt: newer }), true,
    'normal exact-source snapshots remain compatible');
  const poisoned = { ...base, sourceUpdatedAt: newer };
  assert.equal(validate(poisoned), false,
    'a sheet must not claim a CRM version newer than its own displayed update');

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
  process.env.GOOGLE_SHEET_STORE_URL = 'https://store.example.test/sales';
  process.env.GOOGLE_SHEET_STORE_SECRET = 'local-test-only-secret';
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        rows: [{ key: 'sales:deal:' + id, payload: poisoned }],
      }) };
    }
    if (target.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (target.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Verified intermediate CRM update',
        ASSIGNED_BY_ID: '', CATEGORY_ID: '0', STAGE_ID: 'NEW',
        STAGE_SEMANTIC_ID: 'P', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
        DATE_CREATE: base.createdAt, DATE_MODIFY: liveVersion,
        LAST_ACTIVITY_TIME: liveVersion,
      } }) };
    }
    throw new Error('Unexpected external call in mocked test: ' + target);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(sales.status().counts.tracked, 0,
    'a forged source version must not hydrate as an authoritative deal');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const real = sales.status().attention.find(row => row.dealId === id);
  assert.ok(real, 'a legitimate live CRM read must be applied');
  assert.equal(real.title, 'Verified intermediate CRM update');
  assert.equal(real.sourceUpdatedAt, liveVersion);
});

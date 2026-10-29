'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('startup store load ignores Sales snapshots whose key and deal ID do not match', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const storeUrl = 'https://store.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-only-secret';

  // The test exercises startup hydration only, never background sync or writes.
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  const validId = '9912035';
  const now = new Date();
  const valid = {
    kind: 'salesDeal',
    dealId: validId,
    title: 'Verified stored Sales snapshot',
    managerId: '7',
    manager: 'Manager',
    sourceUpdatedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stageId: 'C1:NEW',
    semantic: 'P',
    open: true,
    amount: 1000000,
    currency: 'RUB',
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    lastActivityAt: now.toISOString(),
    nextActivityAt: new Date(now.getTime() + 3600000).toISOString(),
    qualificationStatus: 'Квалифицировано',
    clientType: 'dealer',
    stageEnteredAt: now.toISOString(),
    scoreHistory: [],
    alerts: [],
  };
  const rows = [
    // A mismatched persisted key must never install a phantom deal record.
    { key: 'sales:deal:9912036', payload: { ...valid, dealId: '9912037', title: 'Foreign record' } },
    // An invalid deal ID must never be used as a dashboard key.
    { key: 'sales:deal:invalid', payload: { ...valid, dealId: 'invalid', title: 'Invalid record' } },
    { key: 'sales:deal:' + validId, payload: valid },
  ];

  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (url === storeUrl) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows }) };
    }
    throw new Error('Unexpected mocked request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();

  const dashboard = sales.status();
  assert.equal(dashboard.counts.tracked, 1,
    'only a persisted row with a valid deal ID matching its namespaced key may be loaded');
  const accepted = dashboard.prospects.find(row => row.dealId === validId);
  assert.ok(accepted, 'the valid stored snapshot should remain available after startup');
  assert.equal(accepted.title, valid.title);
  assert.equal(dashboard.prospects.some(row => row.title === 'Foreign record'), false);
});

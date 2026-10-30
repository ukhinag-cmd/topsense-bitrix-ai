'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('startup rejects malformed stored Sales snapshots without corrupting Dashboard or history', async t => {
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

  const storeUrl = 'https://store.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-only-secret';

  // No background synchronization or writes: the test only reads a mocked store.
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : previousTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : previousInterval(fn, ms, ...args);

  const now = new Date();
  const validId = '9913035';
  const valid = {
    kind: 'salesDeal',
    dealId: validId,
    title: 'Last verified snapshot',
    managerId: '7',
    manager: 'Manager',
    sourceUpdatedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stageId: 'C1:NEW',
    semantic: 'P',
    open: true,
    amount: 500000,
    currency: 'RUB',
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    lastActivityAt: now.toISOString(),
    nextActivityAt: new Date(now.getTime() + 3600000).toISOString(),
    hasNext: true,
    qualificationIssue: false,
    prospectScore: 80,
    riskScore: 10,
    qualificationStatus: 'Квалифицировано',
    clientType: 'dealer',
    stageEnteredAt: now.toISOString(),
    scoreHistory: [],
    alerts: [],
  };
  const entry = payload => ({ key: 'sales:deal:' + payload.dealId, payload });
  const rows = [
    entry(valid),
    // Identical key and ID are not enough: a later corrupt row must not
    // overwrite a good snapshot already loaded from the same store.
    entry({ ...valid, title: 'Corrupt duplicate', scoreHistory: {} }),
    entry({ ...valid, dealId: '9913036', alerts: 'not-an-array' }),
    entry({ ...valid, dealId: '9913037', prospectScore: 999 }),
    entry({ ...valid, dealId: '9913038', semantic: 'S', open: true }),
    entry({ ...valid, dealId: '9913039', kind: 'unrelatedRecord' }),
    entry({ ...valid, dealId: '9913040', alerts: [null] }),
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
  assert.equal(dashboard.counts.tracked, 1, 'only structurally valid Sales data may be loaded');
  const accepted = dashboard.prospects.find(row => row.dealId === validId);
  assert.ok(accepted, 'a verified Sales snapshot should survive malformed store neighbours');
  assert.equal(accepted.title, valid.title, 'corrupt duplicate must not replace the valid row');
  assert.ok(Array.isArray(accepted.scoreHistory));
  assert.ok(Array.isArray(accepted.alerts));
  assert.doesNotThrow(() => sales.html(), 'Dashboard rendering must remain available');
});

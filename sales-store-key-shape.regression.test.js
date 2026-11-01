'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Google Sheet key types cannot spoof Sales deal identity or abort startup hydration', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const previousEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const storeUrl = 'https://store.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-only-secret';
  // No live CRM calls, store writes, or background timers.
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const snapshot = (id, title) => ({
    kind: 'salesDeal', dealId: id, title, manager: 'Verified manager',
    stageId: 'NEW', semantic: 'P', open: true, amount: 200000, currency: 'RUB',
    updatedAt: new Date(now - 60000).toISOString(),
    sourceUpdatedAt: new Date(now - 60000).toISOString(),
    createdAt: new Date(now - 86400000).toISOString(),
    lastActivityAt: new Date(now - 120000).toISOString(),
    nextActivityAt: new Date(now + 86400000).toISOString(),
    hasNext: true, qualificationIssue: false,
    prospectScore: 80, riskScore: 10,
    nextStep: 'Следующее действие запланировано',
    scoreHistory: [], alerts: [],
  });
  const rows = [
    // This plain JSON object has no callable toString: String(key) throws.
    { key: { toString: null }, payload: snapshot('9988111', 'Malformed key') },
    // A JSON array coerces to the legitimate-looking namespaced key.
    { key: ['sales:deal:9988112'], payload: snapshot('9988112', 'Array key spoof') },
    { key: 'sales:deal:9988113', payload: snapshot('9988113', 'Verified stored deal') },
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
    throw new Error('Unexpected request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  const dashboard = sales.status();
  assert.equal(dashboard.counts.tracked, 1,
    'malformed keys must be rejected individually without blocking subsequent valid rows');
  assert.equal(dashboard.prospects[0]?.dealId, '9988113');
  assert.equal(dashboard.prospects[0]?.title, 'Verified stored deal');
  assert.equal(dashboard.lastError, null, 'a corrupt individual row is not a complete store outage');
  assert.doesNotThrow(() => sales.html());
});

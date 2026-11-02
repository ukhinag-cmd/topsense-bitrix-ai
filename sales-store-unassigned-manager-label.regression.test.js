'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('restoring an unassigned deal cannot resurrect legacy manager #0', async t => {
  // All transport calls are intercepted; no real Bitrix, Sheets or Render I/O.
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
  process.env.GOOGLE_SHEET_STORE_SECRET = 'mock-only-secret';
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const modifiedAt = new Date(now - 60000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '9990211',
    title: 'Dormant unassigned deal', managerId: '0', manager: '#0',
    categoryId: '0', stageId: 'NEW', semantic: 'P', sourceStageSemantic: 'P',
    open: true, amount: 250000, currency: 'RUB',
    createdAt: new Date(now - 86400000).toISOString(),
    updatedAt: modifiedAt, sourceUpdatedAt: modifiedAt,
    stageEnteredAt: modifiedAt,
    lastActivityAt: new Date(now - 3600000).toISOString(),
    nextActivityAt: new Date(now + 86400000).toISOString(),
    hasNext: true, nextOverdue: false,
    qualificationStatus: 'Квалифицировано', clientType: 'dealer',
    nextStep: 'Следующее действие запланировано',
    qualificationIssue: false, prospectScore: 85, riskScore: 0,
    scoreHistory: [], alerts: [],
  };
  const methods = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.status.list.json')) {
      methods.push('crm.status.list');
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (url === process.env.GOOGLE_SHEET_STORE_URL) {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'load', 'mock store is strictly read-only');
      methods.push('store.load');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        rows: [{ key: 'sales:deal:' + row.dealId, payload: row }],
      }) };
    }
    throw new Error('Unexpected request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  const stored = sales.status().prospects.find(item => item.dealId === row.dealId);
  assert.ok(stored, 'an old dormant deal is still visible');
  assert.equal(stored.managerId, '0', 'stored Bitrix assignment is preserved');
  assert.equal(stored.manager, '—', 'no manager means no #0 after restart');
  assert.deepEqual(methods, ['crm.status.list', 'store.load'],
    'restoring manager metadata must not make user.get or CRM write calls');
});

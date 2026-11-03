'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('startup rejects persisted future contact, stage, creation and alert history dates', async t => {
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

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = 'https://store.example.test/sales';
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-only-secret';
  // Prevent background sync and real writes: only mocked stage/store reads run.
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const recent = new Date(now - 60000).toISOString();
  const created = new Date(now - 3 * 86400000).toISOString();
  const future = new Date(now + 365 * 86400000).toISOString();
  const tomorrow = new Date(now + 86400000).toISOString();
  const validId = '9913071';
  const base = {
    kind: 'salesDeal',
    dealId: validId,
    title: 'Verified recent CRM state',
    managerId: '7',
    manager: 'Verified manager',
    sourceUpdatedAt: recent,
    updatedAt: recent,
    stageId: 'NEW',
    semantic: 'P',
    open: true,
    amount: 500000,
    currency: 'RUB',
    createdAt: created,
    modifiedAt: recent,
    lastActivityAt: recent,
    nextActivityAt: tomorrow, // Future scheduled Next Step is legitimate.
    stageEnteredAt: recent,
    hasNext: true,
    nextStep: 'Следующее действие запланировано',
    qualificationIssue: false,
    prospectScore: 80,
    riskScore: 10,
    qualificationStatus: 'Квалифицировано',
    clientType: 'dealer',
    scoreHistory: [{
      at: recent, stageId: 'NEW', stageName: 'New',
      amount: 500000, currency: 'RUB', prospectScore: 80, riskScore: 10,
    }],
    alerts: [{
      at: recent, type: 'prospect', title: 'Перспективная сделка', detail: 'Score 80',
    }],
  };
  const records = [
    base,
    { ...base, dealId: '9913072', title: 'Future last contact', lastActivityAt: future },
    { ...base, dealId: '9913073', title: 'Future stage entered', stageEnteredAt: future },
    { ...base, dealId: '9913074', title: 'Future created date', createdAt: future },
    { ...base, dealId: '9913075', title: 'Future history', scoreHistory: [{ ...base.scoreHistory[0], at: future }] },
    { ...base, dealId: '9913076', title: 'Future alert', alerts: [{ ...base.alerts[0], at: future }] },
  ];

  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.status.list.json')) {
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ STATUS_ID: 'NEW', SEMANTICS: 'P' }] }),
      };
    }
    if (url === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          rows: records.map(row => ({ key: 'sales:deal:' + row.dealId, payload: row })),
        }),
      };
    }
    throw new Error('Unexpected mocked request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  const dashboard = sales.status();
  assert.equal(dashboard.counts.tracked, 1,
    'impossible future historical timestamps must not contaminate Sales risk, alert or score history');
  assert.equal(dashboard.prospects[0].dealId, validId,
    'a legitimate next action scheduled tomorrow must remain loadable');
  assert.equal(dashboard.prospects[0].alerts[0].at, recent);
});

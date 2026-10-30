'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('future-dated store snapshot cannot freeze live Bitrix deal updates', async t => {
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
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const future = new Date(now + 365 * 86400000).toISOString();
  const current = new Date(now - 60 * 1000).toISOString();
  const dealId = '9913061';
  const poisoned = {
    kind: 'salesDeal',
    dealId,
    title: 'Poisoned future store snapshot',
    managerId: '7',
    manager: 'Manager',
    sourceUpdatedAt: future,
    updatedAt: future,
    stageId: 'NEW',
    semantic: 'P',
    open: true,
    amount: 300000,
    currency: 'RUB',
    createdAt: new Date(now - 86400000).toISOString(),
    lastActivityAt: current,
    nextActivityAt: null,
    hasNext: false,
    nextStep: 'Назначить следующее действие',
    qualificationIssue: false,
    prospectScore: 45,
    riskScore: 30,
    qualificationStatus: '',
    clientType: '',
    stageEnteredAt: current,
    scoreHistory: [],
    alerts: [],
  };

  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          rows: [{ key: 'sales:deal:' + dealId, payload: poisoned }],
        }),
      };
    }
    if (url.endsWith('/crm.status.list.json')) {
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ STATUS_ID: 'NEW', NAME: 'New', SEMANTICS: 'P' }] }),
      };
    }
    if (url.endsWith('/crm.deal.get.json')) {
      return {
        ok: true, status: 200,
        json: async () => ({ result: {
          ID: dealId, TITLE: 'Verified live CRM deal', ASSIGNED_BY_ID: '7',
          STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
          OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
          DATE_CREATE: new Date(now - 86400000).toISOString(),
          DATE_MODIFY: current,
        } }),
      };
    }
    if (url.endsWith('/user.get.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ ID: '7', NAME: 'Verified', LAST_NAME: 'Manager' }],
      }) };
    }
    throw new Error('Unexpected mocked request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(sales.status().counts.tracked, 0,
    'store data claiming a future CRM version must be rejected');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId });
  const live = sales.status().attention.find(row => row.dealId === dealId);
  assert.ok(live, 'a real Bitrix update must become visible');
  assert.equal(live.title, 'Verified live CRM deal');
  assert.equal(live.sourceUpdatedAt, current);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('legacy Sheet snapshot with null source version rejects stale CRM events but permits newer ones', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = 'https://store.example.test/sales';
  process.env.GOOGLE_SHEET_STORE_SECRET = 'mock-only-secret';
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9971442';
  const created = new Date(now - 7 * 86400000).toISOString();
  const storedVersion = new Date(now - 2 * 3600000).toISOString();
  const staleVersion = new Date(now - 3 * 3600000).toISOString();
  const freshVersion = new Date(now - 3600000).toISOString();
  const persisted = {
    kind: 'salesDeal', dealId: id, title: 'Last trusted open deal',
    managerId: '', manager: '—', categoryId: '0', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: 'P', stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB', createdAt: created,
    updatedAt: storedVersion, sourceUpdatedAt: null, modifiedAt: storedVersion,
    lastActivityAt: storedVersion, nextActivityAt: null,
    hasNext: false, qualificationIssue: false, prospectScore: 45, riskScore: 30,
    nextStep: 'Назначить следующее действие', scoreHistory: [], alerts: [],
  };
  let incoming = {
    ID: id, TITLE: 'Stale forged win', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S',
    OPPORTUNITY: '900000', CURRENCY_ID: 'RUB',
    DATE_CREATE: created, DATE_MODIFY: staleVersion,
    LAST_ACTIVITY_TIME: staleVersion,
  };
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load', 'never write to store');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        rows: [{ key: 'sales:deal:' + id, payload: persisted }],
      }) };
    }
    const method = new URL(url).pathname.split('/').pop();
    if (method === 'crm.status.list.json') {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (method === 'crm.deal.get.json') {
      return { ok: true, status: 200, json: async () => ({ result: incoming }) };
    }
    throw new Error('Unexpected mocked REST read: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(sales.status().counts.tracked, 1, 'nullable source versions remain backward-compatible');
  assert.equal(sales.status().counts.won, 0);

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const afterStale = sales.status();
  assert.equal(afterStale.counts.won, 0, 'older CRM response must not overwrite an accepted stored version');
  const retained = afterStale.attention.find(row => row.dealId === id);
  assert.ok(retained);
  assert.equal(retained.title, persisted.title);
  assert.equal(retained.updatedAt, storedVersion);

  incoming = { ...incoming, TITLE: 'Verified newer win', DATE_MODIFY: freshVersion };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const afterFresh = sales.status();
  assert.equal(afterFresh.counts.won, 1, 'strictly newer CRM update must still apply');
  assert.equal(afterFresh.wins[0].title, 'Verified newer win');
  assert.equal(afterFresh.wins[0].sourceUpdatedAt, freshVersion);
  assert.ok(calls.every(url => url === process.env.GOOGLE_SHEET_STORE_URL ||
    /\/(?:crm\.status\.list|crm\.deal\.get)\.json$/.test(new URL(url).pathname)));
});

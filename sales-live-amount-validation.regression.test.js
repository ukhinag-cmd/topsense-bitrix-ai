'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed live Bitrix opportunity amounts cannot replace trusted Sales scoring and history', async t => {
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
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9914454';
  const baselineVersion = new Date(now - 60000).toISOString();
  const newerVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified opportunity', ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000.00', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 10 * 86400000).toISOString(),
    DATE_MODIFY: baselineVersion,
    LAST_ACTIVITY_TIME: new Date(now - 3 * 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let dealResponse = base;
  let listResponse = { result: [] };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: dealResponse }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResponse };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted, 'valid numeric string should be accepted');
  assert.equal(trusted.amount, 300000);
  assert.equal(trusted.sourceUpdatedAt, baselineVersion);

  for (const invalidAmount of ['not-a-number', 'Infinity', { unexpected: true }]) {
    dealResponse = {
      ...base, TITLE: 'Corrupt amount', OPPORTUNITY: invalidAmount,
      DATE_MODIFY: newerVersion,
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      'malformed amount must fail closed instead of being treated as zero');
    const current = state.prospects.find(row => row.dealId === id);
    assert.ok(current, 'last verified prospect remains visible');
    assert.equal(current.amount, trusted.amount);
    assert.equal(current.title, trusted.title);
    assert.equal(current.prospectScore, trusted.prospectScore);
    assert.equal(current.riskScore, trusted.riskScore);
    assert.equal(current.sourceUpdatedAt, baselineVersion);
    assert.equal(current.scoreHistory.length, trusted.scoreHistory.length);
  }

  listResponse = {
    result: [{ ...base, DATE_MODIFY: newerVersion, OPPORTUNITY: 'not-a-number' }],
  };
  await scheduledSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync');
  assert.equal(sales.status().lastSyncAt, null);
  assert.equal(sales.status().sums.open, 300000);

  dealResponse = { ...base, DATE_MODIFY: newerVersion, OPPORTUNITY: '450000.00' };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const updated = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(updated.amount, 450000, 'valid updated numeric opportunity should recover');
  assert.equal(updated.sourceUpdatedAt, newerVersion);
  assert.equal(sales.status().lastError?.source, 'sales-sync',
    'good webhook must not erase an independent sync error');

  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt);
  assert.equal(sales.status().lastError, null);
});

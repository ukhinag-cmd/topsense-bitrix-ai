'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Bitrix stage and currency types cannot fake closed deals or RUB totals', async t => {
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
  const id = '9914461';
  const baseVersion = new Date(now - 60000).toISOString();
  const newVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified open deal', ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000', CURRENCY_ID: 'USD',
    DATE_CREATE: new Date(now - 10 * 86400000).toISOString(),
    DATE_MODIFY: baseVersion,
    LAST_ACTIVITY_TIME: new Date(now - 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
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
    throw new Error('Unexpected Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted, 'valid open deal is present');
  assert.equal(trusted.open, true);
  assert.equal(trusted.currency, 'USD');
  assert.equal(sales.status().counts.won, 0);
  assert.equal(sales.status().sums.open, 0, 'USD values must not be treated as RUB');

  // String(['S']) === 'S' and String(['RUB']) === 'RUB': without type
  // validation these malformed REST values can create phantom wins and
  // fictitious RUB totals/score bonuses.
  const malformed = [
    { STAGE_SEMANTIC_ID: ['S'] },
    { STAGE_SEMANTIC_ID: { value: 'S' } },
    { STAGE_ID: ['WON'] },
    { STAGE_ID: { value: 'WON' } },
    { CURRENCY_ID: ['RUB'] },
    { CURRENCY_ID: { value: 'RUB' } },
    { CURRENCY_ID: false },
  ];
  for (const patch of malformed) {
    dealResponse = { ...base, ...patch, TITLE: 'Untrusted deal',
      DATE_MODIFY: newVersion };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      'malformed stage/currency must fail closed: ' + Object.keys(patch)[0]);
    const row = state.prospects.find(item => item.dealId === id);
    assert.ok(row, 'the last trusted open deal must remain visible');
    assert.equal(row.title, trusted.title);
    assert.equal(row.sourceUpdatedAt, baseVersion);
    assert.equal(row.open, true);
    assert.equal(row.semantic, 'P');
    assert.equal(row.currency, 'USD');
    assert.equal(row.prospectScore, trusted.prospectScore);
    assert.equal(row.riskScore, trusted.riskScore);
    assert.equal(row.scoreHistory.length, trusted.scoreHistory.length);
    assert.equal(state.counts.won, 0);
    assert.equal(state.sums.open, 0);
  }

  for (const patch of [
    { STAGE_SEMANTIC_ID: ['S'] },
    { CURRENCY_ID: ['RUB'] },
  ]) {
    listResponse = { result: [{ ...base, ...patch, DATE_MODIFY: newVersion }] };
    await scheduledSync();
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-sync');
    assert.equal(state.lastSyncAt, null, 'invalid CRM page cannot mark sync healthy');
    assert.equal(state.counts.won, 0);
    assert.equal(state.sums.open, 0);
  }

  dealResponse = { ...base, TITLE: 'Legitimate stage update',
    DATE_MODIFY: newVersion, STAGE_ID: 'C1:ACTIVE',
    STAGE_SEMANTIC_ID: 'P', CURRENCY_ID: 'RUB' };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const updated = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(updated);
  assert.equal(updated.title, 'Legitimate stage update');
  assert.equal(updated.currency, 'RUB');
  assert.equal(updated.sourceUpdatedAt, newVersion);
  assert.equal(updated.open, true);
  assert.equal(updated.scoreHistory.length, trusted.scoreHistory.length + 1);
  assert.equal(sales.status().lastError?.source, 'sales-sync');

  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt);
  assert.equal(sales.status().lastError, null);
});

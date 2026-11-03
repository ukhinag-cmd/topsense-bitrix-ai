'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('missing or blank Bitrix currency cannot turn a nonzero foreign-currency deal into RUB revenue', async t => {
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
    return previousTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : previousInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9915551';
  const baseline = {
    ID: id,
    TITLE: 'Verified USD deal',
    ASSIGNED_BY_ID: '',
    STAGE_ID: 'C1:ACTIVE',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000',
    CURRENCY_ID: 'USD',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const newVersion = new Date(now - 30000).toISOString();
  let current = baseline;
  let listResult = { result: [] };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: current }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResult };
    }
    throw new Error('Unexpected Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted);
  assert.equal(trusted.currency, 'USD');
  assert.equal(sales.status().sums.open, 0);

  const invalid = [
    { CURRENCY_ID: '' },
    { CURRENCY_ID: null },
    { CURRENCY_ID: undefined },
  ];
  for (const patch of invalid) {
    current = { ...baseline, ...patch, TITLE: 'Unverified RUB revenue',
      DATE_MODIFY: newVersion };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', 'invalid currency must fail closed');
    const row = state.prospects.find(item => item.dealId === id);
    assert.equal(row?.title, trusted.title);
    assert.equal(row?.currency, 'USD');
    assert.equal(row?.sourceUpdatedAt, baseline.DATE_MODIFY);
    assert.equal(row?.scoreHistory.length, trusted.scoreHistory.length);
    assert.equal(state.sums.open, 0, 'unverified monetary amounts are not RUB');
  }

  listResult = { result: [{ ...baseline, CURRENCY_ID: '', DATE_MODIFY: newVersion }] };
  await scheduledSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync');
  assert.equal(sales.status().lastSyncAt, null);
  assert.equal(sales.status().sums.open, 0);

  // An actual read with a verified currency must recover without requiring
  // access to a live Bitrix account or writing to CRM.
  current = { ...baseline, CURRENCY_ID: 'RUB', TITLE: 'Verified RUB deal',
    DATE_MODIFY: newVersion };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const recovered = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(recovered?.currency, 'RUB');
  assert.equal(recovered?.title, 'Verified RUB deal');
  assert.equal(sales.status().sums.open, 300000);
  assert.equal(recovered?.scoreHistory.length, trusted.scoreHistory.length + 1);
});

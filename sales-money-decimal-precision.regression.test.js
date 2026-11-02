'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales refuses Bitrix decimal money strings that lose value on Number conversion', async t => {
  const originalFetch = global.fetch;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const now = Date.now();
  const id = '9914491';
  const firstVersion = new Date(now - 60000).toISOString();
  const nextVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified fractional RUB deal', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    CURRENCY_ID: 'RUB', OPPORTUNITY: '300000.10',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: firstVersion,
    LAST_ACTIVITY_TIME: new Date(now - 30000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let returnedDeal = base;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: returnedDeal }) };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const baseline = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(baseline);
  assert.equal(baseline.amount, 300000.1);
  assert.equal(baseline.sourceUpdatedAt, firstVersion);

  // All three values pass the former finite / MAX_SAFE_INTEGER checks.
  // Number() drops a real fraction, changes a cent amount or underflows
  // a nonzero amount to zero, rewriting the CRM monetary audit.
  for (const amount of [
    '5000000000000000.50',
    '1000000000000000.25',
    '1e-999',
  ]) {
    returnedDeal = {
      ...base, OPPORTUNITY: amount, DATE_MODIFY: nextVersion,
      TITLE: 'Rounded or underflowed amount',
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    const current = state.prospects.find(row => row.dealId === id);
    assert.equal(state.lastError?.source, 'sales-event');
    assert.ok(current, 'trusted deal must remain available');
    assert.equal(current.amount, baseline.amount);
    assert.equal(current.title, baseline.title);
    assert.equal(current.sourceUpdatedAt, firstVersion);
    assert.deepEqual(current.scoreHistory, baseline.scoreHistory);
  }

  returnedDeal = { ...base, OPPORTUNITY: '450000.75', DATE_MODIFY: nextVersion };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const recovered = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(recovered.amount, 450000.75);
  assert.equal(recovered.sourceUpdatedAt, nextVersion);
  assert.equal(sales.status().lastError, null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales Dashboard does not silently round a RUB subtotal beyond safe numeric precision', async t => {
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
  let selectedDeal;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: selectedDeal }) };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };
  const sales = require('./sales');

  // Each CRM amount is individually valid and an exactly representable
  // integer, but adding the two amounts exceeds MAX_SAFE_INTEGER.
  for (const id of ['9914471', '9914472']) {
    selectedDeal = {
      ID: id, TITLE: 'Large but individually safe RUB amount',
      ASSIGNED_BY_ID: '', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
      CATEGORY_ID: '0', OPPORTUNITY: '5000000000000000', CURRENCY_ID: 'RUB',
      DATE_CREATE: new Date(now - 86400000).toISOString(),
      DATE_MODIFY: new Date(now).toISOString(),
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  }

  const state = sales.status();
  assert.equal(state.counts.open, 2);
  assert.equal(state.lastError, null);
  assert.equal(state.sums.open, null,
    'unsafe subtotal must be unavailable, not a rounded JSON number');
  assert.match(sales.html(), /предел точности/,
    'Dashboard must explain unavailable totals instead of displaying 0 RUB');
  assert.doesNotMatch(sales.html(), /10[\s\u00a0\u202f]*000[\s\u00a0\u202f]*000[\s\u00a0\u202f]*000[\s\u00a0\u202f]*000/,
    'Dashboard must not present an unsafe grand total as exact');
});

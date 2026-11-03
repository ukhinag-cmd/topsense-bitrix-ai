'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales Dashboard retains fractional RUB values and never publishes a rounded decimal subtotal', async t => {
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
  const ids = ['9914501', '9914502'];
  let selectedDeal = null;
  let version = 0;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: selectedDeal }) };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };
  const sales = require('./sales');
  const apply = async (id, opportunity) => {
    selectedDeal = {
      ID: id, TITLE: 'Decimal RUB accuracy ' + id, ASSIGNED_BY_ID: '',
      CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
      OPPORTUNITY: opportunity, CURRENCY_ID: 'RUB',
      DATE_CREATE: new Date(now - 86400000).toISOString(),
      DATE_MODIFY: new Date(now + (version++) * 1000).toISOString(),
      LAST_ACTIVITY_TIME: new Date(now).toISOString(),
      ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
      UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
      UF_CRM_AI_CLIENT_TYPE: 'dealer',
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    assert.equal(sales.status().lastError, null);
  };

  // Each amount passes the scalar decimal validation, but JS drops the
  // fractional half RUB when adding to a much larger (still safe) number.
  await apply(ids[0], '5000000000000000');
  await apply(ids[1], '0.5');
  assert.equal(sales.status().sums.open, null,
    'a rounded but MAX_SAFE_INTEGER-bounded subtotal cannot be shown as exact');
  assert.match(sales.html(), /предел точности/);

  // Decimal cents must remain visible rather than being rounded to RUB
  // integers in cards, current deals, history and alert money displays.
  await apply(ids[0], '300000.25');
  await apply(ids[1], '200000.50');
  let state = sales.status();
  assert.equal(state.sums.open, 500000.75);
  let html = sales.html();
  assert.match(html, /300[\s\u00a0\u202f]*000,25/);
  assert.match(html, /200[\s\u00a0\u202f]*000,5/);
  assert.match(html, /500[\s\u00a0\u202f]*000,75/);

  // Ordinary decimal inputs must sum to the exact decimal result in JSON,
  // not a machine floating-point artifact such as 0.30000000000000004.
  await apply(ids[0], '0.1');
  await apply(ids[1], '0.2');
  state = sales.status();
  assert.equal(state.sums.open, 0.3);
  html = sales.html();
  assert.match(html, /0,3[\s\u00a0\u202f]*₽/);
});

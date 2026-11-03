'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales rejects impossible or non-CRM date strings without corrupting a trusted deal', async t => {
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

  const id = '9915401';
  const now = Date.now();
  const goodVersion = new Date(now).toISOString();
  let deal = {
    ID: id, TITLE: 'Trusted CRM timeline', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: '2024-02-29T10:45:00+03:00',
    DATE_MODIFY: goodVersion,
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    NEXT_ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    throw new Error('Unexpected mock CRM request: ' + path);
  };

  const sales = require('./sales');
  const event = { event: 'ONCRMDEALUPDATE', dealId: id };

  // JS Date.parse normalizes February 30 to March 2. A malformed Bitrix
  // version must not become an apparently valid score/history observation.
  deal = { ...deal, DATE_MODIFY: '2026-02-30T12:00:00Z' };
  await sales.handleEvent(event);
  assert.equal(sales.status().counts.tracked, 0,
    'calendar-impossible CRM timestamps must be rejected, not normalized');

  // JS Date.parse('1') is 2001-01-01. Do not mistake a bare numeral for a
  // Bitrix datetime and authorize it as the source-version key.
  deal = { ...deal, DATE_CREATE: null, DATE_MODIFY: '1' };
  await sales.handleEvent(event);
  assert.equal(sales.status().counts.tracked, 0,
    'loose Date.parse strings must not be accepted as CRM versions');

  deal = { ...deal, DATE_CREATE: '2024-02-29T10:45:00+03:00', DATE_MODIFY: goodVersion };
  await sales.handleEvent(event);
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted, 'a real leap-day timestamp with Bitrix offset remains valid');
  assert.equal(trusted.title, 'Trusted CRM timeline');

  deal = {
    ...deal, TITLE: 'Forged newer update',
    DATE_MODIFY: new Date(now + 1000).toISOString(),
    LAST_ACTIVITY_TIME: '2026-02-30T12:00:00Z',
  };
  await sales.handleEvent(event);
  const after = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(after.title, 'Trusted CRM timeline',
    'an impossible contact date must not overwrite a trusted CRM snapshot');
  assert.equal(after.sourceUpdatedAt, goodVersion);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalEnv = {
  BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
  GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
  GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
};
process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
delete process.env.GOOGLE_SHEET_STORE_URL;
delete process.env.GOOGLE_SHEET_STORE_SECRET;

const sales = require('./sales');

function bitrixResponse(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

test('foreign-currency deal amounts do not use RUB thresholds or inflate RUB totals', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const now = Date.now();
  let deal = {
    ID: '8880021',
    TITLE: 'Currency threshold regression',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'USD',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: new Date(now).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 60 * 60 * 1000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) return bitrixResponse(deal);
    if (path.endsWith('/user.get.json')) return bitrixResponse([{ ID: '7', NAME: 'Current', LAST_NAME: 'Manager' }]);
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  let state = sales.status();
  let row = state.prospects.find(item => item.dealId === deal.ID);

  assert.ok(row, 'qualified high-potential deal should appear in prospects');
  assert.equal(row.currency, 'USD');
  assert.equal(row.prospectScore, 85, 'USD amount must not earn RUB size bonuses');
  assert.equal(row.riskScore, 0, 'USD amount must not trigger the RUB high-value risk penalty');
  assert.equal(row.qualificationIssue, false, 'USD amount must not trigger a RUB-only qualification threshold');
  assert.equal(row.scoreHistory.length, 1);
  assert.equal(row.scoreHistory[0].currency, 'USD');
  assert.equal(state.sums.open, 0, 'foreign-currency value must not be added to the RUB subtotal');
  assert.equal(state.sums.prospects, 0);
  assert.equal(state.excludedCurrencyCounts.open, 1);
  assert.equal(state.excludedCurrencyCounts.prospects, 1);

  const html = sales.html();
  assert.match(html, /\$/);
  assert.match(html, /1[\s\u00a0\u202f]*000[\s\u00a0\u202f]*000/);
  assert.match(html, /1 вне суммы/);

  deal = {
    ...deal,
    CURRENCY_ID: 'RUB',
    DATE_MODIFY: new Date(now + 1000).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });

  state = sales.status();
  row = state.prospects.find(item => item.dealId === deal.ID);
  assert.equal(row.currency, 'RUB');
  assert.equal(row.prospectScore, 100);
  assert.equal(row.riskScore, 8);
  assert.equal(row.scoreHistory.length, 2, 'currency change must be retained in history');
  assert.equal(row.scoreHistory[1].currency, 'RUB');
  assert.equal(state.sums.open, 1000000, 'RUB amount is now included in the RUB subtotal');
  assert.equal(state.excludedCurrencyCounts.open, 0);
});

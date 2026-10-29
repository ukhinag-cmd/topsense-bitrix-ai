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

test('Dashboard escapes untrusted currency identifiers in rows and alerts', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const now = Date.now();
  const currency = '<img src=x onerror=alert(1)>';
  const deal = {
    ID: '8880042',
    TITLE: 'HTML escaping regression',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000',
    CURRENCY_ID: currency,
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) return bitrixResponse(deal);
    if (path.endsWith('/user.get.json')) {
      return bitrixResponse([{ ID: '7', NAME: 'Test', LAST_NAME: 'Manager' }]);
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  const state = sales.status();
  assert.ok(state.prospects.some(row => row.dealId === deal.ID));
  assert.ok(state.alerts.some(alert => alert.dealId === deal.ID && alert.type === 'prospect'));

  const html = sales.html();
  assert.equal(html.toLowerCase().includes('<img src=x onerror='), false, 'HTML markup from CRM data must not execute');
  const escaped = html.split('&lt;IMG SRC=X ONERROR=ALERT(1)&gt;').length - 1;
  assert.ok(escaped.length >= 2, 'both prospect row and alert must HTML-escape the currency label');
});

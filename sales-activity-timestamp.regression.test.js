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

test('LAST_ACTIVITY_BY user ID is never scored as an activity timestamp', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const modifiedAt = new Date().toISOString();
  const nextActivity = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const deal = {
    ID: '8880001',
    TITLE: 'Activity timestamp fallback regression',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: modifiedAt,
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_BY: '7',
    ACTIVITY_TIME: nextActivity,
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
  const row = sales.status().prospects.find(item => item.dealId === deal.ID);

  assert.ok(row, 'the high-potential open deal should appear in the dashboard');
  assert.equal(row.lastActivityAt, modifiedAt);
  assert.ok(row.lastActivityAgeDays < 0.001, 'the modified timestamp is recent');
  assert.ok(row.riskScore < 20, 'a numeric activity-owner ID must not create false inactivity risk');
});

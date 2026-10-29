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

test('unknown Bitrix stage semantics are surfaced and scored conservatively', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const now = Date.now();
  const modifiedAt = new Date(now).toISOString();
  const deal = {
    ID: '8880017',
    TITLE: 'Unknown stage semantics regression',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:UNKNOWN',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_BY: '7',
  };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) return bitrixResponse(deal);
    if (path.endsWith('/user.get.json')) return bitrixResponse([{ ID: '7', NAME: 'Test', LAST_NAME: 'Manager' }]);
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  const row = sales.status().attention.find(item => item.dealId === deal.ID);

  assert.ok(row, 'a deal with unknown stage semantics must remain visible for review');
  assert.equal(row.stageSemanticKnown, false);
  assert.equal(row.prospectScore, 45, 'unknown stage must not earn the open-stage prospect bonus');
  assert.equal(row.riskScore, 73, 'unknown stage semantics must add a conservative risk penalty');
  assert.equal(row.nextStep, 'Проверить стадию — семантика Bitrix не определена');
});

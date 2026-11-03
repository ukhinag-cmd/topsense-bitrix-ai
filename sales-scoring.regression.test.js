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

test('scores, Next Step, qualification and history update from read-only deal snapshots', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const now = Date.now();
  const createdAt = new Date(now - 2 * 86400000).toISOString();
  let deal = {
    ID: '8880002',
    TITLE: 'Scoring regression',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: createdAt,
    DATE_MODIFY: new Date(now).toISOString(),
    LAST_ACTIVITY_BY: '7',
  };

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) return bitrixResponse(deal);
    if (path.endsWith('/user.get.json')) return bitrixResponse([{ ID: '7', NAME: 'Current', LAST_NAME: 'Manager' }]);
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  const initial = sales.status().attention.find(item => item.dealId === deal.ID);
  assert.ok(initial, 'an unqualified high-value deal without a next action needs attention');
  assert.equal(initial.prospectScore, 55);
  assert.equal(initial.riskScore, 53);
  assert.equal(initial.hasNext, false);
  assert.equal(initial.nextStep, 'Назначить следующее действие');
  assert.equal(initial.qualificationIssue, true);
  assert.equal(initial.scoreHistory.length, 1);

  deal = {
    ...deal,
    TITLE: 'Scoring regression qualified',
    DATE_MODIFY: new Date(now + 1000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 60 * 60 * 1000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  const updated = sales.status().prospects.find(item => item.dealId === deal.ID);
  assert.ok(updated, 'the newly qualified high-potential deal appears in the prospect list');
  assert.equal(updated.prospectScore, 100);
  assert.equal(updated.riskScore, 8);
  assert.equal(updated.hasNext, true);
  assert.match(updated.nextStep, /^Следующее действие: /);
  assert.equal(updated.qualificationIssue, false);
  assert.equal(updated.scoreHistory.length, 2, 'a score/risk change creates one new history point');
  assert.equal(updated.scoreHistory[1].prospectScore, 100);
  assert.equal(updated.scoreHistory[1].riskScore, 8);
});

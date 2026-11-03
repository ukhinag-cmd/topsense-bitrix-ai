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

test('scores, overdue Next Step and history age without new Bitrix modifications', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = realNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const realNow = Date.now;
  const at = realNow();
  const day = 86400000;
  const id = '8900017';
  const modifiedAt = new Date(at).toISOString();
  const deal = {
    ID: id,
    TITLE: 'Temporal risk regression',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '100000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(at - day).toISOString(),
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_TIME: modifiedAt,
    ACTIVITY_TIME: new Date(at + 60 * 60000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let crmCalls = 0;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    assert.ok(path.endsWith('/crm.deal.get.json'), 'only the initial read-only CRM deal method is expected');
    crmCalls += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(first);
  assert.equal(first.hasNext, true);
  assert.equal(first.nextOverdue, false);
  assert.equal(first.scoreHistory.length, 1);
  const initialRisk = first.riskScore;
  const initialProspect = first.prospectScore;

  // Time has advanced, but the deal has not changed in CRM, so DATE_MODIFY
  // and the stored source version must remain untouched.
  Date.now = () => at + 70 * 60000;
  const overdue = sales.status().attention.find(x => x.dealId === id);
  assert.ok(overdue);
  assert.equal(overdue.hasNext, false);
  assert.equal(overdue.nextOverdue, true);
  assert.match(overdue.nextStep, /Просрочено следующее действие/);
  assert.ok(overdue.riskScore > initialRisk);
  assert.ok(overdue.prospectScore < initialProspect);
  assert.equal(overdue.sourceUpdatedAt, modifiedAt);
  assert.equal(overdue.scoreHistory.length, 2);

  // A much older last contact must continue to increase risk in a dashboard
  // that has not received another webhook, including deals not re-synced.
  Date.now = () => at + 16 * day;
  const stale = sales.status().attention.find(x => x.dealId === id);
  assert.ok(stale.riskScore > overdue.riskScore);
  assert.equal(stale.sourceUpdatedAt, modifiedAt);
  assert.equal(stale.scoreHistory.length, 3);
  assert.equal(sales.status().attention.find(x => x.dealId === id).scoreHistory.length, 3,
    'unchanged time-sensitive scores must not create duplicate history entries');
  assert.equal(crmCalls, 1, 'dashboard time checks must not perform Bitrix requests');
});

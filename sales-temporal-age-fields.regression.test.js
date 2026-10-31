'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Dashboard refreshes age diagnostics without adding fake CRM versions or score history', async t => {
  const originalFetch = global.fetch;
  const realNow = Date.now;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = realNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const at = realNow();
  const day = 86400000;
  const id = '9988962';
  const version = new Date(at - 60000).toISOString();
  const deal = {
    ID: id, TITLE: 'Temporal age diagnostics', CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(at - day).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(at - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(at + 10 * day).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };

  let reads = 0;
  global.fetch = async input => {
    assert.match(new URL(String(input)).pathname, /\/crm\.deal\.get\.json$/);
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const initial = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(initial, 'read-only event must create a visible prospect');
  assert.equal(initial.scoreHistory.length, 1);

  // Two days pass, still below the Risk/Prospect age thresholds.
  // The JSON dashboard's age fields must nevertheless be current.
  Date.now = () => at + 2 * day;
  const updated = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(updated);
  assert.equal(updated.prospectScore, initial.prospectScore);
  assert.equal(updated.riskScore, initial.riskScore);
  assert.ok(updated.dealAgeDays >= initial.dealAgeDays + 1.9,
    'dealAgeDays must age even when riskScore stays at the same threshold');
  assert.ok(updated.lastActivityAgeDays >= initial.lastActivityAgeDays + 1.9,
    'lastActivityAgeDays must advance without a new webhook');
  assert.ok(updated.stageAgeDays >= initial.stageAgeDays + 1.9,
    'stageAgeDays must advance without a stage transition');
  assert.equal(updated.sourceUpdatedAt, version);
  assert.equal(updated.observedAt, initial.observedAt);
  assert.deepEqual(updated.scoreHistory, initial.scoreHistory,
    'age-only diagnostic updates must not fabricate a scoring event');
  assert.equal(sales.status().prospects.find(row => row.dealId === id).scoreHistory.length, 1);
  assert.equal(reads, 1, 'time-only recomputation must not contact Bitrix');
});

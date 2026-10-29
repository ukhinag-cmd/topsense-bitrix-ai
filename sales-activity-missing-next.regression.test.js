'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('same-version activity without next-action fields preserves the scheduled Next Step', async t => {
  const originalFetch = global.fetch;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const sales = require('./sales');
  const now = Date.now();
  const day = 86400000;
  const id = '85610092';
  const nextStepAt = new Date(now + 5 * 3600000).toISOString();
  const newerContactAt = new Date(now - 20 * 60000).toISOString();
  const version = new Date(now - 2 * 3600000).toISOString();
  const deal = {
    ID: id,
    TITLE: 'Scheduled follow-up',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '750000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 20 * day).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 16 * day).toISOString(),
    ACTIVITY_TIME: nextStepAt,
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  const contactOnly = {
    ...deal,
    TITLE: 'Stale title from activity fetch',
    OPPORTUNITY: '1',
    LAST_ACTIVITY_TIME: newerContactAt,
    ACTIVITY_TIME: null,
    NEXT_ACTIVITY_TIME: '',
  };
  let dealReads = 0;
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    let result;
    if (path.endsWith('/crm.deal.get.json')) {
      result = ++dealReads === 1 ? deal : contactOnly;
    } else if (path.endsWith('/crm.activity.get.json')) {
      result = { ID: JSON.parse(options.body).id, OWNER_TYPE_ID: 2, OWNER_ID: id };
    } else {
      throw new Error('Unexpected Bitrix method: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const before = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(before);
  assert.equal(before.nextActivityAt, nextStepAt);
  assert.equal(before.hasNext, true);

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '73' });
  const after = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(after);
  assert.equal(after.sourceUpdatedAt, version, 'activity alone must not change the deal version');
  assert.equal(after.lastActivityAt, newerContactAt, 'new contact should still update Risk Score');
  assert.equal(after.nextActivityAt, nextStepAt, 'blank activity fields must not erase a known appointment');
  assert.equal(after.hasNext, true);
  assert.equal(after.nextOverdue, false);
  assert.equal(after.title, deal.TITLE);
  assert.equal(after.amount, 750000);
  assert.ok(after.riskScore < before.riskScore, 'contact recency must reduce the risk');
  assert.ok(!after.nextStep.includes('Назначить следующее действие'));
});

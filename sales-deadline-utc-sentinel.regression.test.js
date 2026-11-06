'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

const noDeadlineUtc = '9999-12-30T21:00:00.000Z';
// Bitrix documents the no-deadline sentinel as 9999-12-31 00:00+03:00.
// An intermediary may serialize that same instant in UTC on the prior day.
const genuineDeadline = '2026-11-08T09:30:00+03:00';

test('read-only activity probe ignores UTC-normalized Bitrix no-deadline sentinel', async () => {
  const result = await probeDealNextActivity(async () => ({
    result: [
      { ID: '10421', OWNER_TYPE_ID: '2', OWNER_ID: '72', COMPLETED: 'N', DEADLINE: noDeadlineUtc },
      { ID: '10422', OWNER_TYPE_ID: '2', OWNER_ID: '72', COMPLETED: 'N', DEADLINE: genuineDeadline },
    ],
    total: 2,
  }), 72);
  assert.deepEqual(result, {
    nextActivityAt: '2026-11-08T06:30:00.000Z',
    activitiesWithNoDeadline: 1,
    checked: 2,
  });
});

test('live read-only Next Step and scores ignore UTC-normalized no-deadline date', async t => {
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

  const id = '9942407';
  const now = Date.now();
  const scheduled = new Date(now + 2 * 86400000).toISOString();
  const base = {
    ID: id, TITLE: 'UTC deadline sentinel', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 300000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let deal = {
    ...base, DATE_MODIFY: new Date(now - 60000).toISOString(),
    ACTIVITY_TIME: noDeadlineUtc, NEXT_ACTIVITY_TIME: scheduled,
  };
  global.fetch = async input => {
    if (!new URL(String(input)).pathname.endsWith('/crm.deal.get.json')) {
      throw new Error('Unexpected mock-only Bitrix read');
    }
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const withNext = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(withNext, 'high-score deal is represented in Dashboard');
  assert.equal(withNext.nextActivityAt, scheduled, 'real secondary schedule takes precedence over placeholder');
  assert.equal(withNext.hasNext, true);

  deal = {
    ...base, DATE_MODIFY: new Date(now - 30000).toISOString(),
    ACTIVITY_TIME: noDeadlineUtc, NEXT_ACTIVITY_TIME: noDeadlineUtc,
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const withoutNext = sales.status().attention.find(row => row.dealId === id);
  assert.ok(withoutNext, 'missing Next Step remains visible for attention');
  assert.equal(withoutNext.nextActivityAt, null);
  assert.equal(withoutNext.hasNext, false);
  assert.equal(withoutNext.nextOverdue, false);
  assert.equal(withoutNext.nextStep, 'Назначить следующее действие');
  assert.ok(withoutNext.riskScore >= withNext.riskScore + 30);
  assert.equal(withoutNext.prospectScore, withNext.prospectScore - 15);
});

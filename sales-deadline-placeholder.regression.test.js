'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('year-9999 Bitrix no-deadline placeholder never invents Next Step or lowers Risk Score', async t => {
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

  const id = '9942197';
  const now = Date.now();
  const scheduled = new Date(now + 2 * 86400000).toISOString();
  // Bitrix's activity API uses year 9999 to denote no scheduled deadline.
  const noDeadline = '9999-12-31T00:00:00+03:00';
  const base = {
    ID: id, TITLE: 'Placeholder deadline regression', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 300000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let deal = { ...base, ACTIVITY_TIME: noDeadline, NEXT_ACTIVITY_TIME: scheduled };
  global.fetch = async input => {
    if (!new URL(String(input)).pathname.endsWith('/crm.deal.get.json')) {
      throw new Error('Unexpected mocked read-only Bitrix method');
    }
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const withScheduled = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(withScheduled, 'an actual secondary scheduled action remains usable');
  assert.equal(withScheduled.nextActivityAt, scheduled,
    'the no-deadline sentinel must not mask a real secondary schedule');
  assert.equal(withScheduled.hasNext, true);
  assert.equal(withScheduled.nextOverdue, false);

  deal = { ...base,
    DATE_MODIFY: new Date(now - 30000).toISOString(),
    ACTIVITY_TIME: noDeadline, NEXT_ACTIVITY_TIME: noDeadline,
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const withoutSchedule = sales.status().attention.find(row => row.dealId === id);
  assert.ok(withoutSchedule, 'a deal with no scheduled activity must need attention');
  assert.equal(withoutSchedule.hasNext, false);
  assert.equal(withoutSchedule.nextOverdue, false);
  assert.equal(withoutSchedule.nextActivityAt, null);
  assert.equal(withoutSchedule.nextStep, 'Назначить следующее действие');
  assert.ok(withoutSchedule.riskScore >= withScheduled.riskScore + 30,
    'absence of a scheduled action must increase Risk Score');
  assert.equal(withoutSchedule.prospectScore, withScheduled.prospectScore - 15,
    'placeholder must not grant the scheduled-action Prospect bonus');
  assert.equal(withoutSchedule.scoreHistory.length, 2,
    'a genuine score change remains auditable');
});

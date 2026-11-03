'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Risk Score uses verified CRM creation date, never planned BEGINDATE as a fallback', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  // Suppress store flush timers; no real Bitrix/Sheets/network calls.
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const id = '9980721';
  const oldDate = new Date(now - 100 * 86400000).toISOString();
  const base = {
    ID: id, TITLE: 'Planned start is not creation', ASSIGNED_BY_ID: '',
    STAGE_ID: 'C1:WORK', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: '', BEGINDATE: oldDate,
    DATE_MODIFY: new Date(now - 120000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    NEXT_ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let response = base;
  global.fetch = async input => {
    const pathname = new URL(String(input)).pathname;
    if (!pathname.endsWith('/crm.deal.get.json')) {
      throw new Error('Unexpected mocked Bitrix method: ' + pathname);
    }
    return { ok: true, status: 200, json: async () => ({ result: response }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const initial = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(initial, 'qualified deal should be visible in prospects');
  assert.equal(initial.createdAt, null,
    'a planned deal start must not masquerade as the CRM creation timestamp');
  assert.equal(initial.dealAgeDays, null,
    'without DATE_CREATE the age is unknown, not 100 days');
  assert.equal(initial.riskScore, 8,
    'an arbitrary old BEGINDATE must not add 18 points of deal-age risk');
  assert.equal(initial.scoreHistory.length, 1);

  // An authoritative older DATE_CREATE is different: its age should count.
  response = {
    ...base,
    DATE_CREATE: oldDate,
    DATE_MODIFY: new Date(now - 60000).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const verified = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(verified);
  assert.equal(verified.createdAt, oldDate);
  assert.equal(verified.riskScore, 26);
  assert.equal(verified.scoreHistory.length, 2,
    'only a verified change in Risk Score appends the second history point');
});

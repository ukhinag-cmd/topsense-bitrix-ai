'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalNow = Date.now;
const originalEnv = {
  TZ: process.env.TZ,
  BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
  GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
  GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
};

// Render commonly uses UTC, but TOP-SENS business dates use Moscow time.
process.env.TZ = 'UTC';
process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
delete process.env.GOOGLE_SHEET_STORE_URL;
delete process.env.GOOGLE_SHEET_STORE_SECRET;

const sales = require('./sales');

test('Moscow-midnight Next Step and history display the business date on a UTC host', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // At 00:20 Moscow it is still the previous calendar day in UTC.
  Date.now = () => Date.parse('2026-11-03T21:20:00.000Z');
  const id = '9927604';
  const deal = {
    ID: id,
    TITLE: 'Moscow midnight rendering',
    ASSIGNED_BY_ID: '0',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:PROPOSAL',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '100000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-11-01T00:20:00+03:00',
    DATE_MODIFY: '2026-11-04T00:20:00+03:00',
    LAST_ACTIVITY_TIME: '2026-11-04T00:20:00+03:00',
    ACTIVITY_TIME: '2026-11-04T00:30:00+03:00',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let reads = 0;
  global.fetch = async input => {
    const pathname = new URL(String(input)).pathname;
    assert.match(pathname, /\/crm\.deal\.get\.json$/, 'only read-only deal lookup is permitted');
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const item = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(item, 'qualified deal with upcoming action is shown in prospects');
  assert.equal(item.nextStep, 'Следующее действие: 04.11.26',
    'Next Step calendar day must not move backward on an UTC host');

  const html = sales.html();
  assert.match(html, /04\.11\.26,\s*00:20/,
    'score history must render the Moscow wall-clock time, not 21:20 UTC');
  assert.equal(reads, 1, 'Dashboard rendering must never query live CRM');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Only in-memory Bitrix REST responses. No real CRM, Sheets or Render requests.
test('timezone-free CRM datetimes cannot change trusted Sales scores, outcomes or Next Step', async t => {
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

  const now = Date.now();
  const id = '9928011';
  const oldVersion = new Date(now - 60000).toISOString();
  const newVersion = new Date(now + 2000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified CRM deal', ASSIGNED_BY_ID: '0',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 10 * 86400000).toISOString(),
    DATE_MODIFY: oldVersion,
    LAST_ACTIVITY_TIME: new Date(now - 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    NEXT_ACTIVITY_TIME: new Date(now + 7200000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let deal = base;
  let calls = 0;
  global.fetch = async input => {
    const pathname = new URL(String(input)).pathname;
    assert.match(pathname, /\/crm\.deal\.get\.json$/, 'only read-only CRM lookup is allowed');
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };
  const sales = require('./sales');
  const event = { event: 'ONCRMDEALUPDATE', dealId: id };
  await sales.handleEvent(event);
  const trusted = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(trusted, 'verified deal must be visible in Prospect Score queue');
  assert.equal(trusted.sourceUpdatedAt, oldVersion);
  const toLocal = iso => iso.replace(/Z$/, '');

  for (const [field, badValue] of [
    ['DATE_MODIFY', toLocal(newVersion)],
    ['DATE_CREATE', toLocal(base.DATE_CREATE)],
    ['LAST_ACTIVITY_TIME', toLocal(base.LAST_ACTIVITY_TIME)],
    ['ACTIVITY_TIME', toLocal(base.ACTIVITY_TIME)],
    ['NEXT_ACTIVITY_TIME', toLocal(base.NEXT_ACTIVITY_TIME)],
    ['DATE_MODIFY', newVersion.slice(0, 10)],
    ['LAST_ACTIVITY_TIME', base.LAST_ACTIVITY_TIME.slice(0, 10)],
    ['ACTIVITY_TIME', base.ACTIVITY_TIME.slice(0, 10)],
  ]) {
    deal = {
      ...base, TITLE: 'Ambiguous ' + field,
      DATE_MODIFY: newVersion, STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S',
      [field]: badValue,
    };
    await sales.handleEvent(event);
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', field + ' must reject missing timezone');
    assert.equal(state.counts.open, 1, field + ' must not close a trusted open deal');
    assert.equal(state.counts.won, 0);
    const unchanged = state.prospects.find(x => x.dealId === id);
    assert.equal(unchanged?.title, base.TITLE);
    assert.equal(unchanged.sourceUpdatedAt, oldVersion);
    assert.equal(unchanged.riskScore, trusted.riskScore);
    assert.equal(unchanged.nextActivityAt, trusted.nextActivityAt);
    assert.equal(unchanged.scoreHistory.length, trusted.scoreHistory.length);
  }

  deal = { ...base, TITLE: 'Verified newer deal', DATE_MODIFY: newVersion };
  await sales.handleEvent(event);
  const recovered = sales.status();
  assert.equal(recovered.lastError, null, 'a subsequent timezone-qualified CRM read recovers');
  assert.equal(recovered.prospects.find(x => x.dealId === id)?.title, 'Verified newer deal');
  assert.equal(calls, 10, 'all REST calls stay on the injected read-only mock');
});

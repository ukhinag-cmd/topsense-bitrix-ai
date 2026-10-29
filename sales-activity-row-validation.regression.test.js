'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed activity reads cannot silently acknowledge events or load an unrelated deal', async t => {
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

  const sales = require('./sales');
  const now = Date.now();
  const dealId = '941005';
  const activityId = '71245';
  const validDeal = {
    ID: dealId,
    TITLE: 'Valid activity owner',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '350000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let activityResponse;
  let activityReads = 0;
  let dealReads = 0;
  global.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.activity.get.json')) {
      activityReads += 1;
      return { ok: true, status: 200, json: async () => ({ result: activityResponse }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      dealReads += 1;
      return { ok: true, status: 200, json: async () => ({ result: validDeal }) };
    }
    throw new Error('Unexpected Bitrix method: ' + path);
  };

  // HTTP 200 is not proof that crm.activity.get returned the requested
  // activity with a valid owner reference. Do not follow mismatched IDs.
  for (const malformed of [
    null,
    {},
    [],
    { ID: '71246', OWNER_TYPE_ID: '2', OWNER_ID: dealId },
    { ID: activityId, OWNER_TYPE_ID: 'unknown', OWNER_ID: dealId },
  ]) {
    activityResponse = malformed;
    await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId });
    assert.equal(sales.status().lastError?.source, 'sales-event',
      'malformed activity response must surface an event error');
    assert.equal(dealReads, 0, 'malformed activity must not fetch an owner deal');
    assert.equal(sales.status().counts.tracked, 0);
  }

  activityResponse = { ID: activityId, OWNER_TYPE_ID: 2, OWNER_ID: dealId };
  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: 'not-an-id' });
  assert.equal(activityReads, 5, 'invalid inbound activity ID is rejected before any REST request');
  assert.equal(sales.status().lastError?.source, 'sales-event');

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId });
  assert.equal(sales.status().lastError, null, 'valid activity read recovers event health');
  assert.equal(dealReads, 1);
  assert.equal(sales.status().counts.tracked, 1);

  activityResponse = { ID: activityId, OWNER_TYPE_ID: 3, OWNER_ID: '12345' };
  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId });
  assert.equal(dealReads, 1, 'valid non-deal activity is ignored');
  assert.equal(sales.status().lastError, null);
});

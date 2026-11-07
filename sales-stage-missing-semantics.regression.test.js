'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage refresh without either Bitrix semantic must not erase a verified pipeline classification', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const oldEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock-only/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 || ms === 5000 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9989919';
  const deal = {
    ID: id, TITLE: 'Semantic provenance guard',
    STAGE_ID: 'ACTIVE', CATEGORY_ID: '0', ASSIGNED_BY_ID: '0',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let stages = [{
    STATUS_ID: 'ACTIVE', NAME: 'Verified process',
    SEMANTICS: null, EXTRA: { SEMANTICS: 'process' },
  }];
  let stageCalls = 0;
  global.fetch = async (input, options) => {
    assert.equal(options.method, 'POST');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageCalls += 1;
      return { ok: true, status: 200, json: async () => ({ result: stages }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    throw new Error('Unexpected mock-only method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const before = sales.status();
  assert.equal(before.prospects.find(row => row.dealId === id)?.semantic, 'P');
  assert.equal(before.lastError, null);

  // If the short field is absent (not explicit null) and no EXTRA semantic
  // exists, the provider has NOT established process, success or failure.
  // Treating this as a successful refresh replaces known P with unknown and
  // distorts Prospect/Risk scores without any real CRM change.
  stages = [{ STATUS_ID: 'ACTIVE', NAME: 'Unverified replacement' }];
  await sales.start();
  const rejected = sales.status();
  const protectedDeal = rejected.prospects.find(row => row.dealId === id);
  assert.equal(stageCalls, 2);
  assert.equal(rejected.lastError?.source, 'stages',
    'missing both semantics is an unhealthy stage refresh');
  assert.equal(protectedDeal?.semantic, 'P',
    'retain the previously verified open classification');
  assert.equal(protectedDeal?.stageName, 'Verified process');
  assert.equal(protectedDeal.prospectScore,
    before.prospects.find(row => row.dealId === id).prospectScore);
  assert.equal(protectedDeal.riskScore,
    before.prospects.find(row => row.dealId === id).riskScore);

  stages = [{ STATUS_ID: 'ACTIVE', NAME: 'Verified success',
    SEMANTICS: 'S', EXTRA: { SEMANTICS: 'success' } }];
  await sales.start();
  const recovered = sales.status();
  assert.equal(stageCalls, 3);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.wins.find(row => row.dealId === id)?.semantic, 'S');
});

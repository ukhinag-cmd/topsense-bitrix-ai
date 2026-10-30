'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('missing CRM modification dates never become trusted Sales deal versions', async t => {
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
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const id = '9942161';
  const version = new Date(now - 60000).toISOString();
  const base = {
    ID: id,
    TITLE: 'Trusted open deal',
    ASSIGNED_BY_ID: '7',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: version,
    NEXT_ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let scenario = 'missing-new';
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    let result;
    if (path.endsWith('/user.get.json')) {
      result = [{ ID: 7, NAME: 'Verified', LAST_NAME: 'Manager' }];
    } else if (path.endsWith('/crm.deal.get.json')) {
      const requested = String(JSON.parse(options.body).ID);
      assert.equal(requested, id);
      if (scenario === 'missing-new' || scenario === 'missing-existing') {
        result = { ...base, DATE_MODIFY: undefined, STAGE_SEMANTIC_ID: 'S' };
      } else if (scenario === 'blank-existing') {
        result = { ...base, DATE_MODIFY: ' ', STAGE_SEMANTIC_ID: 'S' };
      } else {
        result = base;
      }
    } else {
      throw new Error('Unexpected mocked Bitrix read: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALADD', dealId: id });
  assert.equal(sales.status().counts.tracked, 0,
    'an unversioned new deal must not populate Dashboard with an unverifiable snapshot');
  assert.equal(sales.status().lastError?.source, 'sales-event',
    'unversioned data must be reported as a failed read, not a successful webhook');

  scenario = 'valid';
  await sales.handleEvent({ event: 'ONCRMDEALADD', dealId: id });
  assert.equal(sales.status().counts.tracked, 1);
  assert.equal(sales.status().counts.won, 0);
  assert.equal(sales.status().lastError, null, 'a valid version clears the event error');
  const before = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(before);
  const historyLength = before.scoreHistory.length;

  for (const invalid of ['missing-existing', 'blank-existing']) {
    scenario = invalid;
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      invalid + ' must not silently acknowledge a broken CRM update');
    assert.equal(state.counts.won, 0, 'unversioned closed stage must not create a phantom win');
    const after = state.prospects.find(row => row.dealId === id);
    assert.equal(after.sourceUpdatedAt, version);
    assert.equal(after.scoreHistory.length, historyLength);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed live Bitrix Next Step dates cannot poison trusted Sales scores or history', async t => {
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
  const id = '9942164';
  const version = new Date(now - 60000).toISOString();
  const laterVersion = new Date(now + 1000).toISOString();
  const scheduled = new Date(now + 86400000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified follow-up', ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 3 * 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    ACTIVITY_TIME: scheduled,
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let dealResponse = base;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (!path.endsWith('/crm.deal.get.json')) {
      throw new Error('Unexpected mocked Bitrix method: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result: dealResponse }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted);
  assert.equal(trusted.nextActivityAt, scheduled);
  assert.equal(trusted.hasNext, true);

  for (const field of ['ACTIVITY_TIME', 'NEXT_ACTIVITY_TIME']) {
    dealResponse = {
      ...base,
      DATE_MODIFY: laterVersion,
      ACTIVITY_TIME: field === 'ACTIVITY_TIME' ? 'not-a-date' : '',
      NEXT_ACTIVITY_TIME: field === 'NEXT_ACTIVITY_TIME' ? 'not-a-date' : scheduled,
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      field + ' must be rejected rather than acknowledged');
    assert.equal(state.counts.tracked, 1);
    const actual = state.prospects.find(row => row.dealId === id);
    assert.ok(actual, 'last trustworthy prospect remains on the Dashboard');
    assert.equal(actual.sourceUpdatedAt, version);
    assert.equal(actual.nextActivityAt, scheduled);
    assert.equal(actual.prospectScore, trusted.prospectScore);
    assert.equal(actual.riskScore, trusted.riskScore);
    assert.equal(actual.scoreHistory.length, trusted.scoreHistory.length);
  }

  // Planned actions are allowed to be in the future, including well beyond
  // the ten-minute clock-skew allowance for observed CRM timestamps.
  const farFuture = new Date(now + 31 * 86400000).toISOString();
  dealResponse = {
    ...base, DATE_MODIFY: laterVersion,
    ACTIVITY_TIME: '', NEXT_ACTIVITY_TIME: farFuture,
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const recovered = sales.status();
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.prospects.find(row => row.dealId === id)?.nextActivityAt, farFuture);
});

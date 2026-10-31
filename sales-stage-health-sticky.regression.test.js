'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a recovered event error cannot hide an unresolved stage metadata failure', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 || ms === 5000 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  const id = '9988912';
  const now = Date.now();
  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    const method = new URL(String(input)).pathname;
    if (method.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      // A successful HTTP response with a malformed dictionary is still a
      // failed metadata read and cannot establish stage semantics.
      return { ok: true, status: 200, json: async () =>
        ({ result: { error: 'temporarily malformed stage dictionary' } }) };
    }
    if (method.endsWith('/crm.deal.get.json')) {
      assert.equal(String(JSON.parse(options.body).ID), id);
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Open deal with unresolved stage directory',
        CATEGORY_ID: '0', STAGE_ID: 'NEW', ASSIGNED_BY_ID: '',
        OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now - 60000).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
        ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
        UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
        UF_CRM_AI_CLIENT_TYPE: 'dealer',
      } }) };
    }
    throw new Error('Unexpected mocked request: ' + method);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(stageReads, 1);
  assert.equal(sales.status().lastError?.source, 'stages');

  // A different event error replaces the currently displayed failure.
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: 'not-an-id' });
  assert.equal(sales.status().lastError?.source, 'sales-event');

  // The following valid deal read recovers the event error but cannot repair
  // the stage dictionary. Its stage semantics remain unknown.
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const snapshot = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(snapshot);
  assert.equal(snapshot.stageSemanticKnown, false);
  assert.equal(sales.status().lastError?.source, 'stages',
    'dashboard health must retain the unresolved stage failure');
  assert.match(sales.html(), /class="live bad"/,
    'dashboard must not show a healthy/pending sync while stage metadata is invalid');
});

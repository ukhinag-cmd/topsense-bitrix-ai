'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Bitrix deal records fail closed for events and paginated sync', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const requestedId = '941002';
  const now = new Date().toISOString();
  const validDeal = {
    ID: requestedId,
    TITLE: 'Expected deal',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: now,
    DATE_MODIFY: now,
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    ACTIVITY_TIME: new Date(Date.now() + 86400000).toISOString(),
  };
  let dealResponse = {};
  let listResponse = { result: [] };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: dealResponse }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResponse };
    }
    throw new Error('Unexpected Bitrix call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  // HTTP 200 plus an empty deal (or a different deal ID) must not be
  // acknowledged as a successful webhook processing.
  for (const malformed of [
    {},
    { ...validDeal, ID: '941003' },
    { ...validDeal, ID: 'wrong-id' },
  ]) {
    dealResponse = malformed;
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: requestedId });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      'invalid CRM deal read must surface an event error');
    assert.equal(state.counts.tracked, 0, 'invalid read must not create phantom deals');
  }

  dealResponse = validDeal;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: requestedId });
  assert.equal(sales.status().lastError, null, 'valid CRM deal read should recover');

  for (const malformed of [[{}], [{ ID: 'not-an-id' }]]) {
    listResponse = { result: malformed };
    await scheduledSync();
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-sync');
    assert.equal(state.lastSyncAt, null,
      'a list with malformed deal rows must not be considered synchronized');
    assert.equal(state.counts.tracked, 1, 'invalid list rows must not add phantom deals');
  }

  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt, 'a valid empty page can complete the sync');
  assert.equal(sales.status().lastError, null);
});

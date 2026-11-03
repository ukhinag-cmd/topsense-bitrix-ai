'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a malformed Bitrix sync page never partially replaces verified deal snapshots', async t => {
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

  const now = Date.now();
  const originalDeal = {
    ID: '9962001',
    TITLE: 'Verified CRM deal',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const updatedDeal = {
    ...originalDeal,
    TITLE: 'Newer verified CRM deal',
    OPPORTUNITY: '1000000',
    DATE_MODIFY: new Date(now - 10000).toISOString(),
  };
  let listResponse = { result: [] };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: originalDeal }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResponse };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: originalDeal.ID });
  const before = sales.status().prospects.find(deal => deal.dealId === originalDeal.ID);
  assert.ok(before, 'seed a trusted scored deal via a valid CRM read');

  for (const malformed of [
    { result: [updatedDeal], next: 50 },
    { result: [updatedDeal, { ID: 'invalid' }] },
    // A page with the same deal twice but conflicting source versions is
    // inconsistent. Do not accept whichever copy happened to appear first.
    { result: [updatedDeal, { ...originalDeal, DATE_MODIFY: new Date(now - 20000).toISOString() }] },
  ]) {
    listResponse = malformed;
    await scheduledSync();
    const state = sales.status();
    const after = state.prospects.find(deal => deal.dealId === originalDeal.ID);
    assert.equal(state.lastError?.source, 'sales-sync');
    assert.equal(state.lastSyncAt, null);
    assert.equal(after.title, before.title, 'reject the entire malformed page');
    assert.equal(after.amount, before.amount, 'retain the last verified CRM amount');
    assert.deepEqual(after.scoreHistory, before.scoreHistory,
      'an invalid page must not append score history or overwrite snapshots');
  }

  listResponse = { result: [updatedDeal] };
  await scheduledSync();
  const recovered = sales.status();
  assert.equal(recovered.lastError, null);
  assert.ok(recovered.lastSyncAt);
  const updated = recovered.prospects.find(deal => deal.dealId === originalDeal.ID);
  assert.equal(updated.title, updatedDeal.TITLE, 'a fully valid page still updates the deal');
  assert.equal(updated.amount, 1000000);
});

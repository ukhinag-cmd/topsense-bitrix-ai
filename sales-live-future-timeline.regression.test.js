'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('future-dated live CRM timeline cannot freeze deals or suppress Sales risk', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
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
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const recent = new Date(now - 60000).toISOString();
  const after = new Date(now + 2000).toISOString();
  const future = new Date(now + 365 * 86400000).toISOString();
  const planned = new Date(now + 86400000).toISOString();
  const id = '9913081';
  const base = {
    ID: id, TITLE: 'Trusted Bitrix deal', ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '500000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 3 * 86400000).toISOString(),
    DATE_MODIFY: recent, LAST_ACTIVITY_TIME: recent,
  };
  let dealResponse = base;
  let listResponse = { result: [] };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'NEW', NAME: 'New', SEMANTICS: 'P' }],
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: dealResponse }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResponse };
    }
    throw new Error('Unexpected mocked Bitrix call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let state = sales.status();
  assert.equal(state.counts.open, 1);
  const trusted = state.attention.find(row => row.dealId === id);
  assert.ok(trusted);
  assert.equal(trusted.sourceUpdatedAt, recent);

  // Each timestamp is a past observation, not a future appointment. A bad
  // response must not change the stage, scores or authoritative CRM version.
  for (const field of ['DATE_MODIFY', 'DATE_CREATE', 'LAST_ACTIVITY_TIME']) {
    dealResponse = {
      ...base, TITLE: 'Poisoned ' + field,
      STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S',
      DATE_MODIFY: after, [field]: future,
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', field + ' must fail closed');
    assert.equal(state.counts.open, 1, field + ' must not close the deal');
    assert.equal(state.counts.won, 0);
    const unchanged = state.attention.find(row => row.dealId === id);
    assert.equal(unchanged.title, base.TITLE);
    assert.equal(unchanged.sourceUpdatedAt, recent);
    assert.equal(unchanged.scoreHistory.length, trusted.scoreHistory.length);
  }

  listResponse = { result: [{ ...base, DATE_MODIFY: future }] };
  await scheduledSync();
  state = sales.status();
  assert.equal(state.lastError?.source, 'sales-sync',
    'a sync with a future CRM version must not be considered healthy');
  assert.equal(state.lastSyncAt, null);
  assert.equal(state.counts.open, 1);

  // Planned future Next Step is legitimate and must not be rejected.
  dealResponse = {
    ...base, TITLE: 'Verified updated Bitrix deal',
    DATE_MODIFY: after, ACTIVITY_TIME: planned,
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  state = sales.status();
  assert.equal(state.counts.open, 1);
  assert.equal(state.prospects.find(row => row.dealId === id)?.title, dealResponse.TITLE);
  assert.equal(state.prospects.find(row => row.dealId === id)?.nextActivityAt, planned);
  listResponse = { result: [] };
  await scheduledSync();
  state = sales.status();
  assert.ok(state.lastSyncAt, 'valid sync recovers');
  assert.equal(state.lastError, null);
});

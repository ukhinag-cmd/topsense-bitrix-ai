'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed live CRM timestamps fail closed without replacing trusted Sales risk/history', async t => {
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
  const old = new Date(now - 45 * 86400000).toISOString();
  const recent = new Date(now - 60000).toISOString();
  const newer = new Date(now + 2000).toISOString();
  const id = '9913091';
  const base = {
    ID: id,
    TITLE: 'Verified at-risk deal',
    ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: old,
    DATE_MODIFY: recent,
    LAST_ACTIVITY_TIME: old,
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
    throw new Error('Unexpected mocked request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let state = sales.status();
  const trusted = state.attention.find(item => item.dealId === id);
  assert.ok(trusted);
  assert.ok(trusted.riskScore >= 60, 'stale contact and age must be counted as risk');
  assert.equal(trusted.sourceUpdatedAt, recent);

  // Invalid (rather than just far-future) source timestamps must not close
  // the deal, erase its stale-contact risk, or poison score history.
  for (const field of ['DATE_MODIFY', 'DATE_CREATE', 'LAST_ACTIVITY_TIME']) {
    dealResponse = {
      ...base,
      TITLE: 'Corrupted ' + field,
      STAGE_ID: 'WON',
      STAGE_SEMANTIC_ID: 'S',
      DATE_MODIFY: newer,
      [field]: 'not-a-bitrix-timestamp',
    };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', field + ' must fail closed');
    assert.equal(state.counts.open, 1, field + ' must not close the deal');
    assert.equal(state.counts.won, 0);
    const unchanged = state.attention.find(item => item.dealId === id);
    assert.equal(unchanged.title, base.TITLE);
    assert.equal(unchanged.riskScore, trusted.riskScore);
    assert.equal(unchanged.sourceUpdatedAt, recent);
    assert.equal(unchanged.scoreHistory.length, trusted.scoreHistory.length);
  }

  listResponse = { result: [{ ...base, DATE_MODIFY: newer, LAST_ACTIVITY_TIME: 'invalid-contact' }] };
  await scheduledSync();
  state = sales.status();
  assert.equal(state.lastError?.source, 'sales-sync');
  assert.equal(state.lastSyncAt, null);
  assert.equal(state.counts.open, 1);

  // A valid later observation recovers event and sync health.
  dealResponse = { ...base, TITLE: 'Valid newer CRM state', DATE_MODIFY: newer };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  state = sales.status();
  assert.equal(state.lastError?.source, 'sales-sync', 'event success must not mask sync failure');
  assert.equal(state.attention.find(item => item.dealId === id)?.title, 'Valid newer CRM state');
  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt);
  assert.equal(sales.status().lastError, null);
});

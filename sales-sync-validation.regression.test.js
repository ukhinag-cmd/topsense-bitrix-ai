'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Bitrix list pages cannot mark Sales Dashboard sync as healthy', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync = null;
  let result = { result: null };
  let listCalls = 0;

  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) return { unref() {} };
    return originalSetInterval(fn, ms, ...args);
  };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      listCalls += 1;
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
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

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  for (const invalid of [
    { result: null },
    { result: [], next: '0' },
    { result: [], next: 'garbage' },
  ]) {
    result = invalid;
    await scheduledSync();
    const state = sales.status();
    assert.equal(state.lastSyncAt, null, 'malformed responses must not be recorded as successful syncs');
    assert.equal(state.lastError?.source, 'sales-sync');
  }

  result = { result: [] };
  await scheduledSync();
  const good = sales.status();
  assert.ok(good.lastSyncAt, 'valid empty list is a successful sync');
  assert.equal(good.lastError, null, 'a successful sync clears the previous sync error');
  assert.equal(listCalls, 4);
});

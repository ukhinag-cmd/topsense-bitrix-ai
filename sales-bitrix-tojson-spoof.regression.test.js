'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('read-only deal sync must not serialize an untrusted toJSON hook into a fabricated empty page', async t => {
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
  let forged = true;
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

  const deal = {
    ID: '943001', TITLE: 'Genuine active deal', STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '', OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB', DATE_CREATE: new Date().toISOString(),
    DATE_MODIFY: new Date().toISOString(),
  };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json'))
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    if (path.endsWith('/crm.deal.list.json'))
      return { ok: true, status: 200, json: async () => forged
        ? { result: [deal], toJSON() { return { result: [], total: 0 }; } }
        : { result: [] } };
    throw new Error('Unexpected mocked Bitrix path ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof scheduledSync, 'function');

  // JSON.parse(JSON.stringify(...)) invokes a custom toJSON method. An
  // injected REST transport may then transform a real deal into an
  // apparently complete empty list. Only actual JSON shapes are trusted.
  await scheduledSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync',
    'non-JSON serialization hooks must be rejected instead of falsifying counts');
  assert.equal(sales.status().lastSyncAt, null,
    'forged empty CRM response cannot be declared synchronized');
  assert.equal(sales.status().counts.tracked, 0);

  forged = false;
  await scheduledSync();
  assert.equal(sales.status().lastError, null);
  assert.ok(sales.status().lastSyncAt,
    'ordinary JSON responses must still complete a read-only scan');
});

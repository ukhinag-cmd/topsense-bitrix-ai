'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('successful Bitrix read and acknowledged store retry clear only recovered Sales errors', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  const storeUrl = 'https://store.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-secret';

  const flushes = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      flushes.push(() => fn(...args));
      return { unref() {} };
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const id = '88009124';
  const now = Date.now();
  const deal = {
    ID: id,
    TITLE: 'Sales health recovery',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
  };
  let dealReads = 0;
  let storeWrites = 0;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (new URL(url).pathname.endsWith('/crm.deal.get.json')) {
      if (++dealReads === 1) throw new Error('temporary Bitrix read outage');
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (url === storeUrl) {
      assert.equal(JSON.parse(options.body).action, 'upsert');
      ++storeWrites;
      return {
        ok: true,
        status: 200,
        text: async () => storeWrites === 1
          ? JSON.stringify({ ok: false, error: 'temporary store outage' })
          : JSON.stringify({ ok: true }),
      };
    }
    throw new Error('Unexpected mock request: ' + url);
  };

  const sales = require('./sales');
  const event = { event: 'ONCRMDEALUPDATE', dealId: id };
  await sales.handleEvent(event);
  assert.equal(sales.status().lastError?.source, 'sales-event',
    'a failed CRM read must mark event processing unhealthy');
  await sales.handleEvent(event);
  assert.equal(dealReads, 2);
  assert.equal(sales.status().lastError, null,
    'a successful CRM read must clear the earlier event-processing error');

  assert.equal(flushes.length, 1, 'successful event should schedule history persistence');
  const settle = () => new Promise(resolve => originalSetTimeout(resolve, 0));
  flushes[0]();
  await settle();
  assert.equal(storeWrites, 1);
  assert.equal(sales.status().lastError?.source, 'sales-store',
    'a failed store write must mark persistence unhealthy');
  assert.equal(flushes.length, 2, 'history must be retried');

  flushes[1]();
  await settle();
  assert.equal(storeWrites, 2);
  assert.equal(flushes.length, 2, 'acknowledged retry must clear the queue');
  assert.equal(sales.status().lastError, null,
    'successful history persistence must clear the earlier store error');
});

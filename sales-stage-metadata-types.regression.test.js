'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed stage semantics and names cannot turn an open deal into a phantom win', async t => {
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
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 || ms === 5000 ? { unref() {} } : originalTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9914472';
  let stages = [{ STATUS_ID: 'C1:ACTIVE', NAME: 'В работе', SEMANTICS: 'P' }];
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: stages }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Trusted open deal', STAGE_ID: 'C1:ACTIVE',
        OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now).toISOString(),
        ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
      } }) };
    }
    throw new Error('Unexpected mocked Bitrix call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(sales.status().lastError, null);
  stages = [{ STATUS_ID: 'C1:ACTIVE', NAME: 'Closed', SEMANTICS: ['S'] }];
  await sales.start();
  assert.equal(sales.status().lastError?.source, 'stages',
    'array semantics must invalidate the entire metadata refresh');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let state = sales.status();
  let row = state.prospects.find(item => item.dealId === id) ||
    state.attention.find(item => item.dealId === id);
  assert.ok(row, 'deal stays visible');
  assert.equal(row.semantic, 'P', 'last known-good stage semantics stay in effect');
  assert.equal(row.open, true);
  assert.equal(row.stageName, 'В работе');
  assert.equal(state.counts.won, 0, 'malformed metadata must not invent a sale');

  // Display names are single-value text too; object metadata must not
  // replace a previously validated stage entry.
  stages = [{ STATUS_ID: 'C1:ACTIVE', NAME: { text: 'Closed' }, SEMANTICS: 'S' }];
  await sales.start();
  assert.equal(sales.status().lastError?.source, 'stages');
  state = sales.status();
  row = state.prospects.find(item => item.dealId === id) ||
    state.attention.find(item => item.dealId === id);
  assert.equal(row.semantic, 'P');
  assert.equal(row.stageName, 'В работе');
  assert.equal(state.counts.won, 0);

  stages = [{ STATUS_ID: 'C1:ACTIVE', NAME: 'В работе обновлено', SEMANTICS: 'P' }];
  await sales.start();
  assert.equal(sales.status().lastError, null, 'valid metadata recovers stage health');
});

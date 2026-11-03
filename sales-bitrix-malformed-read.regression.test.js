'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Bitrix reads cannot silently hide an event failure or erase known stage semantics', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = '';
  process.env.GOOGLE_SHEET_STORE_SECRET = '';

  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500 || ms === 5000) return { fn: () => fn(...args), ms };
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) return { fn, ms };
    return originalSetInterval(fn, ms, ...args);
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

  const now = Date.now();
  const deal = id => ({
    ID: id,
    TITLE: 'Stage fallback ' + id,
    STAGE_ID: 'C1:NEW',
    // Some CRM payloads omit STAGE_SEMANTIC_ID: rely on the cached status list.
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: new Date(now).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  });

  let stageReads = 0;
  let firstDealReads = 0;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return {
        ok: true,
        status: 200,
        json: async () => stageReads === 1
          ? { result: [{ STATUS_ID: 'C1:NEW', NAME: 'Новая', SEMANTICS: 'P' }] }
          : { result: { unexpectedly: 'not an array' } },
      };
    }
    if (url.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      if (id === '930501' && ++firstDealReads === 1) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: deal(id) }) };
    }
    throw new Error('Unexpected read-only URL ' + url);
  };

  const sales = require('./sales');
  await sales.start(); // cache known stage metadata, without starting real timers

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '930501' });
  assert.equal(sales.status().lastError?.source, 'sales-event',
    'HTTP 200 without a Bitrix result must be reported as an event failure');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '930501' });
  assert.equal(sales.status().lastError, null,
    'a valid CRM read can recover the transient event failure');

  await sales.start(); // malformed stage response must not clear the old metadata
  assert.equal(sales.status().lastError?.source, 'stages',
    'malformed stage metadata must surface as a health error');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '930502' });
  const row = sales.status().prospects.find(x => x.dealId === '930502');
  assert.ok(row, 'new deal should remain visible after the stage read fails');
  assert.equal(row.semantic, 'P', 'last valid stage semantics must be preserved');
  assert.equal(row.stageSemanticKnown, true);
  assert.equal(row.stageName, 'Новая');
  assert.equal(sales.status().lastError?.source, 'stages',
    'a successful event must not hide an unrelated stage metadata error');
});

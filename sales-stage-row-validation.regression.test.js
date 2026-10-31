'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('partially malformed stage metadata cannot atomically replace the known-good stage cache', async t => {
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

  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 || ms === 5000 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
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

  let stageReads = 0;
  const now = Date.now();
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      const result = stageReads === 1
        ? [{ STATUS_ID: 'C1:NEW', NAME: 'Новая', SEMANTICS: 'P' }]
        : [
            { STATUS_ID: 'C1:NEW', NAME: 'Новая', SEMANTICS: 'F' },
            // A single malformed row must invalidate the entire replacement.
            { NAME: 'Broken row with no STATUS_ID', SEMANTICS: 'S' },
          ];
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return {
        ok: true, status: 200,
        json: async () => ({ result: {
          ID: '941004',
          TITLE: 'Preserve stage semantics',
          STAGE_ID: 'C1:NEW',
          OPPORTUNITY: '250000',
          CURRENCY_ID: 'RUB',
          DATE_CREATE: new Date(now - 86400000).toISOString(),
          DATE_MODIFY: new Date(now).toISOString(),
          LAST_ACTIVITY_TIME: new Date(now).toISOString(),
          ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
          UF_CRM_AI_CLIENT_TYPE: 'dealer',
          UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
        } }),
      };
    }
    throw new Error('Unexpected Bitrix call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.start();
  assert.equal(stageReads, 2);
  assert.equal(sales.status().lastError?.source, 'stages',
    'malformed stage-row ID must surface as a stage health error');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '941004' });
  const row = sales.status().prospects.find(x => x.dealId === '941004');
  assert.ok(row, 'open deal remains visible');
  assert.equal(row.semantic, 'P', 'earlier valid stage semantics must not be overwritten');
  assert.equal(row.stageName, 'Новая');
  assert.equal(sales.status().counts.won, 0, 'malformed stage list must not produce a phantom win');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage metadata recovery refreshes the visible name without inventing a CRM version or score change', async t => {
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

  let triggerSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      triggerSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const dealId = '9980162';
  const now = Date.now();
  const version = new Date(now - 120000).toISOString();
  const deal = {
    ID: dealId,
    TITLE: 'Stage name refresh',
    STAGE_ID: 'C2:WORK',
    STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };

  let stageReads = 0;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({
        result: stageReads === 1 ? { temporarily: 'invalid' } :
          [{ STATUS_ID: 'C2:WORK', NAME: 'Проверенная стадия', SEMANTICS: 'P' }],
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(stageReads, 1);
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId });
  const before = sales.status().prospects.find(row => row.dealId === dealId);
  assert.ok(before, 'deal must be shown on the prospect dashboard');
  assert.equal(before.stageName, 'C2:WORK', 'stage ID is the fallback while metadata is unavailable');
  assert.equal(before.semantic, 'P', 'CRM already provides the stage semantic');
  const beforeHistory = before.scoreHistory.length;

  assert.equal(typeof triggerSync, 'function');
  await triggerSync();
  const after = sales.status().prospects.find(row => row.dealId === dealId);
  assert.equal(stageReads, 2, 'subsequent read-only sync retries stage metadata');
  assert.ok(after);
  assert.equal(after.stageName, 'Проверенная стадия',
    'verified stage name must become visible even when the scores stay unchanged');
  assert.equal(after.prospectScore, before.prospectScore);
  assert.equal(after.riskScore, before.riskScore);
  assert.equal(after.sourceUpdatedAt, version, 'a metadata refresh is not a new CRM version');
  assert.equal(after.scoreHistory.length, beforeHistory, 'a label-only correction is not a score event');
});

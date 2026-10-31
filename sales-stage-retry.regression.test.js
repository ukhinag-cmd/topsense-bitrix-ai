'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales retries a failed read-only stage lookup during sync and repairs cached scoring', async t => {
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
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
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

  const id = '9980142';
  const now = Date.now();
  const sourceVersion = new Date(now - 60000).toISOString();
  const deal = {
    ID: id, TITLE: 'Stage lookup recovery', STAGE_ID: 'C1:ACTIVE',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: sourceVersion,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    // No STAGE_SEMANTIC_ID: category-stage lookup is authoritative.
  };
  let stageReads = 0;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return {
        ok: true, status: 200,
        json: async () => ({
          result: stageReads === 1 ? { malformed: 'temporary response' } :
            [{ STATUS_ID: 'C1:ACTIVE', NAME: 'В работе', SEMANTICS: 'P' }],
        }),
      };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    throw new Error('Unexpected mocked Bitrix read: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(stageReads, 1);
  assert.equal(sales.status().lastError?.source, 'stages');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const initial = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(initial);
  assert.equal(initial.stageSemanticKnown, false);
  assert.equal(initial.semantic, '');
  assert.equal(initial.sourceUpdatedAt, sourceVersion);

  assert.equal(typeof scheduledSync, 'function');
  await scheduledSync();
  const recovered = sales.status();
  const row = recovered.prospects.find(x => x.dealId === id);
  assert.equal(stageReads, 2, 'regular read-only sync must retry the failed stage lookup');
  assert.equal(recovered.lastError, null, 'successful stage read recovers health');
  assert.ok(recovered.lastSyncAt);
  assert.equal(row.semantic, 'P', 'previously unknown stage should be rescored from verified metadata');
  assert.equal(row.stageSemanticKnown, true);
  assert.equal(row.stageName, 'В работе');
  assert.ok(row.prospectScore > initial.prospectScore);
  assert.ok(row.riskScore < initial.riskScore);
  assert.equal(row.sourceUpdatedAt, sourceVersion, 'stage recovery must not forge a CRM update');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage metadata semantics refreshes inferred outcomes without overriding CRM-provided semantics', async t => {
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

  // Suppress all real timers: these tests must not contact Bitrix or Render.
  global.setTimeout = (fn, delay, ...args) =>
    delay === 5000 || delay === 2500 ? { unref() {} } : originalTimeout(fn, delay, ...args);
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : originalInterval(fn, delay, ...args);

  const now = Date.now();
  const modifiedAt = new Date(now - 60000).toISOString();
  const common = {
    TITLE: 'Stage semantics refresh',
    CATEGORY_ID: '0', STAGE_ID: 'C1:ACTIVE',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const inferredId = '9989123';
  const directId = '9989124';
  const deals = {
    [inferredId]: { ...common, ID: inferredId },
    [directId]: { ...common, ID: directId, STAGE_SEMANTIC_ID: 'P' },
  };

  let stageReads = 0;
  global.fetch = async (url, options) => {
    assert.equal(options?.method, 'POST', 'only read-only REST calls through existing POST transport');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({
        result: [{
          ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'C1:ACTIVE', NAME: 'В работе',
          SEMANTICS: stageReads === 1 ? 'P' : 'S',
        }],
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      return { ok: true, status: 200, json: async () => ({ result: deals[id] }) };
    }
    throw new Error('Unexpected REST request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: inferredId });
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: directId });

  const initial = sales.status();
  const inferredBefore = initial.prospects.find(row => row.dealId === inferredId);
  assert.ok(inferredBefore, 'inferred process stage initially appears as an open prospect');
  assert.equal(inferredBefore.semantic, 'P');
  assert.ok(initial.prospects.some(row => row.dealId === directId));

  // The verified stage dictionary can be corrected without modifying either
  // CRM deal: no webhook or DATE_MODIFY bump should be required for recovery.
  await sales.start();
  assert.equal(stageReads, 2, 'read-only stage dictionary reloaded');

  const refreshed = sales.status();
  const closedInferred = refreshed.wins.find(row => row.dealId === inferredId);
  assert.ok(closedInferred, 'metadata-inferred outcome must be recomputed as won');
  assert.equal(closedInferred.semantic, 'S');
  assert.equal(closedInferred.open, false);
  assert.equal(closedInferred.sourceUpdatedAt, modifiedAt);
  assert.equal(closedInferred.scoreHistory.length, inferredBefore.scoreHistory.length + 1,
    'a changed score should be captured without fabricating a CRM source version');

  const explicit = refreshed.prospects.find(row => row.dealId === directId);
  assert.ok(explicit, 'an explicit CRM-provided process semantic must not be overwritten by stage cache');
  assert.equal(explicit.semantic, 'P');
  assert.equal(explicit.sourceUpdatedAt, modifiedAt);
});

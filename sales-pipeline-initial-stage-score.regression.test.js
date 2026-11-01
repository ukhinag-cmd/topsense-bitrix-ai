'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a custom Bitrix pipeline C7:NEW stage does not earn progression Prospect Score', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);

  const now = Date.now();
  const deals = new Map([
    ['9988911', { category: '0', stage: 'NEW' }],
    ['9988912', { category: '7', stage: 'C7:NEW' }],
    ['9988913', { category: '7', stage: 'C7:PROPOSAL' }],
  ]);
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(options.body || '{}');
    calls.push(path);
    if (path.endsWith('/crm.status.list.json')) {
      assert.equal(body.filter?.ENTITY_ID, 'DEAL_STAGE_7');
      return { ok: true, status: 200, json: async () => ({ result: [
        { STATUS_ID: 'C7:NEW', NAME: 'New in custom pipeline', SEMANTICS: 'P' },
        { STATUS_ID: 'C7:PROPOSAL', NAME: 'Proposal in custom pipeline', SEMANTICS: 'P' },
      ] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(body.ID);
      const item = deals.get(id);
      assert.ok(item, 'only the expected mock deals may be read');
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Pipeline stage progression',
        CATEGORY_ID: item.category, STAGE_ID: item.stage, STAGE_SEMANTIC_ID: 'P',
        ASSIGNED_BY_ID: '', OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now - 60000).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now - 1800000).toISOString(),
      } }) };
    }
    throw new Error('Unexpected Bitrix method: ' + path);
  };

  const sales = require('./sales');
  for (const id of deals.keys()) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  }
  const rows = new Map(sales.status().attention.map(row => [row.dealId, row]));
  const mainNew = rows.get('9988911');
  const customNew = rows.get('9988912');
  const customAdvanced = rows.get('9988913');
  assert.ok(mainNew && customNew && customAdvanced, 'deals missing Next Step require attention');
  assert.equal(mainNew.prospectScore, 20, 'default pipeline NEW is not progressed');
  assert.equal(customNew.prospectScore, 20,
    'C7:NEW has the same initial-stage score; category prefix is not progress');
  assert.equal(customAdvanced.prospectScore, 25,
    'an actual later stage earns the five progression points');
  assert.equal(customNew.stageName, 'New in custom pipeline');
  assert.equal(customNew.stageSemanticKnown, true);
  assert.ok(calls.every(path => /\/(?:crm\.deal\.get|crm\.status\.list)\.json$/.test(path)),
    'mock-only regression must use read-only CRM methods');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Bitrix short SEMANTICS:null without EXTRA identifies a working deal stage', async t => {
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
  const id = '9989091';
  const responses = [];
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      // Official Bitrix24 semantics: a present null short marker is
      // "in progress", even when optional EXTRA is missing.
      const result = [{ STATUS_ID: 'NEW', NAME: 'В работе',
        SEMANTICS: null, ENTITY_ID: 'DEAL_STAGE' }];
      responses.push('stages');
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      assert.equal(String(JSON.parse(options.body).ID), id);
      responses.push('deal');
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Short-null semantics', STAGE_ID: 'NEW',
        CATEGORY_ID: '0', ASSIGNED_BY_ID: '0',
        OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now - 60000).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
        ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
        UF_CRM_AI_CLIENT_TYPE: 'dealer',
        UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
      } }) };
    }
    throw new Error('Unexpected mocked Bitrix read: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const status = sales.status();
  const deal = status.prospects.find(row => row.dealId === id);
  assert.ok(deal, 'the open deal belongs to the prospect queue');
  assert.equal(deal.semantic, 'P', 'null short semantics must map to process');
  assert.equal(deal.stageSemanticKnown, true);
  assert.equal(deal.open, true);
  assert.equal(deal.stageName, 'В работе');
  assert.equal(status.counts.open, 1);
  assert.equal(status.counts.won, 0);
  assert.deepEqual(responses, ['stages', 'deal'], 'only mocked read-only CRM methods may be called');
});

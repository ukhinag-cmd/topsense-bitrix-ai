'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

test('application-only Bitrix pipeline move event authenticates without trusting event stage metadata', async t => {
  const token = 'pipeline-move-mock-shared-token';
  const dealId = '99770112';
  const fixture = {
    event: 'onCrmDealMoveToCategory',
    data: { FIELDS: {
      ID: dealId,
      CATEGORY_ID: '777', // Event metadata must never override crm.deal.get.
      STAGE_ID: 'C777:WON',
    } },
    auth: { application_token: token },
  };
  const evt = parseBitrixEvent(Buffer.from(JSON.stringify(fixture)), 'application/json', token);
  assert.deepEqual(evt, {
    event: 'ONCRMDEALMOVETOCATEGORY', dealId, activityId: null,
  }, 'a verified pipeline move must resolve its deal ID only');
  assert.equal(parseBitrixEvent(JSON.stringify(fixture), 'application/json', 'wrong-token'), null);
  assert.equal(parseBitrixEvent(JSON.stringify({ ...fixture, data: { FIELDS: { ID: ['99770112'] } } }), 'application/json', token), null);
  assert.deepEqual(parseBitrixEvent(new URLSearchParams({
    event: 'ONCRMDEALMOVETOCATEGORY', 'data[FIELDS][ID]': dealId,
    'data[FIELDS][CATEGORY_ID]': '999',
    'data[FIELDS][STAGE_ID]': 'C999:NEW',
    'auth[application_token]': token,
  }).toString(), 'application/x-www-form-urlencoded', token), evt);
  assert.equal(parseBitrixEvent(JSON.stringify({ ...fixture, event: 'onCrmDealDelete' }), 'application/json', token), null,
    'delete events must remain blocked until explicitly designed for read-only handling');

  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE','GOOGLE_SHEET_STORE_URL','GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now(), hour = 3600000, day = 86400000;
  const baseline = {
    ID: dealId, TITLE: 'Pipeline move fixture', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 20 * day).toISOString(),
    DATE_MODIFY: new Date(now - 3 * hour).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - hour).toISOString(),
    ACTIVITY_TIME: new Date(now + day).toISOString(),
  };
  // Only the verified read-only deal response, not the webhook-supplied
  // CATEGORY_ID/STAGE_ID, determines the resulting pipeline and outcome.
  const moved = {
    ...baseline, CATEGORY_ID: '7', STAGE_ID: 'C7:WON', STAGE_SEMANTIC_ID: 'S',
    DATE_MODIFY: new Date(now - hour).toISOString(),
  };
  let dealReads = 0;
  const methods = [];
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const method = new URL(String(input)).pathname.split('/').pop();
    methods.push(method);
    let result;
    if (method === 'crm.deal.get.json') {
      assert.equal(String(JSON.parse(options.body).ID), dealId);
      result = ++dealReads === 1 ? baseline : moved;
    } else if (method === 'crm.status.list.json') {
      assert.equal(JSON.parse(options.body).filter.ENTITY_ID, 'DEAL_STAGE_7');
      result = [{ STATUS_ID: 'C7:WON', NAME: 'Won in pipeline 7',
        SEMANTICS: 'S', ENTITY_ID: 'DEAL_STAGE_7' }];
    } else {
      throw new Error('Unexpected or write-capable Bitrix method: ' + method);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALADD', dealId });
  assert.ok(sales.status().prospects.some(row => row.dealId === dealId));

  const result = await sales.handleEvent(evt, { propagateError: true });
  assert.equal(result.categoryId, '7');
  assert.equal(result.stageId, 'C7:WON');
  assert.equal(result.stageName, 'Won in pipeline 7');
  assert.equal(result.semantic, 'S');
  assert.equal(result.open, false);
  assert.equal(result.scoreHistory.length, 2, 'move is a distinct audit observation');
  assert.equal(result.scoreHistory[1].categoryId, '7');
  assert.ok(sales.status().wins.some(row => row.dealId === dealId));
  assert.equal(sales.status().prospects.some(row => row.dealId === dealId), false);
  assert.deepEqual(methods, [
    'crm.deal.get.json', 'crm.deal.get.json', 'crm.status.list.json',
  ], 'pipeline move only reads the verified deal and stage dictionary');
});

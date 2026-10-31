'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage semantics and names are scoped to the Bitrix deal pipeline, and failed lookups retry', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(oldEnv)) {
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

  const calls = [];
  let failCategory7 = true;
  const now = Date.now();
  const deals = new Map([
    ['9988831', { category: '0', stage: 'NEW' }],
    ['9988832', { category: '7', stage: 'NEW' }],
    ['9988833', { category: '7', stage: 'WON' }],
  ]);
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(options.body || '{}');
    if (path.endsWith('/crm.status.list.json')) {
      const entity = body.filter?.ENTITY_ID;
      calls.push(entity);
      if (entity === 'DEAL_STAGE') {
        return { ok: true, status: 200, json: async () => ({
          result: [{ STATUS_ID: 'NEW', NAME: 'Основная: закрыта', SEMANTICS: 'S' }],
        }) };
      }
      if (entity === 'DEAL_STAGE_7') {
        if (failCategory7) {
          return { ok: true, status: 200, json: async () => ({
            result: [{ STATUS_ID: 'NEW', NAME: 'Повреждено', EXTRA: { SEMANTICS: ['success'] } }],
          }) };
        }
        return { ok: true, status: 200, json: async () => ({
          result: [
            { STATUS_ID: 'NEW', NAME: 'Воронка 7: в работе', SEMANTICS: null, EXTRA: { SEMANTICS: 'process' } },
            { STATUS_ID: 'WON', NAME: 'Воронка 7: успех', SEMANTICS: null, EXTRA: { SEMANTICS: 'success' } },
          ],
        }) };
      }
      throw new Error('Unexpected status entity: ' + entity);
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(body.ID);
      const item = deals.get(id);
      assert.ok(item, 'only mock deal IDs may be fetched');
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id,
        TITLE: 'Pipeline deal ' + id,
        CATEGORY_ID: item.category,
        STAGE_ID: item.stage,
        ASSIGNED_BY_ID: '',
        OPPORTUNITY: '250000',
        UF_CRM_AI_CLIENT_TYPE: 'dealer',
        UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
        CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now - 60000).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
        ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
      } }) };
    }
    throw new Error('Unexpected mock Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9988831' });
  assert.equal(sales.status().wins.find(x => x.dealId === '9988831')?.stageName, 'Основная: закрыта');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9988832' });
  assert.ok(calls.includes('DEAL_STAGE_7'), 'category 7 must use its own stage directory');
  let prospect = sales.status().prospects.find(x => x.dealId === '9988832');
  assert.ok(prospect, 'unknown semantics must not inherit the main pipeline win');
  assert.equal(prospect.stageSemanticKnown, false);
  assert.equal(sales.status().lastError?.source, 'stages');

  failCategory7 = false;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9988832' });
  prospect = sales.status().prospects.find(x => x.dealId === '9988832');
  assert.ok(prospect);
  assert.equal(prospect.stageName, 'Воронка 7: в работе');
  assert.equal(prospect.semantic, 'P');
  assert.equal(prospect.stageSemanticKnown, true);
  assert.notEqual(sales.status().lastError?.source, 'stages');

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9988833' });
  const win = sales.status().wins.find(x => x.dealId === '9988833');
  assert.equal(win?.stageName, 'Воронка 7: успех');
  assert.equal(win?.semantic, 'S');
  assert.equal(sales.status().wins.find(x => x.dealId === '9988831')?.stageName, 'Основная: закрыта');
  assert.equal(calls.filter(x => x === 'DEAL_STAGE_7').length, 2,
    'successfully loaded pipeline stages should be cached');
});

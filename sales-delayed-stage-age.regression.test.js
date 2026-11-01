'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a delayed Bitrix stage transition retains its CRM version as stage-entry age', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
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

  const now = Date.now();
  const day = 86400000;
  const id = '9988892';
  let stage = 'NEW';
  let modified = new Date(now - 45 * day).toISOString();
  const reads = [];
  global.fetch = async (input, options = {}) => {
    const method = new URL(String(input)).pathname;
    reads.push(method);
    assert.ok(method.endsWith('/crm.deal.get.json'), 'only read-only deal gets are allowed');
    assert.equal(String(JSON.parse(options.body || '{}').ID), id);
    return { ok: true, status: 200, json: async () => ({ result: {
      ID: id, TITLE: 'Delayed stage update', CATEGORY_ID: '0',
      STAGE_ID: stage, STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '',
      OPPORTUNITY: '1000000', CURRENCY_ID: 'RUB',
      DATE_CREATE: new Date(now - 100 * day).toISOString(),
      DATE_MODIFY: modified,
      LAST_ACTIVITY_TIME: new Date(now - day).toISOString(),
      ACTIVITY_TIME: new Date(now + 2 * day).toISOString(),
      UF_CRM_AI_CLIENT_TYPE: 'dealer',
      UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    } }) };
  };

  const sales = require('./sales');
  const getDeal = () => sales.status().prospects.find(row => row.dealId === id);

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = getDeal();
  assert.ok(first);
  assert.equal(first.riskScore, 51, 'older stage and deal age are accounted for');
  assert.equal(first.stageEnteredAt, modified);

  // The service was offline while Bitrix moved the deal to a new stage
  // fourteen days ago. Discovering that transition now must not erase
  // fourteen days of stage ageing or hide overdue pipeline risk.
  stage = 'IN_PROGRESS';
  modified = new Date(now - 14 * day).toISOString();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const updated = getDeal();
  assert.ok(updated);
  assert.equal(updated.stageId, 'IN_PROGRESS');
  assert.equal(updated.stageEnteredAt, modified,
    'DATE_MODIFY is the latest authoritative bound for the new stage entry');
  assert.equal(updated.riskScore, 41,
    'fourteen days in the newly observed stage add fifteen risk points');
  assert.deepEqual(updated.scoreHistory.map(x => x.stageId), ['NEW', 'IN_PROGRESS']);
  assert.equal(reads.length, 2, 'no extra CRM reads or writes were needed');
});

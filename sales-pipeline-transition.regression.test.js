'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('moving a deal between pipelines resets stage age and records a same-ID stage transition', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
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
  const day = 86400000;
  const id = '9988891';
  let category = '0';
  let version = new Date(now - 40 * day).toISOString();
  const reads = [];
  global.fetch = async (input, options = {}) => {
    const method = new URL(String(input)).pathname;
    const body = JSON.parse(options.body || '{}');
    reads.push(method);
    if (method.endsWith('/crm.status.list.json')) {
      const entity = body.filter?.ENTITY_ID;
      assert.ok(['DEAL_STAGE_7', 'DEAL_STAGE_8'].includes(entity));
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'NEW', NAME: entity + ': new', SEMANTICS: 'P' }],
      }) };
    }
    if (method.endsWith('/crm.deal.get.json')) {
      assert.equal(String(body.ID), id);
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Pipeline transition', CATEGORY_ID: category,
        STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '',
        OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 90 * day).toISOString(),
        DATE_MODIFY: version,
        LAST_ACTIVITY_TIME: new Date(now - day).toISOString(),
        ACTIVITY_TIME: new Date(now + day).toISOString(),
        UF_CRM_AI_CLIENT_TYPE: 'dealer',
        UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
      } }) };
    }
    throw new Error('Unexpected Bitrix method: ' + method);
  };

  const sales = require('./sales');
  const getDeal = () => sales.status().prospects.find(row => row.dealId === id);
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const initial = getDeal();
  assert.ok(initial);
  assert.equal(initial.stageId, 'NEW');
  assert.equal(initial.categoryId, '0');
  assert.equal(initial.riskScore, 43, 'old stage adds 25 risk points');
  assert.equal(initial.scoreHistory.length, 1);

  // A new Bitrix pipeline can reuse the same stage ID, but entering that
  // pipeline is still a stage transition and must reset stage age.
  category = '7';
  version = new Date(now - 2 * 60000).toISOString();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const moved = getDeal();
  assert.ok(moved);
  assert.equal(moved.stageId, 'NEW');
  assert.equal(moved.categoryId, '7');
  assert.equal(moved.riskScore, 18, 'pipeline movement must remove stale stage-age risk');
  assert.ok(Date.parse(moved.stageEnteredAt) >= now - 120000,
    'stage entered time must reflect the pipeline transition');
  assert.deepEqual(moved.scoreHistory.map(entry => entry.categoryId), ['0', '7'],
    'score history must identify both pipelines');

  // Moving again while stage age and scores remain unchanged is still a
  // meaningful transition that must be recorded in history.
  category = '8';
  version = new Date(now - 60000).toISOString();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const movedAgain = getDeal();
  assert.ok(movedAgain);
  assert.equal(movedAgain.riskScore, 18);
  assert.deepEqual(movedAgain.scoreHistory.map(entry => entry.categoryId), ['0', '7', '8']);
  assert.ok(reads.every(path => path.endsWith('/crm.deal.get.json') ||
    path.endsWith('/crm.status.list.json')), 'no mutating Bitrix REST methods');
});

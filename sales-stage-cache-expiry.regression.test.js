'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('successful stage caches expire and safely refresh all observed Bitrix pipelines', async t => {
  const realFetch = global.fetch;
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  const realDateNow = Date.now;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = realFetch;
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
    Date.now = realDateNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  const current = realDateNow();
  let elapsed = 0;
  Date.now = () => current + elapsed;

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return realTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : realInterval(fn, ms, ...args);

  const modifiedAt = new Date(current - 60000).toISOString();
  const common = {
    TITLE: 'Stage cache refresh',
    STAGE_ID: 'A',
    ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(current - 86400000).toISOString(),
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_TIME: new Date(current - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(current + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const deals = {
    '9989341': { ...common, ID: '9989341', CATEGORY_ID: '0' },
    '9989342': { ...common, ID: '9989342', CATEGORY_ID: '7' },
  };
  const dictionaries = {
    DEAL_STAGE: [{ STATUS_ID: 'A', NAME: 'Основная P', SEMANTICS: 'P' }],
    DEAL_STAGE_7: [{ STATUS_ID: 'A', NAME: 'Воронка 7 P', SEMANTICS: 'P' }],
  };
  const stageReads = [];
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method, 'POST', 'only mocked read-only Bitrix REST transport');
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(options.body || '{}');
    if (path.endsWith('/crm.status.list.json')) {
      const entity = body.filter?.ENTITY_ID;
      stageReads.push(entity);
      assert.ok(Object.hasOwn(dictionaries, entity), 'known pipeline requested');
      return { ok: true, status: 200, json: async () => ({ result: dictionaries[entity] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const deal = deals[String(body.ID)];
      assert.ok(deal);
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    }
    throw new Error('Unexpected REST request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9989341' });
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9989342' });
  const first = sales.status();
  assert.equal(first.prospects.find(x => x.dealId === '9989342')?.semantic, 'P');
  assert.equal(first.prospects.find(x => x.dealId === '9989341')?.stageName, 'Основная P');
  assert.deepEqual(stageReads, ['DEAL_STAGE', 'DEAL_STAGE_7']);

  // Admin stage changes are not webhooks for individual CRM deals. They must
  // be observed by scheduled read-only stage metadata polling, without a restart.
  dictionaries.DEAL_STAGE = [{ STATUS_ID: 'A', NAME: 'Основная обновлена', SEMANTICS: 'P' }];
  dictionaries.DEAL_STAGE_7 = [{ STATUS_ID: 'A', NAME: 'Воронка 7 закрыта', SEMANTICS: 'S' }];
  elapsed = 29 * 60000;
  await scheduledSync();
  assert.equal(stageReads.length, 2, 'valid caches are reused before expiry');
  assert.equal(sales.status().prospects.find(x => x.dealId === '9989342')?.semantic, 'P');

  elapsed = 31 * 60000;
  await scheduledSync();
  assert.deepEqual(stageReads, ['DEAL_STAGE', 'DEAL_STAGE_7', 'DEAL_STAGE', 'DEAL_STAGE_7'],
    'every loaded pipeline must be refreshed after TTL');
  const refreshed = sales.status();
  const won = refreshed.wins.find(x => x.dealId === '9989342');
  assert.ok(won, 'stage semantics correction closes an inferred open deal');
  assert.equal(won.stageName, 'Воронка 7 закрыта');
  assert.equal(won.sourceUpdatedAt, modifiedAt, 'no fake Bitrix modification version');
  assert.equal(won.scoreHistory.length, first.prospects.find(x => x.dealId === '9989342').scoreHistory.length + 1);
  const main = refreshed.prospects.find(x => x.dealId === '9989341');
  assert.equal(main.stageName, 'Основная обновлена', 'main pipeline metadata also refreshes');
  assert.equal(main.sourceUpdatedAt, modifiedAt);

  // A malformed refresh must retain the last verified metadata, surface an
  // error, and retry on the next scheduled scan instead of waiting another TTL.
  dictionaries.DEAL_STAGE_7 = [{ STATUS_ID: 'A', NAME: 'Повреждено', SEMANTICS: ['P'] }];
  elapsed = 62 * 60000;
  await scheduledSync();
  let afterFailure = sales.status();
  assert.equal(afterFailure.lastError?.source, 'stages');
  assert.equal(afterFailure.wins.find(x => x.dealId === '9989342')?.stageName, 'Воронка 7 закрыта');

  dictionaries.DEAL_STAGE_7 = [{ STATUS_ID: 'A', NAME: 'Воронка 7 восстановлена', SEMANTICS: 'S' }];
  elapsed = 63 * 60000;
  await scheduledSync();
  const recovered = sales.status();
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.wins.find(x => x.dealId === '9989342')?.stageName, 'Воронка 7 восстановлена');
  assert.equal(recovered.wins.find(x => x.dealId === '9989342')?.scoreHistory.length, won.scoreHistory.length,
    'label-only recovery must not invent score history');
  assert.equal(stageReads.filter(entity => entity === 'DEAL_STAGE_7').length, 4);
});

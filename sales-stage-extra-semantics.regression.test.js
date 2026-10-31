'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Bitrix deal stage EXTRA.SEMANTICS determines open, won and lost status without deal-level semantics', async t => {
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

  // Bitrix24 crm.status.list documents EXTRA.SEMANTICS as the readable stage
  // state even when the top-level SEMANTICS is null.
  let stageRows = [
    { STATUS_ID: 'NEW', NAME: 'В работе', SEMANTICS: null, EXTRA: { SEMANTICS: 'process' } },
    { STATUS_ID: 'WON', NAME: 'Успешно', SEMANTICS: null, EXTRA: { SEMANTICS: 'success' } },
    { STATUS_ID: 'LOST', NAME: 'Закрыто', SEMANTICS: null, EXTRA: { SEMANTICS: 'failure' } },
  ];
  const now = Date.now();
  const stages = new Map([
    ['9988081', 'NEW'],
    ['9988082', 'WON'],
    ['9988083', 'LOST'],
  ]);
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: stageRows }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      assert.ok(stages.has(id), 'only mocked Bitrix deals may be read');
      return {
        ok: true, status: 200,
        json: async () => ({ result: {
          ID: id, TITLE: 'EXTRA stage ' + id,
          STAGE_ID: stages.get(id), CATEGORY_ID: '0', ASSIGNED_BY_ID: '',
          OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
          DATE_CREATE: new Date(now - 86400000).toISOString(),
          DATE_MODIFY: new Date(now - 60000).toISOString(),
          LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
          ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
          UF_CRM_AI_CLIENT_TYPE: 'dealer',
          UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
          // STAGE_SEMANTIC_ID is absent: the validated status dictionary decides.
        } }),
      };
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  for (const id of stages.keys()) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  }
  const result = sales.status();
  const active = result.prospects.find(row => row.dealId === '9988081');
  assert.ok(active, 'process semantics must make the deal an open prospect');
  assert.equal(active.semantic, 'P');
  assert.equal(active.stageSemanticKnown, true);
  assert.equal(active.stageName, 'В работе');

  const won = result.wins.find(row => row.dealId === '9988082');
  assert.ok(won, 'EXTRA success must classify a deal as won');
  assert.equal(won.semantic, 'S');
  assert.equal(won.open, false);
  assert.equal(won.stageName, 'Успешно');
  assert.equal(result.counts.tracked, 3);
  assert.equal(result.counts.open, 1, 'EXTRA failure must not remain an open deal');
  assert.equal(result.counts.won, 1);

  // An invalid nested semantics value must not spoof a victory by coercion,
  // or erase the previously verified stage dictionary.
  stageRows = [
    { STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: null, EXTRA: { SEMANTICS: ['success'] } },
  ];
  await sales.start();
  assert.equal(sales.status().lastError?.source, 'stages');
  const protectedState = sales.status();
  assert.equal(protectedState.counts.open, 1);
  assert.equal(protectedState.counts.won, 1);
  assert.equal(protectedState.wins[0].stageName, 'Успешно');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('same-version activity recovery after a stage-cache correction does not fabricate a won alert', async t => {
  const saved = {
    fetch: global.fetch, setTimeout: global.setTimeout,
    setInterval: global.setInterval, now: Date.now,
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = saved.fetch;
    global.setTimeout = saved.setTimeout;
    global.setInterval = saved.setInterval;
    Date.now = saved.now;
    for (const key of ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // No live CRM, Sheet, Render, or email transport is invoked.
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  const now = saved.now();
  let elapsed = 0;
  Date.now = () => now + elapsed;
  let sync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      sync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return saved.setTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : saved.setInterval(fn, ms, ...args);

  const id = '99934618';
  const version = new Date(now - 60 * 60000).toISOString();
  const baseline = {
    ID: id, TITLE: 'Unchanged source deal', CATEGORY_ID: '0',
    STAGE_ID: 'C1:ACTIVE', STAGE_SEMANTIC_ID: '',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    ASSIGNED_BY_ID: '',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 2 * 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3 * 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const refreshed = {
    ...baseline,
    LAST_ACTIVITY_TIME: new Date(now - 10 * 60000).toISOString(),
  };
  let stageSemantic = 'P';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method, 'POST');
    const method = new URL(String(url)).pathname.split('/').pop();
    calls.push(method);
    let result;
    if (method === 'crm.status.list.json') {
      assert.equal(JSON.parse(options.body).filter.ENTITY_ID, 'DEAL_STAGE');
      result = [{ ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'C1:ACTIVE',
        NAME: 'Stage updated independently', SEMANTICS: stageSemantic }];
    } else if (method === 'crm.deal.get.json') {
      result = baseline;
    } else if (method === 'crm.deal.list.json') {
      return { ok: true, status: 200, json: async () => ({ result: [refreshed], total: 1 }) };
    } else {
      throw new Error('Unexpected mocked REST method: ' + method);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(first && first.semantic === 'P');
  assert.equal(first.alerts.some(a => a.type === 'success'), false);

  // The pipeline metadata changes, but Bitrix does not advance DATE_MODIFY.
  // Scheduled sync also discovers a newer LAST_ACTIVITY_TIME. That contact
  // observation is real, while a purported deal win is not.
  stageSemantic = 'S';
  elapsed = 31 * 60000;
  assert.equal(typeof sync, 'function');
  await sync();
  const state = sales.status();
  const won = state.wins.find(row => row.dealId === id);
  assert.ok(won, 'verified stage semantics should still correct the deal outcome');
  assert.equal(won.lastActivityAt, refreshed.LAST_ACTIVITY_TIME);
  assert.equal(won.sourceUpdatedAt, version, 'contact refresh must not invent a source deal version');
  assert.deepEqual(won.scoreHistory.map(x => x.semantic), ['P', 'S']);
  assert.equal(won.alerts.some(a => a.type === 'success'), false,
    'a stage-dictionary-only outcome correction is not a newly won CRM deal');
  assert.deepEqual([...new Set(calls)].sort(),
    ['crm.status.list.json', 'crm.deal.get.json', 'crm.deal.list.json'].sort());
});

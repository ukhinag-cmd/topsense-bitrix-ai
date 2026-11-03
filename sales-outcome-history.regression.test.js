'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('won/lost/won transitions stay in score history even when both scores are unchanged', async t => {
  const previousFetch = global.fetch;
  const previousTimeout = global.setTimeout;
  const previousInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = previousFetch;
    global.setTimeout = previousTimeout;
    global.setInterval = previousInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 5000 || ms === 2500 ? { unref() {} } : previousTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : previousInterval(fn, ms, ...args);

  const now = Date.now();
  const inferredId = '9989561';
  const explicitId = '9989562';
  let metadataSemantic = 'S';
  let directSemantic = 'S';
  let directVersion = new Date(now - 180000).toISOString();
  const originalVersion = new Date(now - 180000).toISOString();
  const common = {
    TITLE: 'Closed outcome transition', CATEGORY_ID: '0', STAGE_ID: 'C1:FINAL',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const requests = [];
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST', 'only mocked read-only Bitrix transport');
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{ STATUS_ID: 'C1:FINAL', NAME: 'Закрыта',
          SEMANTICS: metadataSemantic }],
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      assert.ok([inferredId, explicitId].includes(id));
      return { ok: true, status: 200, json: async () => ({ result: {
        ...common, ID: id,
        DATE_MODIFY: id === inferredId ? originalVersion : directVersion,
        STAGE_SEMANTIC_ID: id === inferredId ? '' : directSemantic,
      } }) };
    }
    throw new Error('Unexpected REST method: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: inferredId });
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: explicitId });
  let wins = sales.status().wins;
  assert.equal(wins.length, 2);
  assert.ok(wins.every(row => row.scoreHistory.length === 1));

  // Changing a verified stage dictionary must reclassify inferred outcomes
  // even when the CRM deal version stays unchanged. A separate direct field
  // update exercises the normal webhook path using newer CRM versions.
  metadataSemantic = 'F';
  directSemantic = 'F';
  directVersion = new Date(now - 120000).toISOString();
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: explicitId });
  const lost = sales.status();
  assert.equal(lost.counts.tracked, 2);
  assert.equal(lost.counts.won, 0);

  metadataSemantic = 'S';
  directSemantic = 'S';
  directVersion = new Date(now - 60000).toISOString();
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: explicitId });
  wins = sales.status().wins;
  assert.equal(wins.length, 2);
  for (const id of [inferredId, explicitId]) {
    const restored = wins.find(row => row.dealId === id);
    assert.ok(restored);
    assert.deepEqual(restored.scoreHistory.map(item => item.semantic), ['S', 'F', 'S'],
      'real outcome reversals must not disappear from history merely because scoring is equal');
    assert.equal(new Set(restored.scoreHistory.map(item => item.prospectScore)).size, 1);
    assert.equal(new Set(restored.scoreHistory.map(item => item.riskScore)).size, 1);
  }
  assert.equal(wins.find(row => row.dealId === inferredId).sourceUpdatedAt, originalVersion,
    'a metadata change must not invent a new Bitrix DATE_MODIFY');
  assert.ok(requests.every(path => path.endsWith('/crm.status.list.json') ||
    path.endsWith('/crm.deal.get.json')), 'never call mutating Bitrix methods');
  assert.equal(sales.status().wins.find(row => row.dealId === inferredId).scoreHistory.length, 3,
    'repeated dashboard reads must not manufacture duplicate history');
});

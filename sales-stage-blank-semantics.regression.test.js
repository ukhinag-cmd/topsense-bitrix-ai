'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('blank Bitrix stage semantics cannot replace a verified outcome or distort Sales scores', async t => {
  const oldFetch = global.fetch;
  const oldTimeout = global.setTimeout;
  const oldInterval = global.setInterval;
  const keys = ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET'];
  const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    global.fetch = oldFetch;
    global.setTimeout = oldTimeout;
    global.setInterval = oldInterval;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock-only/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 || ms === 5000 ? { unref() {} } : oldTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : oldInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9989920';
  const deal = {
    ID: id, TITLE: 'Blank semantics regression', CATEGORY_ID: '0',
    STAGE_ID: 'ACTIVE', STAGE_SEMANTIC_ID: '', ASSIGNED_BY_ID: '0',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 60000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let stages = [{
    STATUS_ID: 'ACTIVE', NAME: 'Verified process',
    SEMANTICS: null, EXTRA: { SEMANTICS: 'process' },
  }];
  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST', 'mocked read-only Bitrix requests only');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({ result: stages }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    throw new Error('Unexpected mocked CRM call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const verified = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(verified?.semantic, 'P');
  assert.equal(sales.status().lastError, null);

  // A present but blank short field has no documented P/S/F meaning. It
  // must not turn a verified process stage into an unknown classification.
  stages = [{ STATUS_ID: 'ACTIVE', NAME: 'Unverified blank', SEMANTICS: '' }];
  await sales.start();
  let state = sales.status();
  let retained = state.prospects.find(row => row.dealId === id);
  assert.equal(state.lastError?.source, 'stages', 'blank short semantics is unverified');
  assert.equal(retained?.semantic, 'P');
  assert.equal(retained?.stageName, 'Verified process');
  assert.equal(retained?.prospectScore, verified.prospectScore);
  assert.equal(retained?.riskScore, verified.riskScore);

  // An empty / whitespace-only long semantic without a short marker is
  // equally unverified; the mere presence of EXTRA cannot certify an outcome.
  stages = [{
    STATUS_ID: 'ACTIVE', NAME: 'Unverified long blank',
    EXTRA: { SEMANTICS: '   ' },
  }];
  await sales.start();
  state = sales.status();
  retained = state.prospects.find(row => row.dealId === id);
  assert.equal(state.lastError?.source, 'stages', 'blank EXTRA semantic is unverified');
  assert.equal(retained?.semantic, 'P');
  assert.equal(retained?.stageName, 'Verified process');

  // Even a seemingly valid second semantic must not mask an explicitly
  // malformed first field. Otherwise a short blank with long "success"
  // closes a verified in-progress deal while stage health looks healthy.
  for (const [label, row] of [
    ['blank short with valid success', {
      STATUS_ID: 'ACTIVE', NAME: 'Invalid short',
      SEMANTICS: '   ', EXTRA: { SEMANTICS: 'success' },
    }],
    ['blank short with valid process', {
      STATUS_ID: 'ACTIVE', NAME: 'Invalid short process',
      SEMANTICS: '', EXTRA: { SEMANTICS: 'process' },
    }],
    ['valid success with blank long', {
      STATUS_ID: 'ACTIVE', NAME: 'Invalid long',
      SEMANTICS: 'S', EXTRA: { SEMANTICS: '   ' },
    }],
    ['null process with blank long', {
      STATUS_ID: 'ACTIVE', NAME: 'Invalid null/blank',
      SEMANTICS: null, EXTRA: { SEMANTICS: '' },
    }],
  ]) {
    stages = [row];
    await sales.start();
    state = sales.status();
    retained = state.prospects.find(deal => deal.dealId === id);
    assert.equal(state.lastError?.source, 'stages', label);
    assert.equal(retained?.semantic, 'P', label);
    assert.equal(retained?.stageName, 'Verified process', label);
    assert.equal(retained?.prospectScore, verified.prospectScore, label);
    assert.equal(retained?.riskScore, verified.riskScore, label);
  }

  stages = [{
    STATUS_ID: 'ACTIVE', NAME: 'Verified success',
    SEMANTICS: 'S', EXTRA: { SEMANTICS: 'success' },
  }];
  await sales.start();
  state = sales.status();
  assert.equal(state.lastError, null, 'subsequent valid dictionary recovers health');
  assert.equal(state.wins.find(row => row.dealId === id)?.semantic, 'S');
  assert.equal(stageReads, 8);
});

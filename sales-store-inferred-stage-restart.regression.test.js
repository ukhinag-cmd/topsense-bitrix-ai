'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('persisted inferred closing outcome survives stage lookup outage until verified refresh', async t => {
  // All Bitrix/Sheet replies are mocked: no live CRM, Sheets or Render I/O.
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

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  process.env.GOOGLE_SHEET_STORE_URL = 'https://store.example.test/sales';
  process.env.GOOGLE_SHEET_STORE_SECRET = 'mock-only-secret';
  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) { scheduledSync = () => fn(...args); return { unref() {} }; }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const id = '9926881';
  const version = new Date(Date.now() - 60000).toISOString();
  const persisted = {
    kind: 'salesDeal', dealId: id, title: 'Previously verified closed deal',
    manager: 'Manager', managerId: '', sourceId: '', categoryId: '0',
    stageId: 'C1:CLOSED', stageName: 'Закрыта', semantic: 'S',
    // The last verified dictionary, not a direct deal field, supplied S.
    sourceStageSemantic: '', stageSemanticKnown: true, open: false,
    amount: 0, currency: 'RUB', updatedAt: version, sourceUpdatedAt: version,
    modifiedAt: version, createdAt: version, stageEnteredAt: version,
    nextActivityAt: null, lastActivityAt: null,
    nextStep: 'Сделка завершена успешно', hasNext: false,
    qualificationIssue: false, qualificationStatus: '', clientType: '',
    prospectScore: 5, riskScore: 0,
    scoreHistory: [{
      at: version, categoryId: '0', stageId: 'C1:CLOSED',
      stageName: 'Закрыта', semantic: 'S', amount: 0,
      currency: 'RUB', prospectScore: 5, riskScore: 0,
    }],
    alerts: [],
  };
  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    assert.equal(options.method, 'POST');
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({
        result: stageReads === 1 ? { temporary: 'bad stage response' } : [
          { STATUS_ID: 'C1:CLOSED', NAME: 'Закрыта без продажи', SEMANTICS: 'F' },
        ],
      }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    }
    if (String(input) === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        rows: [{ key: 'sales:deal:' + id, payload: persisted }],
      }) };
    }
    throw new Error('Unexpected mocked endpoint ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(stageReads, 1);
  let state = sales.status();
  assert.equal(state.lastError?.source, 'stages');
  assert.equal(state.counts.tracked, 1);
  assert.equal(state.counts.won, 1,
    'a stage read outage must not turn a previously verified win into an open deal');
  assert.equal(state.counts.open, 0);
  assert.equal(state.wins[0].semantic, 'S');
  assert.equal(state.wins[0].scoreHistory.length, 1,
    'a temporary missing dictionary must not fabricate an outcome transition');

  // A fresh verified stage dictionary is authoritative and can legitimately
  // correct the old persisted inference without an invented CRM update.
  await scheduledSync();
  state = sales.status();
  assert.equal(stageReads, 2);
  assert.equal(state.lastError, null);
  assert.equal(state.counts.won, 0);
  assert.equal(state.counts.open, 0);
  assert.equal(state.counts.tracked, 1);
  assert.ok(state.lastSyncAt, 'a complete read-only synchronization still succeeds');
  assert.equal(state.prospects.length, 0);
  assert.equal(state.attention.length, 0);
  assert.equal(state.wins.length, 0,
    'the new verified failed outcome is neither open nor a successful win');
});

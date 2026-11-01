'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('dormant stored non-default pipeline resolves verified stage metadata during read-only sync', async t => {
  // All responses are mocked. No actual Bitrix, Google Sheets or Render traffic.
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
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
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const id = '99887001';
  const created = new Date(Date.now() - 75 * 86400000).toISOString();
  const modified = new Date(Date.now() - 46 * 86400000).toISOString();
  const lastObserved = new Date(Date.now() - 60000).toISOString();
  // A dormant deal is older than the 45-day recent-deals scan. Its stage
  // semantics were inferred from a verified dictionary before the restart.
  const persisted = {
    kind: 'salesDeal', dealId: id, title: 'Dormant non-default pipeline',
    manager: 'Manager', managerId: '', sourceId: '', categoryId: '7',
    stageId: 'A', stageName: 'Старая открытая стадия',
    semantic: 'P', sourceStageSemantic: '', stageSemanticKnown: true,
    open: true, amount: 0, currency: 'RUB',
    createdAt: created, modifiedAt: modified, updatedAt: modified,
    sourceUpdatedAt: modified, observedAt: lastObserved,
    stageEnteredAt: modified, lastActivityAt: null, nextActivityAt: null,
    hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
    qualificationIssue: false, qualificationStatus: '', clientType: '',
    prospectScore: 15, riskScore: 100,
    scoreHistory: [{
      at: lastObserved, categoryId: '7', stageId: 'A',
      stageName: 'Старая открытая стадия', semantic: 'P', amount: 0,
      currency: 'RUB', prospectScore: 15, riskScore: 100,
    }],
    alerts: [],
  };

  const stageReads = [];
  const dealListFilters = [];
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const path = new URL(String(input)).pathname;
    if (String(input) === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        rows: [{ key: 'sales:deal:' + id, payload: persisted }],
      }) };
    }
    if (path.endsWith('/crm.status.list.json')) {
      const category = JSON.parse(options.body).filter.ENTITY_ID;
      stageReads.push(category);
      const result = category === 'DEAL_STAGE' ? [
        { STATUS_ID: 'OTHER', NAME: 'Default pipeline', SEMANTICS: 'P' },
      ] : category === 'DEAL_STAGE_7' ? [
        { STATUS_ID: 'A', NAME: 'Проверено: закрыта без продажи', SEMANTICS: 'F' },
      ] : null;
      assert.ok(result, 'only the known pipelines may be requested');
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      dealListFilters.push(JSON.parse(options.body).filter);
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    }
    throw new Error('Unexpected mocked endpoint ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  const before = sales.status();
  assert.equal(before.counts.tracked, 1);
  assert.equal(before.counts.open, 1, 'the stored last-verified inference survives startup');
  assert.deepEqual(stageReads, ['DEAL_STAGE'], 'startup only loads default stage metadata');

  // No recent deal is returned. Nevertheless the scheduled read-only scan
  // must reload dictionary 7 because a stored deal still depends on it.
  await scheduledSync();
  const after = sales.status();
  assert.equal(dealListFilters.length, 1);
  assert.deepEqual(stageReads, ['DEAL_STAGE', 'DEAL_STAGE_7'],
    'missing non-default dictionary must be fetched even without recent deals');
  assert.equal(after.lastError, null);
  assert.ok(after.lastSyncAt);
  assert.equal(after.counts.tracked, 1);
  assert.equal(after.counts.open, 0);
  assert.equal(after.counts.won, 0);
  assert.equal(after.attention.length, 0);
  const row = after.wins.find(x => x.dealId === id);
  assert.equal(row, undefined, 'the verified failed stage must not remain a win');
  // The closed deal no longer appears in the open/attention lists. Its audit
  // history still exists in the trusted in-memory map, reachable via status.
  assert.equal(after.counts.tracked, before.counts.tracked);
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The Bitrix crm.status.list envelope can report that more dictionary rows
// exist than were delivered. Never replace verified stage semantics with that
// incomplete list and silently reclassify won/lost deals in the Dashboard.
test('partial stage dictionary metadata fails closed and retains last verified outcomes', async t => {
  const original = {
    fetch: global.fetch, timeout: global.setTimeout,
    interval: global.setInterval, now: Date.now,
    env: Object.fromEntries(['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL',
      'GOOGLE_SHEET_STORE_SECRET'].map(key => [key, process.env[key]])),
  };
  t.after(() => {
    global.fetch = original.fetch;
    global.setTimeout = original.timeout;
    global.setInterval = original.interval;
    Date.now = original.now;
    for (const [key, value] of Object.entries(original.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const base = original.now();
  let elapsed = 0;
  Date.now = () => base + elapsed;
  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return original.timeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : original.interval(fn, ms, ...args);

  const verified = [
    { STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: null, EXTRA: { SEMANTICS: 'process' } },
    { STATUS_ID: 'WON', NAME: 'Успешно', SEMANTICS: 'S', EXTRA: { SEMANTICS: 'success' } },
  ];
  let stageEnvelope = { result: verified, total: 2 };
  let stageReads = 0;
  const deal = {
    ID: '9997541', TITLE: 'Closed deal', CATEGORY_ID: '0',
    STAGE_ID: 'WON', STAGE_SEMANTIC_ID: '',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '120000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(base - 2 * 86400000).toISOString(),
    DATE_MODIFY: new Date(base - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(base - 3600000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const methods = [];
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const method = new URL(String(input)).pathname.split('/').pop();
    methods.push(method);
    if (method === 'crm.status.list.json') {
      stageReads++;
      return { ok: true, status: 200, json: async () => stageEnvelope };
    }
    if (method === 'crm.deal.get.json')
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    if (method === 'crm.deal.list.json')
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    assert.fail('Unexpected mocked REST method: ' + method);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  const initial = sales.status();
  assert.equal(initial.wins[0]?.semantic, 'S');
  assert.equal(initial.wins[0]?.stageName, 'Успешно');
  assert.equal(initial.recentHistory.length, 1);

  // The total proves this nonempty response is incomplete. Previously the
  // reader ignored total entirely and erased the verified WON stage.
  elapsed = 31 * 60000;
  stageEnvelope = { result: [verified[0]], total: 2 };
  await scheduledSync();
  let status = sales.status();
  assert.equal(status.lastError?.source, 'stages',
    'contradictory dictionary total must be reported as an error');
  assert.equal(status.wins[0]?.semantic, 'S', 'keep verified won classification');
  assert.equal(status.wins[0]?.stageName, 'Успешно');
  assert.equal(status.recentHistory.length, 1, 'no invented outcome transition');

  // A next cursor likewise signals an unfinished dictionary read even
  // when its partial result is nonempty. Never certify it as authoritative.
  stageEnvelope = { result: [verified[0]], next: 50, total: 1 };
  await scheduledSync();
  status = sales.status();
  assert.equal(status.lastError?.source, 'stages');
  assert.equal(status.wins[0]?.semantic, 'S');
  assert.equal(status.recentHistory.length, 1);

  stageEnvelope = { result: [
    verified[0], { ...verified[1], NAME: 'Успех подтверждён' },
  ], total: 2 };
  await scheduledSync();
  status = sales.status();
  assert.equal(status.lastError, null, 'valid retry clears the stage error');
  assert.equal(status.wins[0]?.stageName, 'Успех подтверждён');
  assert.equal(status.wins[0]?.sourceUpdatedAt, deal.DATE_MODIFY);
  assert.equal(status.recentHistory.length, 1);
  assert.equal(stageReads, 4);
  assert.ok(methods.every(method => [
    'crm.status.list.json', 'crm.deal.get.json', 'crm.deal.list.json',
  ].includes(method)), 'all CRM methods were intercepted, read-only mocks');
});

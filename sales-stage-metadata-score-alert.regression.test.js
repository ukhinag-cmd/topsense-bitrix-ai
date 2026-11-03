'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage-dictionary-only reopening must not invent prospect or red-zone transition alerts', async t => {
  const priorFetch = global.fetch;
  const priorTimeout = global.setTimeout;
  const priorInterval = global.setInterval;
  const priorEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = priorFetch;
    global.setTimeout = priorTimeout;
    global.setInterval = priorInterval;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // All CRM responses are local mocks; no live Bitrix, Sheets or Render calls.
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, delay, ...args) =>
    delay === 5000 || delay === 2500 ? { unref() {} } : priorTimeout(fn, delay, ...args);
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : priorInterval(fn, delay, ...args);

  const now = Date.now();
  const prospectId = '9989787';
  const riskId = '9989788';
  const sourceVersion = new Date(now - 60000).toISOString();
  const base = {
    CATEGORY_ID: '0', STAGE_ID: 'C1:ACTIVE', STAGE_SEMANTIC_ID: '',
    ASSIGNED_BY_ID: '', CURRENCY_ID: 'RUB',
    DATE_MODIFY: sourceVersion, LAST_ACTIVITY_TIME: '',
    UF_CRM_AI_CLIENT_TYPE: '',
  };
  const deals = {
    [prospectId]: {
      ...base, ID: prospectId, TITLE: 'Metadata prospect',
      DATE_CREATE: new Date(now - 86400000).toISOString(),
      OPPORTUNITY: '55000', UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
      ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    },
    [riskId]: {
      ...base, ID: riskId, TITLE: 'Metadata risk',
      DATE_CREATE: new Date(now - 70 * 86400000).toISOString(),
      OPPORTUNITY: '0', UF_CRM_AI_QUAL_STATUS: '', ACTIVITY_TIME: '',
    },
  };
  let semantic = 'S';
  let stageReads = 0;
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'POST');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({
        result: [{ ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'C1:ACTIVE',
          NAME: 'Test stage', SEMANTICS: semantic }],
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      assert.ok(deals[id], 'unexpected CRM deal');
      return { ok: true, status: 200, json: async () => ({ result: deals[id] }) };
    }
    throw new Error('Unexpected mocked CRM call: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  for (const dealId of [prospectId, riskId]) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId });
  }
  const before = sales.status();
  assert.equal(before.counts.won, 2);
  assert.equal(before.counts.prospects, 0);
  assert.equal(before.counts.risk, 0);

  // Only crm.status.list changes; DATE_MODIFY and all CRM deal fields are
  // unchanged. The open state, scores and audit history must be corrected,
  // but no new deal-side transition occurred.
  semantic = 'P';
  await sales.start();
  const after = sales.status();
  assert.equal(stageReads, 2);
  const prospect = after.prospects.find(row => row.dealId === prospectId);
  const risk = after.attention.find(row => row.dealId === riskId);
  assert.ok(prospect && prospect.prospectScore >= 70);
  assert.ok(risk && risk.riskScore >= 60);
  assert.equal(prospect.sourceUpdatedAt, sourceVersion);
  assert.equal(risk.sourceUpdatedAt, sourceVersion);
  assert.deepEqual(prospect.scoreHistory.map(row => row.semantic), ['S', 'P']);
  assert.deepEqual(risk.scoreHistory.map(row => row.semantic), ['S', 'P']);
  assert.equal(prospect.alerts.some(alert => alert.type === 'prospect'), false,
    'dictionary correction alone is not a newly qualified CRM prospect');
  assert.equal(risk.alerts.some(alert => alert.type === 'risk'), false,
    'dictionary correction alone is not a newly escalated CRM risk');
});

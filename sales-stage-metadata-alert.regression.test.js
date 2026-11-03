'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage dictionary correction must not announce a new win without a deal transition', async t => {
  const oldFetch = global.fetch;
  const oldTimeout = global.setTimeout;
  const oldInterval = global.setInterval;
  const oldEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(name => [name, process.env[name]])
  );
  t.after(() => {
    global.fetch = oldFetch;
    global.setTimeout = oldTimeout;
    global.setInterval = oldInterval;
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // Strictly local mocks: no real Bitrix, Render, store or outgoing mail.
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, delay, ...args) =>
    delay === 5000 || delay === 2500 ? { unref() {} } : oldTimeout(fn, delay, ...args);
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : oldInterval(fn, delay, ...args);

  const now = Date.now();
  const inferredId = '9989781';
  const directId = '9989782';
  const firstVersion = new Date(now - 180000).toISOString();
  const secondVersion = new Date(now - 60000).toISOString();
  let dictionarySemantic = 'P';
  let directSemantic = 'P';
  let directVersion = firstVersion;

  global.fetch = async (url, options = {}) => {
    assert.equal(options.method, 'POST', 'read-only Bitrix REST transport');
    const method = new URL(String(url)).pathname;
    if (method.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: [{
          ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'C1:ACTIVE',
          NAME: 'Тестовая стадия', SEMANTICS: dictionarySemantic,
        }],
      }) };
    }
    if (method.endsWith('/crm.deal.get.json')) {
      const id = String(JSON.parse(options.body).ID);
      assert.ok([inferredId, directId].includes(id));
      return { ok: true, status: 200, json: async () => ({
        result: {
          ID: id, TITLE: 'Тестовая сделка', CATEGORY_ID: '0',
          STAGE_ID: 'C1:ACTIVE',
          STAGE_SEMANTIC_ID: id === directId ? directSemantic : '',
          ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
          DATE_CREATE: new Date(now - 86400000).toISOString(),
          DATE_MODIFY: id === directId ? directVersion : firstVersion,
          LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
          ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
          UF_CRM_AI_CLIENT_TYPE: 'dealer',
          UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
        },
      }) };
    }
    throw new Error('Unexpected mocked CRM method: ' + method);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: inferredId });
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: directId });
  const initial = sales.status();
  assert.ok(initial.prospects.some(row => row.dealId === inferredId));
  assert.ok(initial.prospects.some(row => row.dealId === directId));

  // Admin correction changes the dictionary, not the source deal's version.
  // The Dashboard must reclassify the inferred outcome and keep audit history,
  // but this is not evidence the customer just won a deal.
  dictionarySemantic = 'S';
  await sales.start();
  const corrected = sales.status();
  const inferredWin = corrected.wins.find(row => row.dealId === inferredId);
  assert.ok(inferredWin, 'inferred outcome follows the corrected stage dictionary');
  assert.equal(inferredWin.sourceUpdatedAt, firstVersion);
  assert.deepEqual(inferredWin.scoreHistory.map(row => row.semantic), ['P', 'S']);
  assert.equal(inferredWin.alerts.some(alert => alert.type === 'success'), false,
    'metadata-only correction must not produce a new closed-won notification');

  // A genuinely newer CRM deal version with direct won semantics MUST still
  // announce the observed transition, rather than suppressing all win alerts.
  assert.ok(corrected.prospects.some(row => row.dealId === directId),
    'direct CRM process semantic stays authoritative over metadata');
  directSemantic = 'S';
  directVersion = secondVersion;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: directId });
  const realWin = sales.status().wins.find(row => row.dealId === directId);
  assert.ok(realWin);
  assert.equal(realWin.sourceUpdatedAt, secondVersion);
  assert.equal(realWin.alerts.some(alert => alert.type === 'success'), true,
    'real source-version transition must still announce a win');
});

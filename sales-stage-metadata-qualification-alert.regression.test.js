'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('stage metadata correction must not create a false qualification warning', async t => {
  const oldFetch = global.fetch;
  const oldTimeout = global.setTimeout;
  const oldInterval = global.setInterval;
  const oldEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = oldFetch;
    global.setTimeout = oldTimeout;
    global.setInterval = oldInterval;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Strictly local mocks: no requests to live Bitrix, Sheets or Render.
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, delay, ...args) =>
    delay === 5000 || delay === 2500 ? { unref() {} } : oldTimeout(fn, delay, ...args);
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : oldInterval(fn, delay, ...args);

  const now = Date.now();
  const id = '9989911';
  const versions = [
    new Date(now - 120000).toISOString(),
    new Date(now - 60000).toISOString(),
    new Date(now - 30000).toISOString(),
  ];
  let versionIndex = 0;
  let semantic = 'S';
  let qualification = '';
  const deal = () => ({
    ID: id, TITLE: 'Metadata-only qualification warning', CATEGORY_ID: '0',
    STAGE_ID: 'C1:ACTIVE', STAGE_SEMANTIC_ID: '',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: versions[versionIndex],
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: qualification,
  });
  const methods = [];
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'POST');
    const method = new URL(String(url)).pathname;
    if (method.endsWith('/crm.status.list.json')) {
      methods.push('crm.status.list');
      return { ok: true, status: 200, json: async () => ({
        result: [{
          ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'C1:ACTIVE',
          NAME: 'Editable stage', SEMANTICS: semantic,
        }],
      }) };
    }
    if (method.endsWith('/crm.deal.get.json')) {
      methods.push('crm.deal.get');
      assert.equal(String(JSON.parse(options.body).ID), id);
      return { ok: true, status: 200, json: async () => ({ result: deal() }) };
    }
    throw new Error('Unexpected CRM method: ' + method);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(sales.status().counts.won, 1);

  // Only the stage dictionary changes. The same source deal is still
  // unqualified, but becoming open does not mean qualification JUST worsened.
  semantic = 'P';
  await sales.start();
  const corrected = sales.status();
  const row = corrected.prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(row.qualificationIssue, true);
  assert.equal(row.sourceUpdatedAt, versions[0]);
  assert.deepEqual(row.scoreHistory.map(item => item.semantic), ['S', 'P']);
  assert.equal(row.alerts.some(item => item.title === 'Проверить квалификацию'), false,
    'changing stage metadata alone must not announce a new CRM qualification defect');

  // A real, later CRM correction and deterioration must still notify.
  qualification = 'Квалифицировано';
  versionIndex = 1;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(sales.status().prospects.find(item => item.dealId === id).qualificationIssue, false);

  qualification = '';
  versionIndex = 2;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const actual = sales.status().prospects.find(item => item.dealId === id);
  assert.equal(actual.qualificationIssue, true);
  assert.equal(actual.alerts.filter(item => item.title === 'Проверить квалификацию').length, 1,
    'a real, versioned qualification deterioration must still alert');
  assert.deepEqual(methods, [
    'crm.status.list', 'crm.deal.get', 'crm.status.list',
    'crm.deal.get', 'crm.deal.get',
  ]);
});

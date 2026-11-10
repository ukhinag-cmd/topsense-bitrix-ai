'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Bitrix can represent the same unassigned manager as number 0 or string "0".
// Replaying a later deal version must not record a fictitious ownership
// transfer in the immutable read-only Prospect/Risk history.
test('unassigned manager zero type changes do not fabricate an ownership audit event', async t => {
  const oldFetch = global.fetch;
  const oldTimeout = global.setTimeout;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = oldFetch;
    global.setTimeout = oldTimeout;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : oldTimeout(fn, ms, ...args);

  const now = Date.now();
  const id = '9968217';
  const base = {
    ID: id, TITLE: 'Unassigned owner audit', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '75000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let crm = { ...base, ASSIGNED_BY_ID: 0, DATE_MODIFY: new Date(now - 240000).toISOString() };
  const reads = [];
  global.fetch = async (url, options) => {
    const method = new URL(String(url)).pathname.split('/').pop();
    reads.push(method);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    if (method === 'crm.deal.get.json') {
      assert.equal(String(JSON.parse(options.body).ID), id);
      return { ok: true, status: 200, json: async () => ({ result: { ...crm } }) };
    }
    if (method === 'user.get.json') {
      assert.equal(JSON.parse(options.body).ID, 7);
      return { ok: true, status: 200, json: async () => ({
        result: [{ ID: '7', NAME: 'Real', LAST_NAME: 'Owner' }],
      }) };
    }
    assert.fail('Unexpected mocked read-only method: ' + method);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(sales.status().recentHistory.filter(row => row.dealId === id).length, 1);

  // This is not a reassignment: the same unassigned identity arrived with a
  // different JSON primitive representation at a strictly newer CRM version.
  crm = { ...base, ASSIGNED_BY_ID: '0', DATE_MODIFY: new Date(now - 120000).toISOString() };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const unchanged = sales.status().recentHistory.filter(row => row.dealId === id);
  assert.equal(unchanged.length, 1,
    'number 0 to string "0" is not an auditable change of manager');
  assert.equal(unchanged[0].manager, '—');

  // The guard must not suppress real assignment changes.
  crm = { ...base, ASSIGNED_BY_ID: '7', DATE_MODIFY: new Date(now - 60000).toISOString() };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const reassigned = sales.status().recentHistory.filter(row => row.dealId === id);
  assert.equal(reassigned.length, 2, 'an actual manager transfer remains in history');
  assert.equal(reassigned[0].manager, 'Real Owner');
  assert.equal(reassigned[1].manager, '—');
  assert.deepEqual(reads, [
    'crm.deal.get.json', 'crm.deal.get.json', 'crm.deal.get.json', 'user.get.json',
  ], 'only mocked read-only CRM lookups are permitted');
});

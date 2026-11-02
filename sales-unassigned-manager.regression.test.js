'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('unassigned Bitrix manager 0 is a placeholder, not a user.get identity', async t => {
  // Mock transport only: never contact the real CRM, Sheets or Render.
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const unassignedString = '9949301';
  const unassignedNumber = '9949302';
  const assigned = '9949303';
  const assignedBy = {
    [unassignedString]: '0',
    [unassignedNumber]: 0,
    [assigned]: '7',
  };
  const userReads = [];
  const methods = [];
  global.fetch = async (input, options = {}) => {
    const method = new URL(String(input)).pathname.split('/').pop();
    methods.push(method);
    const params = JSON.parse(options.body || '{}');
    if (method === 'crm.deal.get.json') {
      const id = String(params.ID);
      assert.ok(Object.prototype.hasOwnProperty.call(assignedBy, id));
      return { ok: true, status: 200, json: async () => ({ result: {
        ID: id, TITLE: 'Manager placeholder', ASSIGNED_BY_ID: assignedBy[id],
        STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
        OPPORTUNITY: '0', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 86400000).toISOString(),
        DATE_MODIFY: new Date(now - 60000).toISOString(),
        LAST_ACTIVITY_TIME: new Date(now - 1800000).toISOString(),
      } }) };
    }
    if (method === 'user.get.json') {
      userReads.push(params.ID);
      return { ok: true, status: 200, json: async () => ({ result: [
        { ID: params.ID, NAME: 'Actual', LAST_NAME: 'Manager' },
      ] }) };
    }
    throw new Error('Unexpected CRM method: ' + method);
  };

  const sales = require('./sales');
  for (const id of [unassignedString, unassignedNumber, assigned]) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  }
  const rows = new Map(sales.status().attention.map(row => [row.dealId, row]));
  assert.equal(rows.get(unassignedString)?.manager, '—',
    'the string 0 represents an unassigned deal, not manager #0');
  assert.equal(rows.get(unassignedNumber)?.manager, '—',
    'the numeric 0 must have the same unassigned label');
  assert.equal(rows.get(unassignedString)?.managerId, '0');
  assert.equal(rows.get(unassignedNumber)?.managerId, '');
  assert.equal(rows.get(assigned)?.manager, 'Actual Manager',
    'a real positive manager ID still resolves normally');
  assert.deepEqual(userReads, [7],
    'unassigned deals must not request user.get ID=0 or fabricate an owner');
  assert.equal(sales.status().lastError, null);
  assert.ok(methods.every(method => ['crm.deal.get.json', 'user.get.json'].includes(method)),
    'the regression invokes only read-only mock methods');
});

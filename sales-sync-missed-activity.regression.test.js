'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('scheduled read-only sync recovers missed same-version activity without replacing trusted deal fields', async t => {
  const savedFetch = global.fetch;
  const savedTimeout = global.setTimeout;
  const savedInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = savedFetch;
    global.setTimeout = savedTimeout;
    global.setInterval = savedInterval;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let sync;
  global.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000) {
      sync = () => fn(...args);
      return { unref() {} };
    }
    if (delay === 2500) return { unref() {} };
    return savedTimeout(fn, delay, ...args);
  };
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : savedInterval(fn, delay, ...args);

  const now = Date.now();
  const id = '99526117';
  const version = new Date(now - 2 * 3600000).toISOString();
  const oldContact = new Date(now - 12 * 86400000).toISOString();
  const newContact = new Date(now - 20 * 60000).toISOString();
  const next = new Date(now + 3 * 3600000).toISOString();
  const baseline = {
    ID: id, TITLE: 'Verified sales opportunity',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 20 * 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: oldContact, ACTIVITY_TIME: null,
    UF_CRM_AI_CLIENT_TYPE: 'dealer', UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  // An activity can update scheduling/contact without changing deal DATE_MODIFY.
  // The sync copy must not be trusted for other equal-version fields.
  const advanced = {
    ...baseline, TITLE: 'Stale list title', OPPORTUNITY: '1',
    LAST_ACTIVITY_TIME: newContact, ACTIVITY_TIME: next,
  };
  const stale = { ...advanced, LAST_ACTIVITY_TIME: oldContact, ACTIVITY_TIME: null };
  let listReads = 0;
  const called = [];
  global.fetch = async input => {
    const method = new URL(String(input)).pathname.split('/').pop().replace(/\.json$/, '');
    called.push(method);
    let result;
    if (method === 'crm.status.list') result = [];
    else if (method === 'crm.deal.get') result = baseline;
    else if (method === 'crm.deal.list') {
      return {
        ok: true, status: 200,
        json: async () => ({ result: [listReads++ === 0 ? advanced : stale], total: 1 }),
      };
    } else throw new Error('Unexpected mocked CRM call: ' + method);
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const before = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(before);
  assert.equal(before.nextActivityAt, null);
  assert.equal(before.hasNext, false);
  assert.equal(typeof sync, 'function');

  // Simulate a missed activity webhook followed by the normal 45-day deal scan.
  await sync();
  const after = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(after);
  assert.equal(after.sourceUpdatedAt, version, 'sync must not invent a deal modification');
  assert.equal(after.lastActivityAt, newContact, 'later contact should be recovered from scheduled sync');
  assert.equal(after.nextActivityAt, next, 'a newly scheduled Next Step must be recovered');
  assert.equal(after.hasNext, true);
  assert.equal(after.nextOverdue, false);
  assert.ok(after.prospectScore > before.prospectScore);
  assert.ok(after.riskScore < before.riskScore);
  assert.equal(after.title, baseline.TITLE, 'equal-version sync cannot rewrite trusted title');
  assert.equal(after.amount, 250000, 'equal-version sync cannot rewrite trusted amount');
  assert.equal(after.scoreHistory.length, 2, 'real scoring change must be auditable');

  await sync();
  const unchanged = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(unchanged.lastActivityAt, newContact, 'a stale next scan must not roll back contact');
  assert.equal(unchanged.nextActivityAt, next, 'a stale next scan must not erase Next Step');
  assert.equal(unchanged.scoreHistory.length, 2, 'replayed stale sync must not fabricate history');
  assert.deepEqual([...new Set(called)].sort(),
    ['crm.status.list', 'crm.deal.get', 'crm.deal.list'].sort(),
    'mocked recovery only uses the existing read-only CRM method allowlist');
});

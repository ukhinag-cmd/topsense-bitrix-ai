'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a resumed Bitrix sync rejects unique but out-of-order records across page boundaries', async t => {
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
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let initialSync;
  let periodicSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      initialSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 1400) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) {
      periodicSync = () => fn(...args);
      return { unref() {} };
    }
    return originalInterval(fn, ms, ...args);
  };

  const now = Date.now();
  const version = new Date(now - 60000).toISOString();
  const deal = id => ({
    ID: String(id), TITLE: 'Boundary order ' + id,
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '150000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    NEXT_ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  });

  let cleanRecovery = false;
  const cursors = [];
  global.fetch = async (input, options = {}) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    assert.ok(pathname.endsWith('/crm.deal.list.json'));
    const params = JSON.parse(options.body);
    assert.deepEqual(params.order, { DATE_MODIFY: 'DESC', ID: 'DESC' });
    cursors.push(params.start);
    if (cleanRecovery) {
      return { ok: true, status: 200, json: async () => ({ result: [deal(9974010)], total: 1 }) };
    }
    // Each page is internally sorted and IDs are unique. The fifth page,
    // returned after a bounded four-page tick, violates the cross-page
    // DATE_MODIFY DESC, ID DESC boundary despite a stable total.
    const ids = [9974004, 9974003, 9974002, 9974001, 9974005];
    const id = ids[params.start];
    assert.ok(id);
    return {
      ok: true, status: 200,
      json: async () => ({
        result: [deal(id)],
        ...(params.start < 4 ? { next: params.start + 1 } : {}),
        total: 5,
      }),
    };
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(typeof initialSync, 'function');
  assert.equal(typeof periodicSync, 'function');

  await initialSync();
  assert.deepEqual(cursors, [0, 1, 2, 3]);
  const partial = sales.status();
  assert.equal(partial.syncPartial, true);
  assert.equal(partial.lastSyncAt, null);
  assert.equal(partial.counts.tracked, 4);

  await periodicSync();
  assert.deepEqual(cursors, [0, 1, 2, 3, 4]);
  const invalid = sales.status();
  assert.equal(invalid.lastSyncAt, null, 'an out-of-order resumed page must not certify a complete scan');
  assert.equal(invalid.lastError?.source, 'sales-sync');
  assert.match(invalid.lastError?.message || '', /order/i);
  assert.equal(invalid.counts.tracked, 4, 'the invalid fifth page must not be applied');

  cleanRecovery = true;
  await periodicSync();
  assert.equal(cursors.at(-1), 0, 'recovery must reset both the offset and sort boundary');
  const recovered = sales.status();
  assert.ok(recovered.lastSyncAt);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.syncPartial, false);
});

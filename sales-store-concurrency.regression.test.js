'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
const originalEnv = {
  BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
  GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
  GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
};

const storeUrl = 'https://store.example.test/sales';
process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
process.env.GOOGLE_SHEET_STORE_SECRET = 'test-store-secret';

const sales = require('./sales');

function bitrixResponse(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('a deal changed during an in-flight history write remains dirty and is persisted next', async t => {
  const scheduled = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      const handle = { fn: () => fn(...args), ms };
      scheduled.push(handle);
      return handle;
    }
    return originalSetTimeout(fn, ms, ...args);
  };

  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const older = {
    ID: '84',
    TITLE: 'Snapshot before store write',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-10-01T00:00:00Z',
    DATE_MODIFY: '2026-10-29T00:00:00.100000Z',
    LAST_ACTIVITY_TIME: '2026-10-29T00:00:00Z',
    ACTIVITY_TIME: '2026-10-29T01:00:00Z',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const newer = {
    ...older,
    TITLE: 'Snapshot after store write began',
    DATE_MODIFY: '2026-10-29T00:00:00.200000Z',
  };

  let dealCalls = 0;
  const firstStoreStarted = deferred();
  const firstStoreFinished = deferred();
  const secondStoreStarted = deferred();
  const secondStoreFinished = deferred();
  let releaseFirstStore;
  const writes = [];

  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.get.json')) {
      dealCalls += 1;
      return bitrixResponse(dealCalls === 1 ? older : newer);
    }
    if (url.pathname.endsWith('/user.get.json')) {
      return bitrixResponse([{ ID: '7', NAME: 'Sales Manager' }]);
    }
    if (String(input) === storeUrl) {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'upsert');
      writes.push(body.rows);
      if (writes.length === 1) {
        firstStoreStarted.resolve();
        return new Promise(resolve => {
          releaseFirstStore = () => resolve({
            ok: true,
            status: 200,
            text: async () => {
              firstStoreFinished.resolve();
              return '{"ok":true}';
            },
          });
        });
      }
      if (writes.length === 2) secondStoreStarted.resolve(body.rows);
      return {
        ok: true,
        status: 200,
        text: async () => {
          secondStoreFinished.resolve();
          return '{"ok":true}';
        },
      };
    }
    throw new Error('Unexpected mocked URL: ' + String(input));
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '84' });
  assert.equal(scheduled.length, 1, 'first dirty snapshot should schedule a store flush');

  scheduled[0].fn();
  await firstStoreStarted.promise;

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '84' });
  assert.equal(scheduled.length, 2, 'the update during the pending write should schedule another flush');

  releaseFirstStore();
  await firstStoreFinished.promise;
  await new Promise(resolve => originalSetTimeout(resolve, 0));

  scheduled[1].fn();
  let timeoutHandle;
  const latestRows = await Promise.race([
    secondStoreStarted.promise,
    new Promise((_, reject) => {
      timeoutHandle = originalSetTimeout(() => reject(new Error('newer dirty snapshot was dropped after the first write')), 500);
    }),
  ]);
  clearTimeout(timeoutHandle);

  assert.equal(latestRows.length, 1);
  assert.equal(latestRows[0].key, 'sales:deal:84');
  assert.equal(latestRows[0].payload.title, 'Snapshot after store write began');
  assert.equal(latestRows[0].payload.sourceUpdatedAt, newer.DATE_MODIFY);
  await secondStoreFinished.promise;
});

test('a persisted startup snapshot cannot roll back a newer webhook received during store load', async t => {
  const originalSetInterval = global.setInterval;
  const originalEnvNow = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'test-store-secret';

  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500 || ms === 5000) return { fn: () => fn(...args), ms };
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 120000) return { fn, ms };
    return originalSetInterval(fn, ms, ...args);
  };

  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(originalEnvNow)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const id = '987654321';
  const newer = {
    ID: id,
    TITLE: 'Newer webhook snapshot',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-10-01T00:00:00Z',
    DATE_MODIFY: '2026-10-29T00:00:00.200000Z',
    LAST_ACTIVITY_TIME: '2026-10-29T00:00:00Z',
    ACTIVITY_TIME: '2026-10-29T01:00:00Z',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const stale = {
    kind: 'salesDeal',
    dealId: id,
    title: 'Stale persisted snapshot',
    managerId: '7',
    manager: 'Old manager',
    sourceUpdatedAt: '2026-10-29T00:00:00.100000Z',
    updatedAt: '2026-10-29T00:00:00.100000Z',
    semantic: 'P',
    stageId: 'C1:NEW',
    open: true,
    amount: 1000000,
    currency: 'RUB',
    nextStep: 'Следующее действие запланировано',
    prospectScore: 90,
    riskScore: 10,
    hasNext: true,
    qualificationIssue: false,
    scoreHistory: [],
    alerts: [],
  };

  const loadStarted = deferred();
  let releaseLoad;
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.status.list.json')) {
      return bitrixResponse([{ STATUS_ID: 'C1:NEW', NAME: 'Новая', SEMANTICS: 'P' }]);
    }
    if (url.pathname.endsWith('/crm.deal.get.json')) return bitrixResponse(newer);
    if (url.pathname.endsWith('/user.get.json')) {
      return bitrixResponse([{ ID: '7', NAME: 'Current', LAST_NAME: 'Manager' }]);
    }
    if (String(input) === storeUrl) {
      const body = JSON.parse(options.body);
      if (body.action === 'load') {
        loadStarted.resolve();
        return new Promise(resolve => {
          releaseLoad = () => resolve({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ rows: [{ key: 'sales:deal:' + id, payload: stale }] }),
          });
        });
      }
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    throw new Error('Unexpected mocked URL: ' + String(input));
  };

  const starting = sales.start();
  await loadStarted.promise;
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });

  const live = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(live, 'the live deal should be present before the persisted load finishes');
  assert.equal(live.title, 'Newer webhook snapshot');

  releaseLoad();
  await starting;

  const finalRow = sales.status().prospects.find(item => item.dealId === id);
  assert.equal(finalRow.title, 'Newer webhook snapshot');
  assert.equal(finalRow.sourceUpdatedAt, newer.DATE_MODIFY);
});

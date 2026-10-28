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

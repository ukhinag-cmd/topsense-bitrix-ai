'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('contradictory Bitrix short-null / long-success stage semantics fail closed until a verified retry', async t => {
  const realFetch = global.fetch;
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  const realNow = Date.now;
  const envKeys = ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET'];
  const oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  t.after(() => {
    global.fetch = realFetch;
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
    Date.now = realNow;
    for (const [k, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock-only/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  const base = realNow();
  let elapsed = 0;
  Date.now = () => base + elapsed;

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    return realSetTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : realSetInterval(fn, ms, ...args);

  const deal = {
    ID: '9989482', TITLE: 'Stage semantic safety check', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: '', ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(base - 86400000).toISOString(),
    DATE_MODIFY: new Date(base - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(base - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(base + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };

  let stages = [{
    STATUS_ID: 'NEW', NAME: 'Open and verified',
    SEMANTICS: null, EXTRA: { SEMANTICS: 'process' },
  }];
  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST', 'only injected read-only mock requests are allowed');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({ result: stages }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    }
    throw new Error('Unexpected mocked read: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  assert.equal(sales.status().counts.open, 1);
  assert.equal(sales.status().prospects[0]?.semantic, 'P');

  // Documented short SEMANTICS:null means process. EXTRA success is a
  // contradictory provider response, not evidence that the deal was won.
  stages = [{
    STATUS_ID: 'NEW', NAME: 'Untrusted contradiction',
    SEMANTICS: null, EXTRA: { SEMANTICS: 'success' },
  }];
  elapsed = 31 * 60000;
  assert.equal(typeof scheduledSync, 'function');
  await scheduledSync();
  const failed = sales.status();
  assert.equal(stageReads, 2);
  assert.equal(failed.lastError?.source, 'stages',
    'contradictory metadata must be reported as an unhealthy stage refresh');
  assert.equal(failed.counts.open, 1, 'retain prior verified open classification');
  assert.equal(failed.wins.length, 0, 'do not fabricate a closed-won deal');
  assert.equal(failed.prospects[0]?.stageName, 'Open and verified');

  // Consistent metadata can still correct the classification at the next
  // read without a fake CRM DATE_MODIFY change or a production write.
  stages = [{
    STATUS_ID: 'NEW', NAME: 'Confirmed won',
    SEMANTICS: 'S', EXTRA: { SEMANTICS: 'success' },
  }];
  await scheduledSync();
  const recovered = sales.status();
  assert.equal(stageReads, 3);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.counts.open, 0);
  assert.equal(recovered.wins[0]?.semantic, 'S');
  assert.equal(recovered.wins[0]?.sourceUpdatedAt, deal.DATE_MODIFY);
});

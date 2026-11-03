'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('empty Bitrix stage refresh retains verified classification and reports a metadata failure', async t => {
  const realFetch = global.fetch;
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  const realNow = Date.now;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = realFetch;
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
    Date.now = realNow;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
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
    if (ms === 2500) return { unref() {} };
    return realTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : realInterval(fn, ms, ...args);

  const deal = {
    ID: '9989451', TITLE: 'Verified stage', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: '',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(base - 86400000).toISOString(),
    DATE_MODIFY: new Date(base - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(base - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(base + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };

  let stages = [{ STATUS_ID: 'NEW', NAME: 'Проверенная стадия', SEMANTICS: 'P' }];
  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST', 'mock only the read-only Bitrix transport');
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
    throw new Error('Unexpected mocked Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: deal.ID });
  assert.equal(sales.status().prospects[0]?.semantic, 'P');
  assert.equal(sales.status().prospects[0]?.stageName, 'Проверенная стадия');

  // A transient empty response is not evidence that every verified stage in
  // the configured pipeline was deleted. Keep the last trusted dictionary.
  stages = [];
  elapsed = 31 * 60000;
  await scheduledSync();
  const failed = sales.status();
  assert.equal(stageReads, 2);
  assert.equal(failed.lastError?.source, 'stages',
    'an empty replacement must not be silently accepted as healthy');
  assert.equal(failed.prospects[0]?.semantic, 'P',
    'last known-good stage semantics must survive the empty response');
  assert.equal(failed.prospects[0]?.stageName, 'Проверенная стадия');

  // Next scheduled read retries the failed pipeline and can correct labels.
  stages = [{ STATUS_ID: 'NEW', NAME: 'Обновлённая стадия', SEMANTICS: 'P' }];
  await scheduledSync();
  const recovered = sales.status();
  assert.equal(stageReads, 3);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.prospects[0]?.stageName, 'Обновлённая стадия');
  assert.equal(recovered.prospects[0]?.sourceUpdatedAt, deal.DATE_MODIFY);
});

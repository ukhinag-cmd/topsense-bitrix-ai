'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('score history attributes each observation to its manager at that time', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/readonly/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const id = '9989845';
  const base = {
    ID: id,
    TITLE: 'История передачи менеджера',
    CATEGORY_ID: '0',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let liveDeal = {
    ...base, ASSIGNED_BY_ID: '19', OPPORTUNITY: '75000',
    DATE_MODIFY: new Date(now - 240000).toISOString(),
  };
  const calls = [];
  global.fetch = async (input, options) => {
    const method = new URL(String(input)).pathname.split('/').pop();
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    calls.push(method);
    if (method === 'crm.deal.get.json') {
      assert.equal(String(JSON.parse(options.body).ID), id);
      return { ok: true, status: 200, json: async () => ({ result: { ...liveDeal } }) };
    }
    if (method === 'user.get.json') {
      const userId = String(JSON.parse(options.body).ID);
      assert.ok(['19', '20'].includes(userId));
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{
          ID: userId, NAME: userId === '19' ? 'Анна' : 'Борис', LAST_NAME: 'Тест',
        }] }),
      };
    }
    assert.fail('Unexpected CRM method: ' + method);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = sales.status().recentHistory;
  assert.equal(first.length, 1);
  assert.equal(first[0].manager, 'Анна Тест');

  // The next source version changes ownership and deal amount. Both belong
  // to the audit trail, but the first observation must retain its owner.
  liveDeal = {
    ...base, ASSIGNED_BY_ID: '20', OPPORTUNITY: '76000',
    DATE_MODIFY: new Date(now - 120000).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const observations = sales.status().recentHistory;
  assert.equal(observations.length, 2);
  assert.equal(observations[0].manager, 'Борис Тест');
  assert.equal(observations[1].manager, 'Анна Тест',
    'reassignment must not relabel the older score observation');
  assert.ok(sales.html().includes('Анна Тест'),
    'the HTML audit timeline must retain the historical manager too');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(method => ['crm.deal.get.json', 'user.get.json'].includes(method)));
});

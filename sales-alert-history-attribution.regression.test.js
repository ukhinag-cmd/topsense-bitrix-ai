'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('existing Sales alerts retain deal title and manager from the alert observation', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const savedEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(savedEnv)) {
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
  const id = '9989862';
  const originalTitle = 'Название в момент уведомления';
  const renamedTitle = '<img src=x onerror=alert(1)>Новая сделка';
  const base = {
    ID: id,
    TITLE: originalTitle,
    ASSIGNED_BY_ID: '0',
    CATEGORY_ID: '0',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: '',
    UF_CRM_AI_QUAL_STATUS: '',
    DATE_MODIFY: new Date(now - 120000).toISOString(),
  };
  let liveDeal = { ...base };
  let dealReads = 0;
  let userReads = 0;
  global.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    if (path.endsWith('/user.get.json')) {
      userReads += 1;
      assert.equal(JSON.parse(options.body).ID, 7);
      return { ok: true, status: 200, json: async () => ({
        result: [{ ID: '7', NAME: 'Мария', LAST_NAME: 'Соколова' }],
      }) };
    }
    assert.ok(path.endsWith('/crm.deal.get.json'));
    assert.equal(String(JSON.parse(options.body).ID), id);
    dealReads += 1;
    return { ok: true, status: 200, json: async () => ({ result: { ...liveDeal } }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(sales.status().alerts.filter(x => x.dealId === id && x.type === 'prospect').length, 0,
    'first observation alone must not invent a score-crossing alert');

  liveDeal = { ...base, OPPORTUNITY: '250000', DATE_MODIFY: new Date(now - 60000).toISOString() };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const before = sales.status().alerts.find(x => x.dealId === id && x.type === 'prospect');
  assert.ok(before, 'a real score threshold crossing creates an alert');
  assert.equal(before.titleDeal, originalTitle);
  assert.equal(before.manager, '—');

  liveDeal = {
    ...liveDeal, TITLE: renamedTitle, ASSIGNED_BY_ID: '7',
    DATE_MODIFY: new Date(now - 30000).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const afterStatus = sales.status();
  const after = afterStatus.alerts.find(x => x.dealId === id && x.type === 'prospect');
  assert.ok(after, 'the alert survives a CRM rename and manager transfer');
  assert.equal(after.titleDeal, originalTitle,
    'renaming must not retroactively change the historical alert title');
  assert.equal(after.manager, '—',
    'the new manager must not be credited with an earlier alert');
  assert.equal(afterStatus.prospects.find(x => x.dealId === id).manager, 'Мария Соколова',
    'the current deal still displays its new real manager');
  assert.equal(afterStatus.prospects.find(x => x.dealId === id).title, renamedTitle);
  assert.equal(dealReads, 3);
  assert.equal(userReads, 1);

  const html = sales.html();
  assert.ok(html.includes(originalTitle));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false,
    'CRM-supplied current titles are escaped in the read-only Dashboard');
});

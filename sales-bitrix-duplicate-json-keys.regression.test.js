'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// A transport's parsed JSON is not sufficient evidence of an unambiguous
// Bitrix response: JSON.parse keeps the LAST duplicate property. The raw
// response must be checked before a deal read is allowed to update scores,
// acknowledge a webhook, or declare a sync page complete.
test('Bitrix REST rejects duplicate JSON keys in deal and envelope responses', async t => {
  const originalFetch = global.fetch;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix-json-duplicate.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const id = '9911270';
  const now = new Date().toISOString();
  const deal = {
    ID: id, TITLE: 'Unambiguous deal', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
    DATE_MODIFY: now,
    OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
  };
  const valid = JSON.stringify({ result: deal });
  const nested = valid.replace('"ID":"' + id + '"',
    '"ID":"9911271","ID":"' + id + '"');
  const escaped = valid.replace('"ID":"' + id + '"',
    '"\\u0049D":"9911271","ID":"' + id + '"');
  const envelope = '{"result":{"ID":"9911271"},"result":' + JSON.stringify(deal) + '}';
  const responses = [nested, escaped, envelope, valid];
  let calls = 0;
  global.fetch = async input => {
    assert.match(new URL(String(input)).pathname, /\/crm\.deal\.get\.json$/);
    const raw = responses[calls++];
    assert.ok(raw, 'unexpected mocked CRM request');
    return {
      ok: true, status: 200,
      text: async () => raw,
      json: async () => JSON.parse(raw),
    };
  };
  const sales = require('./sales');
  for (let i = 0; i < responses.length - 1; i++) {
    await assert.rejects(
      sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id }, { propagateError: true }),
      /Bitrix|JSON/i,
      'duplicate keys must fail closed before generating a Sales observation'
    );
    assert.equal(sales.status().counts.tracked, 0, 'ambiguous CRM response must not create an observation');
    assert.equal(sales.status().lastError?.source, 'sales-event');
  }
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id }, { propagateError: true });
  assert.equal(calls, responses.length);
  assert.equal(sales.status().counts.tracked, 1);
  assert.equal(sales.status().lastError, null);
});

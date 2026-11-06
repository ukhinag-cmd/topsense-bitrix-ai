'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// All Bitrix fetches are mocked. Real response.json() returns JSON-shaped
// enumerable properties; an injected response must not erase hidden pagination
// metadata when Sales clones the payload and then certify an incomplete scan.
function mockReader() {
  const secret = 'test-only-credential-should-not-appear-in-diagnostics';
  let payload;
  const context = {
    module: { exports: {} },
    process: { env: { BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/' + secret + '/' } },
    URL, AbortSignal, console,
    fetch: async (_input, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => payload };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__readForTest = bitrixRaw;', context,
    { filename: 'sales.js' });
  return { setPayload(value) { payload = value; }, read: context.module.exports.__readForTest, secret };
}

test('live CRM transport rejects hidden total/next instead of losing pagination metadata', async () => {
  const h = mockReader();
  for (const [name, value] of [['total', 2], ['next', 1]]) {
    const response = { result: [{ ID: '17' }] };
    Object.defineProperty(response, name, { value, enumerable: false, configurable: true });
    h.setPayload(response);
    await assert.rejects(h.read('crm.deal.list', { start: 0 }), error => {
      assert.match(error.message, /Bitrix REST crm\.deal\.list response read failed/);
      assert.equal(error.message.includes(h.secret), false);
      return true;
    }, 'do not silently drop hidden ' + name);
  }
});

test('live CRM transport rejects sparse JSON arrays rather than replacing missing rows', async () => {
  const h = mockReader();
  const rows = new Array(2);
  rows[0] = { ID: '17' };
  h.setPayload({ result: rows });
  await assert.rejects(h.read('crm.deal.list', { start: 0 }),
    /Bitrix REST crm\.deal\.list response read failed/);
});

test('ordinary enumerable Bitrix REST JSON still passes through the read-only client', async () => {
  const h = mockReader();
  h.setPayload({ result: [{ ID: '17' }], total: 1 });
  const response = await h.read('crm.deal.list', { start: 0 });
  assert.equal(response.result.length, 1);
  assert.equal(response.result[0].ID, '17');
  assert.equal(response.total, 1);
});

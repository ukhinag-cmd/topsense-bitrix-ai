'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Offline, injected fetch only. A non-JSON transport object can put a
// pagination invariant on its prototype; copying own keys alone silently
// drops that metadata and makes an incomplete CRM read look successful.
test('read-only Bitrix REST rejects inherited response metadata without breaking cross-realm JSON', async () => {
  const env = { BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/fake/' };
  let envelope;
  const context = {
    module: { exports: {} }, process: { env }, URL, AbortSignal, console,
    fetch: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => envelope };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__readForTest = bitrixRaw;',
    context, { filename: 'sales.js' });
  const read = context.module.exports.__readForTest;

  for (const makeEnvelope of [
    () => Object.assign(Object.create({ total: 2 }), { result: [] }),
    () => new (class BitrixPage {
      constructor() { this.result = []; }
      get total() { return 2; }
    })(),
  ]) {
    envelope = makeEnvelope();
    await assert.rejects(read('crm.deal.list', { start: 0 }), error => {
      assert.match(error.message, /response read failed/i);
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(env.BITRIX_WEBHOOK_BASE), false);
      return true;
    }, 'inherited pagination metadata must not be discarded');
  }

  // The live transport uses JSON.parse, but injected tests and other realms
  // can legitimately create normal JSON-shaped objects with distinct
  // Object/Array prototypes. Keep those supported.
  envelope = { result: [{ ID: '42' }], total: 1 };
  assert.equal((await read('crm.deal.list', {})).result[0].ID, '42');
  envelope = vm.runInNewContext('({ result: [{ ID: "43" }], total: 1 })');
  assert.equal((await read('crm.deal.list', {})).result[0].ID, '43');
});

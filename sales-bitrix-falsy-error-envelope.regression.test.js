'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { probeDealNextActivity } = require('./sales-activity-readonly');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All transports below are in-memory. An HTTP 200 response containing the
// Bitrix REST error property is not proof of a successful read, even when its
// value is false, null, 0 or an empty string.
const falsyErrors = [false, null, 0, ''];

test('active Sales transport rejects explicit falsy REST error flags', async () => {
  const credential = 'fake-NEVER-LOG-webhook-credential';
  let responsePayload;
  const context = {
    module: { exports: {} },
    process: { env: { BITRIX_WEBHOOK_BASE: 'https://example.invalid/rest/7/' + credential + '/' } },
    fetch: async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => responsePayload };
    },
    URL, AbortSignal, console,
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('./sales'), 'utf8') +
      '\nmodule.exports.__bitrixRawForTest = bitrixRaw;',
    context, { filename: 'sales.js' },
  );
  const read = context.module.exports.__bitrixRawForTest;
  for (const error of falsyErrors) {
    responsePayload = { error, result: [] };
    await assert.rejects(read('crm.deal.list', { start: 0 }), failure => {
      assert.match(failure.message, /Bitrix REST crm\.deal\.list failed \(HTTP 200\)/);
      assert.equal(failure.cause, undefined);
      assert.equal(String(failure.stack).includes(credential), false);
      return true;
    }, 'explicit error=' + String(error) + ' must fail closed');
  }
  responsePayload = { result: [] };
  assert.deepEqual(Array.from((await read('crm.deal.list', {start: 0})).result), []);
});

test('inert Next Step probe cannot mistake a falsy REST error for an empty activity list', async () => {
  for (const error of falsyErrors) {
    await assert.rejects(
      probeDealNextActivity(async () => ({ error, result: [], total: 0 }), 72),
      /Invalid Bitrix activity list response/,
      'explicit error=' + String(error) + ' must fail closed',
    );
  }
  assert.equal((await probeDealNextActivity(async () => ({ result: [], total: 0 }), 72)).checked, 0);
});

test('inert Sales snapshot cannot mistake a falsy REST error for an empty queue', async () => {
  for (const error of falsyErrors) {
    const adapter = createReadOnlySalesAdapter(async method => {
      if (method === 'crm.category.list') {
        return { error, result: { categories: [{ id: 0, name: 'Main', entityTypeId: 2 }] }, total: 1 };
      }
      if (method === 'crm.status.list') return { result: [], total: 0 };
      throw new Error('Unexpected method: ' + method);
    });
    await assert.rejects(
      adapter.snapshot(),
      /CRM read failed/,
      'explicit error=' + String(error) + ' must fail closed',
    );
  }
  const clean = createReadOnlySalesAdapter(async method => method === 'crm.category.list'
    ? { result: {categories: [{id: 0, name: 'Main', entityTypeId: 2}]}, total: 1 }
    : { result: [], total: 0 });
  assert.equal((await clean.snapshot()).counts.queue, 0);
});

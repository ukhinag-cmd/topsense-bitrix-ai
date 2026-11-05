'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// In-memory transport only: never call Bitrix24, Render or Google Sheets.
const SECRET = 'test-only-bitrix-webhook-credential-76041';

async function rejectWithoutCredentialLeak(request) {
  await assert.rejects(createReadOnlySalesAdapter(request).snapshot(), error => {
    assert.match(error.message, /CRM read failed/i);
    assert.equal(String(error).includes(SECRET), false,
      'read-only adapter must not echo credentials from transport errors');
    assert.equal(String(error.stack || '').includes(SECRET), false,
      'a caller logging the exception stack must not leak credentials');
    assert.equal(error.cause, undefined,
      'do not attach an untrusted transport exception as cause');
    return true;
  });
}

test('read-only Bitrix transport rejection does not leak webhook URL credentials', async () => {
  let calls = 0;
  await rejectWithoutCredentialLeak(async method => {
    assert.equal(method, 'crm.category.list');
    calls += 1;
    throw new Error('Request to https://bitrix.example.test/rest/1/' + SECRET +
      '/crm.category.list.json failed');
  });
  assert.equal(calls, 1);
});

test('read-only adapter sanitizes non-Error transport rejections', async () => {
  await rejectWithoutCredentialLeak(async () =>
    Promise.reject('Permission denied for ' + SECRET));
});

test('malformed provider error getter cannot bypass read error redaction', async () => {
  await rejectWithoutCredentialLeak(async () => Object.defineProperty({}, 'error', {
    get() {
      throw new Error('Provider rejected ' + SECRET);
    },
  }));
});

test('ordinary read-only category/stage response still succeeds', async () => {
  const calls = [];
  const snapshot = await createReadOnlySalesAdapter(async (method, params) => {
    calls.push(method);
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Default' }] }, total: 1 };
    assert.equal(method, 'crm.status.list');
    assert.ok(params.filter.ENTITY_ID === 'STATUS' || params.filter.ENTITY_ID === 'DEAL_STAGE');
    return { result: [], total: 0 };
  }).snapshot();
  assert.equal(snapshot.counts.queue, 0);
  assert.deepEqual(calls, ['crm.category.list', 'crm.status.list', 'crm.status.list']);
});

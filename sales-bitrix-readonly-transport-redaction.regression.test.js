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

test('nested CRM response accessors cannot disclose a Bitrix credential after a read succeeds', async t => {
  // HTTP clients return parsed JSON. This mock guards against custom
  // transports accidentally passing untrusted objects with throwing getters.
  // The secret is synthetic; all provider data stays in memory.
  for (const path of ['result', 'total', 'next', 'category-id', 'category-name']) {
    await t.test(path, async () => {
      const response = {
        result: { categories: [{ id: 0, name: 'Default' }] },
        total: 1,
      };
      const category = response.result.categories[0];
      const target = path === 'category-id' || path === 'category-name'
        ? category : response;
      const key = path === 'category-id' ? 'id'
        : path === 'category-name' ? 'name' : path;
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get() { throw new Error('Untrusted CRM metadata ' + SECRET); },
      });
      await rejectWithoutCredentialLeak(async method => {
        assert.equal(method, 'crm.category.list');
        return response;
      });
    });
  }
});

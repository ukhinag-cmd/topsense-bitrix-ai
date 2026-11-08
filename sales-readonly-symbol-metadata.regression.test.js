'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');
const { probeDealNextActivity } = require('./sales-activity-readonly');

// Injected transport objects can carry symbol-keyed own properties even though
// decoded JSON cannot. Silently discarding such metadata is not a verified
// complete CRM response; reject it like hidden string-key pagination fields.
const addSymbolMetadata = response => {
  Object.defineProperty(response, Symbol('untrusted-pagination-marker'), {
    value: { next: 50 }, enumerable: false,
  });
  return response;
};

test('inert read-only Sales adapter rejects symbol-own-key CRM response metadata', async () => {
  const read = createReadOnlySalesAdapter(async method => {
    if (method === 'crm.category.list') {
      return addSymbolMetadata({
        result: { categories: [{ id: 0, name: 'Default' }] }, total: 1,
      });
    }
    if (method === 'crm.status.list') return { result: [], total: 0 };
    throw new Error('Unexpected method: ' + method);
  });
  await assert.rejects(read.snapshot({ pipelineIds: [] }), /CRM read failed/i);
});

test('inert read-only Next Step activity probe rejects symbol-own-key response metadata', async () => {
  await assert.rejects(
    probeDealNextActivity(async method => {
      assert.equal(method, 'crm.activity.list');
      return addSymbolMetadata({ result: [], total: 0 });
    }, 72),
    /Bitrix activity read failed/i,
  );
});

test('ordinary empty JSON CRM activity response remains valid', async () => {
  const result = await probeDealNextActivity(async () => ({ result: [], total: 0 }), 72);
  assert.deepEqual(result, { nextActivityAt: null, activitiesWithNoDeadline: 0, checked: 0 });
});

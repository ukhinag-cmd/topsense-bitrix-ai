'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// This preparation adapter is deliberately dormant. Its injected requests
// must reject incomplete pagination before a future caller trusts a snapshot.
test('dormant read-only adapter rejects skipped, truncated and oversized Bitrix pages', async t => {
  const category = id => ({ id, name: 'Pipeline ' + id });

  await t.test('a next cursor may not jump past the returned records', async () => {
    let requests = 0;
    const request = async (method, params) => {
      assert.equal(method, 'crm.category.list');
      requests += 1;
      if (params.start === 0) {
        return { result: { categories: [category(0)] }, next: 50, total: 51 };
      }
      return { result: { categories: [category(50)] }, total: 51 };
    };
    await assert.rejects(createReadOnlySalesAdapter(request).snapshot(), /pagination|cursor|incomplete/i);
    assert.equal(requests, 1, 'reject the invalid page before trusting subsequent data');
  });

  await t.test('missing next with an unfinished advertised total is not success', async () => {
    const request = async method => {
      assert.equal(method, 'crm.category.list');
      return { result: { categories: [category(0)] }, total: 2 };
    };
    await assert.rejects(createReadOnlySalesAdapter(request).snapshot(), /pagination|total|incomplete/i);
  });

  await t.test('more than 50 rows cannot be a Bitrix offset page', async () => {
    const request = async method => {
      assert.equal(method, 'crm.category.list');
      return { result: { categories: Array.from({ length: 51 }, (_, id) => category(id)) }, total: 51 };
    };
    await assert.rejects(createReadOnlySalesAdapter(request).snapshot(), /page|pagination|oversized/i);
  });

  await t.test('a legitimate 50 + 1 page read remains accepted', async () => {
    const starts = [];
    const request = async (method, params) => {
      if (method === 'crm.category.list') {
        starts.push(params.start);
        return params.start === 0
          ? { result: { categories: Array.from({ length: 50 }, (_, id) => category(id)) }, next: 50, total: 51 }
          : { result: { categories: [category(50)] }, total: 51 };
      }
      assert.equal(method, 'crm.status.list');
      return { result: [] };
    };
    const snapshot = await createReadOnlySalesAdapter(request).snapshot({ pipelineIds: [] });
    assert.deepEqual(starts, [0, 50]);
    assert.equal(snapshot.funnels.length, 0);
    assert.equal(snapshot.counts.queue, 0);
  });
});

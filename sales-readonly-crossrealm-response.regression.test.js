'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');
const { probeDealNextActivity } = require('./sales-activity-readonly');

// Injected read transports may return ordinary JSON from a separate realm
// (for example an isolated REST client). Its Object/Array prototypes differ
// by identity, but its serialized data is no less trustworthy than local JSON.
const foreignJson = value => vm.runInNewContext('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')');

test('inert read-only CRM adapter accepts plain cross-realm JSON response pages', async () => {
  const observedMethods = [];
  const adapter = createReadOnlySalesAdapter(async (method, params) => {
    observedMethods.push(method);
    if (method === 'crm.category.list') {
      return foreignJson({ result: { categories: [{ id: 0, name: 'Default' }] }, total: 1 });
    }
    if (method === 'crm.status.list') {
      const stages = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [];
      return foreignJson({ result: stages, total: stages.length });
    }
    assert.equal(method, 'crm.item.list');
    return foreignJson({ result: { items: [{
      id: 501, title: 'Cross-realm deal', stageId: 'NEW', categoryId: 0,
      assignedById: 9, opportunity: '100.50', currencyId: 'RUB',
      createdTime: '2026-11-07T08:00:00+03:00',
      updatedTime: '2026-11-07T09:00:00+03:00',
    }] }, total: 1 });
  });

  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.counts.activeDeals, 1);
  assert.equal(snapshot.activeDealAmountRUB, 100.5);
  assert.equal(snapshot.priorityQueue[0].key, 'deal:501');
  assert.deepEqual(observedMethods,
    ['crm.category.list', 'crm.status.list', 'crm.status.list', 'crm.item.list']);
});

test('inert Next Step probe accepts plain cross-realm JSON activity rows', async () => {
  const observed = await probeDealNextActivity(async (method, params) => {
    assert.equal(method, 'crm.activity.list');
    assert.equal(params.start, 0);
    return foreignJson({ result: [{
      ID: '601', OWNER_TYPE_ID: '2', OWNER_ID: '72',
      COMPLETED: 'N', DEADLINE: '2026-11-07T09:30:00.123456+03:00',
    }], total: 1 });
  }, 72);
  assert.deepEqual(observed, {
    nextActivityAt: '2026-11-07T06:30:00.123456Z',
    activitiesWithNoDeadline: 0,
    checked: 1,
  });
});

test('cross-realm support does not admit inherited pagination metadata', async () => {
  const inherited = Object.assign(Object.create({ total: 2 }), { result: [] });
  const adapter = createReadOnlySalesAdapter(async () => inherited);
  await assert.rejects(adapter.snapshot(), /CRM read failed/i);
  await assert.rejects(probeDealNextActivity(async () => inherited, 72), /Bitrix activity read failed/i);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// In-memory Bitrix replies only. No live CRM, Sheets, or Render requests.
function mockLeadSnapshot(rows) {
  const stage = { STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null };
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const stages = params.filter.ENTITY_ID === 'STATUS' ? [stage] : [];
      return { result: stages, total: stages.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 1);
    return { result: { items: rows }, total: rows.length };
  });
}
function lead(id, createdTime, updatedTime) {
  return { id, stageId: 'NEW', title: 'Lead ' + id,
    opportunity: '0', currencyId: 'RUB', createdTime, updatedTime };
}

test('submillisecond updatedTime before createdTime is invalid chronology', async () => {
  await assert.rejects(mockLeadSnapshot([
    lead(51, '2026-11-05T09:00:00.0009Z', '2026-11-05T09:00:00.0001Z'),
  ]).snapshot(), /invalid crm item chronology/i);
});

test('fractional instants compare correctly across equivalent zoned timestamps', async () => {
  await assert.rejects(mockLeadSnapshot([
    lead(52, '2026-11-05T10:00:00.0009+01:00', '2026-11-05T09:00:00.0001Z'),
  ]).snapshot(), /invalid crm item chronology/i);
  const valid = await mockLeadSnapshot([
    lead(53, '2026-11-05T10:00:00.0001+01:00', '2026-11-05T09:00:00.0009Z'),
    lead(54, '2026-11-05T09:00:00.500Z', '2026-11-05T09:00:00.500000+00:00'),
  ]).snapshot();
  assert.equal(valid.counts.newLeads, 2);
});

test('new lead queue sorts by full timestamp precision, not by ID at same millisecond', async () => {
  const view = await mockLeadSnapshot([
    lead(61, '2026-11-05T09:00:00.0009Z', '2026-11-05T09:00:00.0009Z'),
    lead(62, '2026-11-05T09:00:00.0001Z', '2026-11-05T09:00:00.0001Z'),
  ]).snapshot();
  assert.deepEqual(view.priorityQueue.map(x => x.id), [61, 62]);
});

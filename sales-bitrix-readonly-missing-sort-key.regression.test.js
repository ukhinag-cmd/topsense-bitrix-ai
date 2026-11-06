'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All reads are injected memory-only fixtures. This dormant adapter never
// contacts a CRM. createdTime DESC, id DESC is not verifiable when a
// paginated item omits the very sort key requested from Bitrix24.
const date = n => `2026-11-0${n}T09:00:00+03:00`;
const deal = (id, createdTime) => ({
  id, title: 'Deal ' + id, stageId: 'NEW', categoryId: 0,
  assignedById: 3, opportunity: '100.00', currencyId: 'RUB',
  createdTime, updatedTime: date(6),
});

function adapterFor(pages) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.deepEqual(params.order, { createdTime: 'DESC', id: 'DESC' });
    const page = pages.find(page => page.start === params.start);
    assert.ok(page, 'unexpected CRM offset');
    return { result: { items: page.rows }, total: pages.reduce((n, p) => n + p.rows.length, 0),
      ...(page.next === undefined ? {} : { next: page.next }) };
  });
}

test('paginated item reads reject missing creation sort keys anywhere in a page', async t => {
  const scenarios = [
    {
      name: 'missing first-page tail',
      pages: [
        { start: 0, rows: [deal(5, date(5)), deal(4, null)], next: 2 },
        { start: 2, rows: [deal(3, date(2))] },
      ],
    },
    {
      name: 'missing later-page first row',
      pages: [
        { start: 0, rows: [deal(5, date(5)), deal(4, date(4))], next: 2 },
        { start: 2, rows: [deal(3, null)] },
      ],
    },
    {
      name: 'missing middle item surrounded by valid timestamps',
      pages: [
        { start: 0, rows: [deal(5, date(5)), deal(4, null), deal(3, date(3))], next: 3 },
        { start: 3, rows: [deal(2, date(2))] },
      ],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await assert.rejects(adapterFor(scenario.pages).snapshot(), /missing.*sort|out.of.order|pagination/i);
    });
  }
});

test('legacy single-page items may omit createdTime when no offset ordering is asserted', async () => {
  const result = await adapterFor([{ start: 0, rows: [deal(9, null)] }]).snapshot();
  assert.equal(result.counts.activeDeals, 1);
  assert.equal(result.priorityQueue[0].createdAt, null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// No external CRM calls: all Bitrix read responses are explicit in-memory
// fixtures. Tied minimum SORT positions do not identify the first lead stage.
const stage = (id, sort) => ({
  STATUS_ID: id, NAME: id, SORT: sort, SEMANTICS: null,
});
function adapterFor(stages, leadStageId) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'STATUS' ? stages : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 1);
    return { result: { items: [{
      id: 91, title: 'Existing lead', stageId: leadStageId,
      opportunity: '0', currencyId: 'RUB',
    }] }, total: 1 };
  });
}

test('tied earliest active lead SORT is ambiguous, never certify a lead as new', async t => {
  const newStage = stage('NEW', 10);
  const working = stage('IN_PROCESS', 10);
  for (const stages of [[working, newStage], [newStage, working]]) {
    await t.test(stages.map(s => s.STATUS_ID).join(' then '), async () => {
      await assert.rejects(adapterFor(stages, 'IN_PROCESS').snapshot(),
        /ambiguous crm initial lead stage sort/i,
        'server ordering cannot determine the initial lead stage when SORT ties');
    });
  }
});

test('unique earliest SORT still determines new and progressed leads', async () => {
  const stages = [stage('IN_PROCESS', 20), stage('NEW', 10)];
  const newLead = await adapterFor(stages, 'NEW').snapshot();
  assert.equal(newLead.counts.newLeads, 1);
  assert.equal(newLead.counts.activeLeads, 0);

  const progressed = await adapterFor(stages, 'IN_PROCESS').snapshot();
  assert.equal(progressed.counts.newLeads, 0);
  assert.equal(progressed.counts.activeLeads, 1);
});

test('later lead-stage SORT ties are safe when the earliest stage is unique', async () => {
  const stages = [stage('WAITING', 20), stage('NEW', 10), stage('IN_PROCESS', 20)];
  const snapshot = await adapterFor(stages, 'WAITING').snapshot();
  assert.equal(snapshot.counts.newLeads, 0);
  assert.equal(snapshot.counts.activeLeads, 1);
});

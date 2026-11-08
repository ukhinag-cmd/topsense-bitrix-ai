'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

// An explicit BINDINGS array is the activity's identity provenance. A valid
// binding at the front must not hide a malformed later item via Array.some().
test('activity probe rejects malformed extra bindings even after a valid deal binding', async () => {
  const ownDeal = { OWNER_TYPE_ID: 2, OWNER_ID: 72 };
  const record = bindings => ({
    ID: '10021', OWNER_TYPE_ID: 3, OWNER_ID: 100,
    BINDINGS: bindings, COMPLETED: 'N', DEADLINE: '2026-11-08T12:00:00+03:00',
  });
  const invalid = [
    null, [], 'garbled',
    { OWNER_TYPE_ID: ['2'], OWNER_ID: 72 },
    { OWNER_TYPE_ID: 2, OWNER_ID: '072' },
    { OWNER_TYPE_ID: 2, OWNER_ID: { toString: null } },
    { OWNER_TYPE_ID: 2 },
    { OWNER_TYPE_ID: 0, OWNER_ID: 72 },
  ];
  for (const entry of invalid) {
    await assert.rejects(
      probeDealNextActivity(async () => ({ result: [record([ownDeal, entry])], total: 1 }), 72),
      /Invalid Bitrix activity binding/i,
      'all binding entries must be checked, even after the requested deal was found',
    );
    await assert.rejects(
      probeDealNextActivity(async () => ({ result: [record([entry, ownDeal])], total: 1 }), 72),
      /Invalid Bitrix activity binding/i,
      'an invalid entry before the deal binding must also fail closed',
    );
  }

  const normal = await probeDealNextActivity(async () => ({
    result: [record([ownDeal, { OWNER_TYPE_ID: 3, OWNER_ID: 100 }])], total: 1,
  }), 72);
  assert.deepEqual(normal, {
    nextActivityAt: '2026-11-08T09:00:00.000Z', activitiesWithNoDeadline: 0, checked: 1,
  });
});

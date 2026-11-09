'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

function activity(id, deadline) {
  return {
    ID: String(id),
    OWNER_TYPE_ID: '2', OWNER_ID: '72',
    COMPLETED: 'N', DEADLINE: deadline,
  };
}

test('read-only activity probe chooses the earlier sub-millisecond Next Step, regardless of activity order', async () => {
  const earlier = '2026-11-10T12:00:00.123100+03:00';
  const later = '2026-11-10T09:00:00.123900Z';
  const expected = '2026-11-10T09:00:00.123100Z';
  assert.equal(Date.parse(earlier), Date.parse(later),
    'Date.parse cannot distinguish these two Bitrix activity deadlines');

  for (const deadlines of [[earlier, later], [later, earlier]]) {
    const rows = deadlines.map((deadline, index) => activity(10501 + index, deadline));
    const observed = await probeDealNextActivity(async (method, params) => {
      assert.equal(method, 'crm.activity.list');
      assert.equal(params.filter.COMPLETED, 'N');
      return { result: rows, total: rows.length };
    }, 72);
    assert.equal(observed.nextActivityAt, expected,
      'the true earliest deadline must survive UTC normalization without sub-millisecond truncation');
    assert.equal(observed.checked, 2);
  }
});

test('activity probe retains verified nanosecond precision and ignores no-deadline placeholders', async () => {
  const observed = await probeDealNextActivity(async () => ({
    result: [
      activity(10501, '9999-12-31T00:00:00+03:00'),
      activity(10502, '2026-11-11T12:00:00.123456789+03:00'),
      activity(10503, '2026-11-11T12:00:00.123456790+03:00'),
    ],
    total: 3,
  }), 72);
  assert.equal(observed.nextActivityAt, '2026-11-11T09:00:00.123456789Z');
  assert.equal(observed.activitiesWithNoDeadline, 1);
  assert.equal(observed.checked, 3);
});

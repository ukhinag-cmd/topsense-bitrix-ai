'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

const activity = deadline => ({
  ID: '10421', OWNER_TYPE_ID: '2', OWNER_ID: '72',
  COMPLETED: 'N', DEADLINE: deadline,
});

test('read-only activity probe accepts ISO fractional seconds through nanoseconds without altering deadline minutes', async () => {
  for (const [deadline, expected] of [
    ['2026-11-07T09:30:00.1+03:00', '2026-11-07T06:30:00.100Z'],
    ['2026-11-07T09:30:00.123456+03:00', '2026-11-07T06:30:00.123456Z'],
    ['2026-11-07T09:30:00.123456789+03:00', '2026-11-07T06:30:00.123456789Z'],
  ]) {
    const observed = await probeDealNextActivity(async () => ({
      result: [activity(deadline)], total: 1,
    }), 72);
    assert.equal(observed.nextActivityAt, expected, 'parse valid ISO fractional deadline ' + deadline);
    assert.equal(observed.checked, 1);
  }
});

test('extra datetime precision never permits an impossible calendar date or an unbounded fraction', async () => {
  for (const deadline of [
    '2026-02-30T09:30:00.123456+03:00',
    '2026-11-07T24:30:00.123456+03:00',
    '2026-11-07T09:30:00.123456+14:30',
    '2026-11-07T09:30:00.1234567890+03:00',
  ]) {
    await assert.rejects(
      probeDealNextActivity(async () => ({ result: [activity(deadline)], total: 1 }), 72),
      /deadline/i,
    );
  }
});

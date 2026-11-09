'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Next Step picks the earlier of two candidate dates within one millisecond', () => {
  // Pure in-memory extraction of the actual Sales function. No CRM calls,
  // Google Sheets writes, Render requests, or outbound messages.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = {
    module: { exports: {} }, process: { env: {} },
    URL, AbortSignal, console,
  };
  vm.runInNewContext(source + `
    module.exports.__scheduled = scheduledActivityTime;
    module.exports.__compare = compareBitrixTimestamp;
  `, context, { filename: 'sales.js' });
  const { __scheduled: next, __compare: compare } = context.module.exports;
  const earlier = '2026-11-10T12:00:00.123100+03:00';
  const later = '2026-11-10T12:00:00.123900+03:00';

  assert.equal(Date.parse(earlier), Date.parse(later),
    'Date.parse loses the sub-millisecond ordering information');
  assert.equal(compare(earlier, later), -1);
  assert.equal(next({ ACTIVITY_TIME: later, NEXT_ACTIVITY_TIME: earlier }), earlier,
    'an earlier NEXT_ACTIVITY_TIME must not be masked by the first field');
  assert.equal(next({ ACTIVITY_TIME: earlier, NEXT_ACTIVITY_TIME: later }), earlier,
    'reversing the input must not change the chosen instant');

  // An offset-encoded equivalent time and an unscheduled Bitrix sentinel
  // must not perturb the real, earliest deadline.
  assert.equal(next({
    ACTIVITY_TIME: '2026-11-10T09:00:00.123900Z',
    NEXT_ACTIVITY_TIME: earlier,
  }), earlier);
  assert.equal(next({
    ACTIVITY_TIME: '9999-12-31T00:00:00+03:00',
    NEXT_ACTIVITY_TIME: earlier,
  }), earlier);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

const bind = (id, additional = []) => [{ OWNER_TYPE_ID: 2, OWNER_ID: id }, ...additional];
const activity = (id, deadline, dealId = 72, completed = 'N') => ({
  ID: id, OWNER_TYPE_ID: 3, OWNER_ID: 100, BINDINGS: bind(dealId, [{ OWNER_TYPE_ID: 3, OWNER_ID: 100 }]),
  COMPLETED: completed, DEADLINE: deadline,
});
const later = '2026-11-08T11:30:00+03:00';
const earlier = '2026-11-07T09:30:00+03:00';

test('read-only activity probe scans all pages and picks earliest incomplete bound deadline', async () => {
  const calls = [];
  const list = Array.from({ length: 50 }, (_, i) => activity(i+1, later));
  const transport = async (method, params) => {
    calls.push({method, params});
    return params.start === 0
      ? { result: list, total: 51, next: 50 }
      : { result: [activity(51, earlier)], total: 51 };
  };
  const found = await probeDealNextActivity(transport, '72');
  assert.deepEqual(found, {nextActivityAt: '2026-11-07T06:30:00.000Z', activitiesWithNoDeadline: 0, checked: 51});
  assert.deepEqual(calls.map(x=>x.method), ['crm.activity.list', 'crm.activity.list']);
  for (const {params} of calls) {
    assert.deepEqual(params.filter, { BINDINGS: [{OWNER_TYPE_ID:2, OWNER_ID:72}], COMPLETED: 'N' });
    assert.ok(params.select.includes('BINDINGS'));
    assert.ok(params.select.includes('DEADLINE'));
  }
});

test('probe reflects earlier reschedules, cancellations and activities without deadlines', async () => {
  let rows = [activity(81, later), activity(82, earlier)];
  const transport = async () => ({ result: rows, total: rows.length });
  assert.equal((await probeDealNextActivity(transport, 72)).nextActivityAt, '2026-11-07T06:30:00.000Z');
  rows = [activity(81, '2026-11-06T13:00:00+03:00')];
  assert.equal((await probeDealNextActivity(transport, 72)).nextActivityAt, '2026-11-06T10:00:00.000Z');
  rows = [activity(83, null)];
  assert.deepEqual(await probeDealNextActivity(transport, 72), {
    nextActivityAt: null, activitiesWithNoDeadline: 1, checked: 1,
  });
  rows = [];
  assert.deepEqual(await probeDealNextActivity(transport, 72), {
    nextActivityAt: null, activitiesWithNoDeadline: 0, checked: 0,
  });
});

test('rejects foreign binding, completed records, malformed dates and malformed identity', async () => {
  for (const row of [
    activity(1, earlier, 73), activity(1, earlier, 72, 'Y'),
    activity(1, '2026-11-07T09:30:00'), activity('01', earlier),
    activity(1, 'not a date'), { ...activity(1, earlier), BINDINGS: null },
  ]) {
    await assert.rejects(probeDealNextActivity(async () => ({result:[row]}), 72));
  }
  for (const id of ['0', '072', '12e2', {}, [], 9007199254740992]) {
    await assert.rejects(probeDealNextActivity(async () => {throw Error('not reached');}, id), /Invalid Bitrix deal ID/);
  }
});

test('never certifies a partial, duplicated or contradictory multi-page result', async () => {
  const fifty = Array.from({length:50},(_,i)=>activity(i+1, later));
  await assert.rejects(probeDealNextActivity(async (_m,p)=>p.start===0
    ? {result:fifty, next:50, total:51} : {result: [], total:51}, 72), /Inconsistent|Incomplete/);
  await assert.rejects(probeDealNextActivity(async (_m,p)=>p.start===0
    ? {result:fifty, next:50} : {result:[activity(1, earlier)]}, 72), /duplicate/i);
  await assert.rejects(probeDealNextActivity(async () => ({result:fifty, next:100}), 72), /pagination/);
  await assert.rejects(probeDealNextActivity(async (_m,p) => ({
    result: Array.from({length:50}, (_,i)=>activity(p.start+i+1, later)), next:p.start+50,
  }), 72), /page limit/);
});


test('accepts documented primary-owner rows without BINDINGS and treats 9999-12-31 as no deadline', async () => {
  // Bitrix's published crm.activity.list tutorial selects OWNER_ID but not BINDINGS.
  // No deadline is represented by the special year-9999 date, not only null.
  const row = {
    ID: '10120', OWNER_TYPE_ID: '2', OWNER_ID: '72', COMPLETED: 'N',
    DEADLINE: '2026-11-07T09:30:00+03:00',
  };
  const request = async () => ({result:[row], total:1});
  assert.deepEqual(await probeDealNextActivity(request, 72), {
    nextActivityAt: '2026-11-07T06:30:00.000Z', activitiesWithNoDeadline: 0, checked: 1,
  });
  row.DEADLINE = '9999-12-31T00:00:00+03:00';
  assert.deepEqual(await probeDealNextActivity(request, 72), {
    nextActivityAt: null, activitiesWithNoDeadline: 1, checked: 1,
  });
});

test('missing bindings never permits an unproven, foreign or malformed primary owner', async () => {
  const common = {ID: '10120', COMPLETED: 'N', DEADLINE: earlier};
  for (const row of [
    {...common, OWNER_TYPE_ID: '2', OWNER_ID: '73'},
    {...common, OWNER_TYPE_ID: '3', OWNER_ID: '72'},
    {...common, OWNER_ID: '72'},
    {...common, OWNER_TYPE_ID: ['2'], OWNER_ID: '72'},
    {...common, OWNER_TYPE_ID: '2', OWNER_ID: {toString: null}},
    {...common, OWNER_TYPE_ID: '2', OWNER_ID: '72', BINDINGS: []},
    {...common, OWNER_TYPE_ID: '2', OWNER_ID: '72', BINDINGS: [{OWNER_TYPE_ID: 2, OWNER_ID: 73}]},
  ]) {
    await assert.rejects(probeDealNextActivity(async () => ({result:[row]}), 72));
  }
});


test('rejects normalized impossible calendar dates and impossible timezone offsets', async () => {
  // Date.parse silently converts 2026-02-30 into March 2 on Node.js.
  // A malformed provider deadline must not become a real next step.
  for (const deadline of [
    '2026-02-30T09:30:00+03:00',
    '2026-11-31T09:30:00+03:00',
    '2026-01-01T24:00:00+03:00',
    '2026-11-07T09:30:00+15:00',
    '2026-11-07T09:30:00+14:30',
  ]) {
    await assert.rejects(
      probeDealNextActivity(async () => ({result:[activity(99, deadline)]}), 72),
      /deadline/i, 'reject invalid deadline ' + deadline
    );
  }
  assert.equal(
    (await probeDealNextActivity(async () =>
      ({result:[activity(99, '2028-02-29T09:30:00+03:00')]}), 72)).nextActivityAt,
    '2028-02-29T06:30:00.000Z',
    'valid leap-day deadlines still work'
  );
});


test('out-of-order activity pages never certify a complete next-action scan', async () => {
  // An offset scan can drift under concurrent CRM changes while the number of
  // returned rows and total remain plausible. The request explicitly orders
  // by ascending ID, so an inversion must be treated as an incomplete scan.
  const firstPage = Array.from({ length: 50 }, (_, i) => activity(i + 2, later));
  const request = async (_method, params) => params.start === 0
    ? { result: firstPage, total: 51, next: 50 }
    : { result: [activity(1, earlier)], total: 51 };
  await assert.rejects(probeDealNextActivity(request, 72), /out-of-order/i);

  await assert.rejects(
    probeDealNextActivity(async () => ({
      result: [activity(10, later), activity(2, earlier)], total: 2,
    }), 72),
    /out-of-order/i,
    'reversed IDs within a single page must also fail closed'
  );

  const valid = await probeDealNextActivity(async () => ({
    result: [activity(2, later), activity(10, earlier)], total: 2,
  }), 72);
  assert.equal(valid.nextActivityAt, '2026-11-07T06:30:00.000Z',
    'ascending IDs are compared numerically rather than lexically');
});

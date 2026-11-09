'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('score history timestamps remain monotonic within a single millisecond', () => {
  // Exercise the actual append-time comparator with synthetic CRM timestamps.
  // No Bitrix, Google Sheets, Render, or network calls.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = {
    module: { exports: {} }, process: { env: {} },
    URL, AbortSignal, console,
  };
  vm.runInNewContext(
    source + '\nmodule.exports.__historyAt = chronologicalHistoryAt;' +
      '\nmodule.exports.__compare = compareBitrixTimestamp;',
    context, { filename: 'sales.js' }
  );
  const { __historyAt: historyAt, __compare: compare } = context.module.exports;

  const previous = '2026-11-09T12:00:00.1239Z';
  const delayedSource = '2026-11-09T12:00:00.1231Z';
  const earlyObservation = '2026-11-09T12:00:00.1235Z';
  const laterObservation = '2026-11-09T12:00:00.12391Z';

  assert.equal(Date.parse(previous), Date.parse(delayedSource),
    'Date.parse collapses the distinct fractional CRM instants');
  assert.equal(compare(delayedSource, previous), -1);
  assert.equal(historyAt(delayedSource, previous, earlyObservation), previous,
    'a delayed source and observation cannot reverse the persisted audit tail');
  assert.equal(historyAt(delayedSource, previous, laterObservation), laterObservation,
    'prefer a genuinely later observation over the existing history timestamp');
  assert.equal(historyAt(laterObservation, previous), laterObservation,
    'a later source version within the millisecond remains authoritative');
  assert.equal(historyAt(previous, previous), previous,
    'equal timestamps remain valid and deterministic');
});

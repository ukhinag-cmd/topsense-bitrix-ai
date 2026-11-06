'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('malformed zero-padded Bitrix activity owner types fail closed instead of being ignored', () => {
  // Isolate the same validator used for crm.activity.get webhook processing.
  // This does not invoke any live REST, Sheets, email, or Render transport.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validateActivityRow = validateActivityRow;',
    context, { filename: 'sales.js' }
  );
  const validateActivityRow = context.module.exports.__validateActivityRow;
  const base = { ID: '9919971', OWNER_TYPE_ID: '2', OWNER_ID: '9919972' };

  for (const ownerType of ['2', 2, '3', 3]) {
    const row = { ...base, OWNER_TYPE_ID: ownerType };
    assert.equal(validateActivityRow(row, base.ID), row,
      'canonical deal and non-deal owner types retain their read-only behavior');
  }

  // OWNER_TYPE_ID is a Bitrix numeric enum. The event handler only resolves
  // the exact canonical value "2" as a deal. "02" currently passes validation
  // but is then classified as a non-deal and silently counted as ignored.
  for (const ownerType of ['02', '002', '03', '0003']) {
    assert.throws(
      () => validateActivityRow({ ...base, OWNER_TYPE_ID: ownerType }, base.ID),
      /Invalid Bitrix activity owner type/,
      'a malformed owner type must never silently suppress a valid deal event'
    );
  }
});

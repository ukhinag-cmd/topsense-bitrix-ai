'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// This is a source-only test. It never starts a server or contacts Bitrix,
// Sheets or Render. The test branch must be safe even when an operator uses
// npm's default start command instead of a custom Render start command.
test('Sales MVP default npm start selects the isolated read-only gateway', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.start, 'node sales-gateway.js',
    'npm start must not launch the legacy CRM server with write handlers');
  assert.equal(pkg.scripts?.['test:sales'], 'node --test sales-*.regression.test.js',
    'provide an isolated Sales regression gate while legacy tests remain red');
});

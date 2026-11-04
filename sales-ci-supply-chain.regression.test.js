'use strict';

// Offline supply-chain guard for the branch-only Sales CI. This source-level
// test does not start the server, resolve credentials, or contact any service.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('Sales-only CI pins reviewed actions and cannot deploy or receive credentials', () => {
  const workflow = readFileSync(join(__dirname, '.github/workflows/sales-mvp.yml'), 'utf8');
  assert.match(workflow, /^on:\s*\n  push:\s*\n    branches: \[sales-mvp\]\s*$/m,
    'Sales CI must run only on the test branch');
  assert.match(workflow, /^permissions:\s*\n  contents: read\s*$/m,
    'CI token must have read-only repository permissions');
  assert.match(workflow, /^\s+persist-credentials: false\s*$/m,
    'checkout must not leave any GitHub credential available to tests');

  // Verified GitHub v5 release refs (resolved through upstream git refs).
  // Review new immutable commit IDs explicitly when updating these actions.
  const actionRefs = [...workflow.matchAll(/^\s+- uses: ([^\r\n]+)/gm)]
    .map(match => match[1].replace(/\s+#.*$/, '').trim());
  assert.deepEqual(actionRefs, [
    'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
  ], 'only the reviewed, immutable checkout/setup-node revisions are permitted');
  assert.match(workflow, /^\s+node-version: '24'\s*$/m);

  const commands = [...workflow.matchAll(/^\s+- run: ([^\r\n]+)/gm)]
    .map(match => match[1].trim());
  assert.deepEqual(commands, ['npm run test:sales'],
    'CI must run only offline Sales tests; no dependency install, deploy or external scripts');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sales = require('./sales');

test('Dashboard discloses that stage-age Risk Score is based on CRM modification, not verified stage history', () => {
  const status = sales.status();
  assert.equal(status.scoringLimitations?.stageAgeEstimatedFromDateModify, true,
    'API consumers must not mistake stage age for an observed CRM stage transition date');

  const page = sales.html();
  assert.match(page, /возраст стадии оценивается по DATE_MODIFY/i);
  assert.match(page, /не по подтверждённой дате перехода/i);
  assert.match(page, /может занижать риск/i);
});

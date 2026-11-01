'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('initial CRM observation does not invent a won-transition or red-zone-entry alert', () => {
  // No external requests: test only the Sales notification logic in an isolated VM.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(source + '\nmodule.exports.__addAlert = addAlert;', context, { filename: 'sales.js' });
  const addAlert = context.module.exports.__addAlert;

  const historicalWin = {
    semantic: 'S', open: false, prospectScore: 85, riskScore: 0,
    amount: 500000, currency: 'RUB', hasNext: false,
    qualificationIssue: false, nextStep: 'Сделка завершена успешно',
  };
  const firstWinAlerts = addAlert(historicalWin, null);
  assert.equal(firstWinAlerts.some(alert => alert.type === 'success'), false,
    'first sight of an already won deal is not evidence of a new win');
  assert.equal(addAlert(historicalWin, { ...historicalWin, semantic: 'P' })
    .some(alert => alert.type === 'success'), true,
    'a verified open-to-won transition must still produce a win alert');

  const highRisk = {
    semantic: 'P', open: true, prospectScore: 45, riskScore: 75,
    amount: 250000, currency: 'RUB', hasNext: false,
    qualificationIssue: false, nextStep: 'Назначить следующее действие',
  };
  const firstRiskAlerts = addAlert(highRisk, null);
  assert.equal(firstRiskAlerts.some(alert => alert.type === 'risk'), false,
    'the first read cannot prove the deal just entered the red zone');
  assert.equal(firstRiskAlerts.some(alert => alert.title === 'Нет следующего действия'), true,
    'current missing-action warnings remain visible on first observation');
  assert.equal(addAlert(highRisk, { ...highRisk, riskScore: 45 })
    .some(alert => alert.type === 'risk'), true,
    'an observed threshold crossing must still trigger the risk alert');
});

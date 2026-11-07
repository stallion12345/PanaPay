process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import test from 'node:test';

import { limitAlarm, lowPoint, projectBalance, weeklyBuckets } from './forecast.js';

test('weeklyBuckets groups empty input without crashing', () => {
  const result = weeklyBuckets([], '2026-11-02T00:00:00.000Z', 4);
  assert.deepEqual(result, [
    { index: 0, label: 'Week 1', start: '2026-11-02T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z', in: 0, out: 0 },
    { index: 1, label: 'Week 2', start: '2026-11-09T00:00:00.000Z', end: '2026-11-16T00:00:00.000Z', in: 0, out: 0 },
    { index: 2, label: 'Week 3', start: '2026-11-16T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z', in: 0, out: 0 },
    { index: 3, label: 'Week 4', start: '2026-11-23T00:00:00.000Z', end: '2026-11-30T00:00:00.000Z', in: 0, out: 0 },
  ]);
});

test('weeklyBuckets groups money in and out by week', () => {
  const result = weeklyBuckets([
    { occurred_at: '2026-11-04T15:00:00.000Z', amount_cents: 2500, direction: 'in' },
    { occurred_at: '2026-11-05T15:00:00.000Z', amount_cents: 3000, direction: 'out' },
    { occurred_at: '2026-11-11T09:00:00.000Z', amount_cents: 6000, direction: 'in' },
    { occurred_at: '2026-11-18T15:00:00.000Z', amount_cents: 9000, direction: 'out' },
  ], '2026-11-02T00:00:00.000Z', 3);

  assert.equal(result[0].in, 2500);
  assert.equal(result[0].out, 3000);
  assert.equal(result[1].in, 6000);
  assert.equal(result[1].out, 0);
  assert.equal(result[2].in, 0);
  assert.equal(result[2].out, 9000);
});

test('weeklyBuckets ignores entries outside the requested range', () => {
  const result = weeklyBuckets([
    { occurred_at: '2026-10-30T00:00:00.000Z', amount_cents: 5000, direction: 'in' },
    { occurred_at: '2026-11-30T00:00:00.000Z', amount_cents: 4000, direction: 'in' },
  ], '2026-11-02T00:00:00.000Z', 4);

  assert.deepEqual(result.map((bucket) => ({ in: bucket.in, out: bucket.out })), [
    { in: 0, out: 0 },
    { in: 0, out: 0 },
    { in: 0, out: 0 },
    { in: 0, out: 0 },
  ]);
});

test('projectBalance runs the balance across weeks', () => {
  const result = projectBalance(10000, [
    { label: 'Week 1', in: 5000, out: 2000 },
    { label: 'Week 2', in: 4000, out: 7000 },
    { label: 'Week 3', in: 0, out: 1500 },
  ]);

  assert.equal(result[0].balance, 13000);
  assert.equal(result[1].balance, 10000);
  assert.equal(result[2].balance, 8500);
});

test('lowPoint reports the lowest projected balance', () => {
  const result = lowPoint(projectBalance(10000, [
    { label: 'Week 1', in: 5000, out: 2000 },
    { label: 'Week 2', in: 4000, out: 7000 },
    { label: 'Week 3', in: 0, out: 1500 },
  ]));

  assert.equal(result.label, 'Week 3');
  assert.equal(result.amount, 8500);
});

test('lowPoint returns zeroes for empty projection', () => {
  const result = lowPoint([]);
  assert.deepEqual(result, { weekIndex: 0, label: '', amount: 0 });
});

test('limitAlarm is ok below 80 percent', () => {
  const result = limitAlarm(6000, 10000);
  assert.equal(result.level, 'ok');
  assert.equal(result.percent, 60);
});

test('limitAlarm watches at exactly 80 percent', () => {
  const result = limitAlarm(8000, 10000);
  assert.equal(result.level, 'watch');
  assert.equal(result.percent, 80);
});

test('limitAlarm is over above 100 percent', () => {
  const result = limitAlarm(10001, 10000);
  assert.equal(result.level, 'over');
  assert.equal(result.percent, 100.01);
});

test('limitAlarm is watch at exactly 100 percent', () => {
  const result = limitAlarm(10000, 10000);
  assert.equal(result.level, 'watch');
  assert.equal(result.percent, 100);
});

test('limitAlarm handles zero limit safely', () => {
  const result = limitAlarm(0, 0);
  assert.equal(result.level, 'ok');
  assert.equal(result.percent, 0);
});

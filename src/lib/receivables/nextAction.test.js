import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextAction, pickPromise, formatDateKey, formatMoneyCents } from './nextAction.js';

const promise = { status: 'open', promised_date: '2026-11-04' };

test('paid and paid_late need no action', () => {
  assert.equal(computeNextAction({ status: 'paid' }).key, 'none');
  const late = computeNextAction({ status: 'paid_late' });
  assert.equal(late.key, 'none');
  assert.equal(late.draftable, false);
});

test('broken promise gets a firm reminder that names the promised date', () => {
  const a = computeNextAction({ status: 'broken_promise', daysLate: 9, owedCents: 16000, promise });
  assert.equal(a.key, 'firm_reminder');
  assert.equal(a.tone, 'firm');
  assert.equal(a.draftable, true);
  assert.match(a.reason, /Nov 4/);
});

test('overdue under 7 days is friendly, 7 or more is firm', () => {
  assert.equal(computeNextAction({ status: 'overdue', daysLate: 6, owedCents: 5000 }).key, 'friendly_reminder');
  assert.equal(computeNextAction({ status: 'overdue', daysLate: 7, owedCents: 5000 }).key, 'firm_reminder');
});

test('overdue by one day uses the singular', () => {
  assert.match(computeNextAction({ status: 'overdue', daysLate: 1, owedCents: 5000 }).reason, /^1 day past due/);
});

test('history label is used as evidence in the reason', () => {
  const onTime = computeNextAction({ status: 'overdue', daysLate: 2, owedCents: 5000, label: 'Usually on time' });
  assert.match(onTime.reason, /oversight/);
  const lateLabel = computeNextAction({ status: 'overdue', daysLate: 2, owedCents: 5000, label: 'Usually late' });
  assert.match(lateLabel.reason, /Usually pays late/);
});

test('due today gets a friendly reminder', () => {
  const a = computeNextAction({ status: 'due_today', owedCents: 18000 });
  assert.equal(a.key, 'friendly_reminder');
  assert.equal(a.tone, 'friendly');
});

test('partially paid asks for the balance and shows the amount still owed', () => {
  const a = computeNextAction({ status: 'partially_paid', daysLate: 0, owedCents: 12000 });
  assert.equal(a.key, 'ask_balance');
  assert.match(a.reason, /\$120\.00/);
});

test('a promised invoice means wait, with no draft', () => {
  const a = computeNextAction({ status: 'promised', owedCents: 5000, promise: { status: 'open', promised_date: '2026-11-13' } });
  assert.equal(a.key, 'wait');
  assert.equal(a.title, 'Wait until Nov 13');
  assert.equal(a.draftable, false);
});

test('an issued invoice that is not due has nothing to do', () => {
  assert.equal(computeNextAction({ status: 'issued', owedCents: 5000 }).key, 'none');
});

test('amounts above $500 go to the owner, even when overdue', () => {
  const a = computeNextAction({ status: 'overdue', daysLate: 10, owedCents: 50001 });
  assert.equal(a.key, 'owner_review');
  assert.equal(a.draftable, false);
  assert.equal(computeNextAction({ status: 'overdue', daysLate: 10, owedCents: 50000 }).key, 'firm_reminder');
});

test('pickPromise takes the open promise with the latest date and ignores others', () => {
  const picked = pickPromise([
    { status: 'open', promised_date: '2026-11-04' },
    { status: 'open', promised_date: '2026-11-13' },
    { status: 'unconfirmed', promised_date: '2026-12-01' },
    { status: 'broken', promised_date: '2026-12-02' },
    { status: 'open', promised_date: null },
  ]);
  assert.equal(picked.promised_date, '2026-11-13');
  assert.equal(pickPromise([]), null);
});

test('date and money formatting never shift timezones', () => {
  assert.equal(formatDateKey('2026-11-01'), 'Nov 1');
  assert.equal(formatDateKey('2026-12-31T23:59:00.000Z'), 'Dec 31');
  assert.equal(formatDateKey(null), '');
  assert.equal(formatMoneyCents(160000), '$1,600.00');
});

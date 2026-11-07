process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import test from 'node:test';

import { derive, getStatusReasonLabel } from './status.js';

function invoice(overrides = {}) {
  return {
    amount_cents: 10000,
    paid_cents: 0,
    due_at: '2026-11-05T00:00:00-06:00',
    paid_at: null,
    ...overrides,
  };
}

function promise(overrides = {}) {
  return {
    status: 'open',
    promised_date: '2026-11-06',
    created_at: '2026-11-01T12:00:00-06:00',
    ...overrides,
  };
}

test('paid in full before due date is paid', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 10000, paid_at: '2026-11-04T12:00:00-06:00', due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-04T12:00:00-06:00',
  });

  assert.equal(result.status, 'paid');
  assert.equal(result.reason, null);
});

test('paid in full on the due date is paid', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 10000, paid_at: '2026-11-05T00:00:00-06:00', due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'paid');
});

test('paid exactly one second after local midnight in Chicago is paid_late', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 10000, paid_at: '2026-11-06T00:00:01-06:00', due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-06T00:00:02-06:00',
  });

  assert.equal(result.status, 'paid_late');
});

test('DST fallback day in Chicago verifies the offset change before comparing paid dates', () => {
  const beforeFallback = new Date('2026-11-01T01:30:00-05:00');
  const afterFallback = new Date('2026-11-01T01:30:00-06:00');
  const beforeOffset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  }).formatToParts(beforeFallback).find((part) => part.type === 'timeZoneName')?.value;
  const afterOffset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  }).formatToParts(afterFallback).find((part) => part.type === 'timeZoneName')?.value;

  assert.equal(beforeOffset, 'GMT-5');
  assert.equal(afterOffset, 'GMT-6');

  const result = derive({
    invoice: invoice({
      paid_cents: 10000,
      due_at: '2026-11-01T00:00:00-05:00',
      paid_at: '2026-11-01T01:30:00-06:00',
    }),
    promises: [],
    now: '2026-11-01T02:00:00-06:00',
  });

  assert.equal(result.status, 'paid');
});

test('paid in full after due date is paid_late', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 10000, paid_at: '2026-11-06T09:00:00-06:00', due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-06T09:30:00-06:00',
  });

  assert.equal(result.status, 'paid_late');
});

test('partial payment status wins before promise and due rules', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 4000, due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [promise({ status: 'open', promised_date: '2026-11-06' })],
    now: '2026-11-04T10:00:00-06:00',
  });

  assert.equal(result.status, 'partially_paid');
});

test('future open promise makes unpaid invoice promised', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-15T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-12', status: 'open' })],
    now: '2026-11-04T10:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('open promise due today is promised', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-05', status: 'open' })],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('past due open promise is broken_promise', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-15T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-03', status: 'open' })],
    now: '2026-11-04T10:00:00-06:00',
  });

  assert.equal(result.status, 'broken_promise');
});

test('most recent future promise wins among multiple open promises', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-20T00:00:00-06:00' }),
    promises: [
      promise({ promised_date: '2026-11-08', status: 'open', created_at: '2026-11-01T09:00:00-06:00' }),
      promise({ promised_date: '2026-11-12', status: 'open', created_at: '2026-11-02T09:00:00-06:00' }),
    ],
    now: '2026-11-04T12:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('most recent past promise wins among multiple open promises', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-20T00:00:00-06:00' }),
    promises: [
      promise({ promised_date: '2026-11-02', status: 'open', created_at: '2026-11-01T09:00:00-06:00' }),
      promise({ promised_date: '2026-11-01', status: 'open', created_at: '2026-11-02T09:00:00-06:00' }),
    ],
    now: '2026-11-04T12:00:00-06:00',
  });

  assert.equal(result.status, 'broken_promise');
});

test('due today and unpaid is due_today', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'due_today');
});

test('due yesterday and unpaid is overdue', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-04T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'overdue');
});

test('future due date and unpaid is issued', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-06T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('unpaid invoice with no due date is issued with a no_due_date reason', () => {
  const result = derive({
    invoice: invoice({ due_at: null }),
    promises: [],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
  assert.equal(result.reason, 'no_due_date');
  assert.equal(getStatusReasonLabel(result), 'No due date');
});

test('non-no_due_date results keep the reason unset for the UI', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-06T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T08:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
  assert.equal(result.reason, null);
  assert.equal(getStatusReasonLabel(result), null);
});

test('midnight edge: due date is in the future before midnight in Chicago', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-06T00:30:00-06:00' }),
    promises: [],
    now: '2026-11-05T23:45:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('midnight edge: due date is today after midnight in Chicago', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-06T00:15:00-06:00' }),
    promises: [],
    now: '2026-11-06T00:30:00-06:00',
  });

  assert.equal(result.status, 'due_today');
});

test('midnight edge: after midnight but still previous day in Chicago is not due today', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-06T00:15:00-06:00' }),
    promises: [],
    now: '2026-11-05T23:30:00Z',
  });

  assert.equal(result.status, 'issued');
});

test('paid_at exactly equal to due_at in Chicago calendar day is still paid', () => {
  const result = derive({
    invoice: invoice({
      paid_cents: 10000,
      due_at: '2026-11-05T00:00:00-06:00',
      paid_at: '2026-11-05T23:59:00-06:00',
    }),
    promises: [],
    now: '2026-11-05T23:59:00-06:00',
  });

  assert.equal(result.status, 'paid');
});

test('paid_at one day after due date is paid_late even if same UTC instant', () => {
  const result = derive({
    invoice: invoice({
      paid_cents: 10000,
      due_at: '2026-11-05T00:00:00-06:00',
      paid_at: '2026-11-06T00:05:00-06:00',
    }),
    promises: [],
    now: '2026-11-06T00:10:00-06:00',
  });

  assert.equal(result.status, 'paid_late');
});

test('unconfirmed promises are ignored', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-20T00:00:00-06:00' }),
    promises: [promise({ status: 'unconfirmed', promised_date: '2026-11-21' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('kept promises are ignored when selecting open promise status', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-20T00:00:00-06:00' }),
    promises: [promise({ status: 'kept', promised_date: '2026-11-21' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('an invalid open promise date is ignored', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [promise({ status: 'open', promised_date: 'not-a-date' })],
    now: '2026-11-04T10:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('open promise with same-day date and due date future still resolves to promised', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-10T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-05', status: 'open' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('paid exactly 0 and due in future is issued', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 0, due_at: '2026-11-12T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'issued');
});

test('fully paid invoice with no paid_at still resolves to paid', () => {
  const result = derive({
    invoice: invoice({ paid_cents: 10000, paid_at: null, due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'paid');
});

test('open promise from prior day but due date is also previous day results in broken_promise', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-04T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-03', status: 'open' })],
    now: '2026-11-04T12:00:00-06:00',
  });

  assert.equal(result.status, 'broken_promise');
});

test('open promise in the future beats a due_today state', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-05T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-06', status: 'open' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('today is computed in America/Chicago, not UTC', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-05T00:30:00-06:00' }),
    promises: [],
    now: '2026-11-05T06:30:00Z',
  });

  assert.equal(result.status, 'due_today');
});

test('a promise exactly on today still counts as promised', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-08T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-05', status: 'open' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('a promise one day after today is promised when due is later', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-10T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-06', status: 'open' })],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

test('promise dated today in Chicago is promised regardless of time of day', () => {
  const result = derive({
    invoice: invoice({ due_at: '2026-11-10T00:00:00-06:00' }),
    promises: [promise({ promised_date: '2026-11-05T23:00:00-06:00', status: 'open' })],
    now: '2026-11-05T00:15:00-06:00',
  });

  assert.equal(result.status, 'promised');
});

process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProfile } from './profile.js';

test('zero invoices returns empty profile with no history', () => {
  const profile = buildProfile({ invoices: [], promises: [], payments: [], now: '2026-11-05T12:00:00-06:00' });

  assert.deepEqual(profile, {
    invoiceCount: 0,
    totalInvoicedCents: 0,
    totalPaidCents: 0,
    outstandingCents: 0,
    paidLateCount: 0,
    avgDaysLate: 0,
    promisesMade: 0,
    promisesKept: 0,
    promisesBroken: 0,
    usualMethod: null,
    enoughHistory: false,
    label: null,
    evidence: ['No invoice history yet. Based on 0 invoices.'],
  });
});

test('one invoice does not reach enoughHistory', () => {
  const profile = buildProfile({
    invoices: [{ amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-03T00:00:00-06:00' }],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.invoiceCount, 1);
  assert.equal(profile.enoughHistory, false);
  assert.equal(profile.label, null);
});

test('three paid-on-time invoices count as enoughHistory and label usually on time', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-01T10:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-02T11:00:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T17:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.enoughHistory, true);
  assert.equal(profile.label, 'Usually on time');
  assert.equal(profile.paidLateCount, 0);
  assert.equal(profile.avgDaysLate, 0);
  assert.equal(profile.totalPaidCents, 37000);
});

test('three invoices with two late payments produce Usually late label', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-04T00:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-05T00:00:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T12:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.enoughHistory, true);
  assert.equal(profile.paidLateCount, 2);
  assert.equal(profile.avgDaysLate, 3);
  assert.equal(profile.label, 'Usually late');
  assert.equal(profile.evidence[0].includes('Paid 2 of 3 invoices late'), true);
});

test('three invoices with one late and two on time produce Mixed label', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-01T10:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-06T00:00:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T17:00:00-06:00' },
    ],
    now: '2026-11-07T12:00:00-06:00',
  });

  assert.equal(profile.label, 'Mixed');
  assert.equal(profile.paidLateCount, 1);
  assert.equal(profile.avgDaysLate, 4);
});

test('outstanding cents are invoiced minus total paid', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 4000 },
      { amount_cents: 20000, paid_cents: 20000 },
      { amount_cents: 5000, paid_cents: 0 },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.totalInvoicedCents, 35000);
  assert.equal(profile.totalPaidCents, 24000);
  assert.equal(profile.outstandingCents, 11000);
});

test('overdue unpaid invoices count toward enoughHistory even before payment', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 0, due_at: '2026-11-01T00:00:00-06:00' },
      { amount_cents: 11000, paid_cents: 0, due_at: '2026-11-02T00:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 0, due_at: '2026-11-03T00:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.enoughHistory, true);
  assert.equal(profile.label, 'Usually on time');
});

test('promise counts are computed from actual promise statuses and ignore unconfirmed', () => {
  const profile = buildProfile({
    invoices: [{ amount_cents: 10000, paid_cents: 0, due_at: '2026-11-10T00:00:00-06:00' }],
    promises: [
      { status: 'open' },
      { status: 'kept' },
      { status: 'broken' },
      { status: 'broken' },
      { status: 'unconfirmed' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.promisesMade, 4);
  assert.equal(profile.promisesKept, 1);
  assert.equal(profile.promisesBroken, 2);
});

test('usualMethod comes from actual payments only', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-01T12:00:00-06:00' },
      { amount_cents: 20000, paid_cents: 20000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-03T12:00:00-06:00' },
    ],
    promises: [{ method: 'cash' }],
    payments: [
      { method: 'bank_transfer' },
      { method: 'bank_transfer' },
      { method: 'paypal' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.usualMethod, 'bank_transfer');
});

test('when no actual payment methods exist, usualMethod is null', () => {
  const profile = buildProfile({
    invoices: [{ amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-04T00:00:00-06:00' }],
    payments: [],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.usualMethod, null);
});

test('late days are computed using the Chicago day boundary, not raw timestamps', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-02T00:30:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-03T00:30:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T12:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.paidLateCount, 2);
  assert.equal(profile.avgDaysLate, 1);
});

test('exactly three qualifying invoices turns enoughHistory on', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-04T00:00:00-06:00' },
      { amount_cents: 11000, paid_cents: 11000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-03T00:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 0, due_at: '2026-11-05T00:00:00-06:00' },
    ],
    now: '2026-11-06T12:00:00-06:00',
  });

  assert.equal(profile.enoughHistory, true);
  assert.equal(profile.label, 'Usually late');
});

test('evidence uses the sample count and wording template', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 10000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-04T00:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-05T00:00:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T12:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.evidence[0], 'Paid 2 of 3 invoices late, 3 days late on average. Based on 3 invoices.');
});

test('partially paid invoices do not count as paid late', () => {
  const profile = buildProfile({
    invoices: [
      { amount_cents: 10000, paid_cents: 5000, due_at: '2026-11-01T00:00:00-06:00', paid_at: '2026-11-04T00:00:00-06:00' },
      { amount_cents: 12000, paid_cents: 12000, due_at: '2026-11-02T00:00:00-06:00', paid_at: '2026-11-03T00:00:00-06:00' },
      { amount_cents: 15000, paid_cents: 15000, due_at: '2026-11-03T00:00:00-06:00', paid_at: '2026-11-03T12:00:00-06:00' },
    ],
    now: '2026-11-05T12:00:00-06:00',
  });

  assert.equal(profile.paidLateCount, 1);
  assert.equal(profile.label, 'Mixed');
});

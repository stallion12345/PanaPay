import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

const { db, initializeDb } = await import('./db.js');

initializeDb();

test('schema exists and duplicate webhook event ids fail', { concurrency: false }, () => {
  const merchantId = 101;
  const eventId = 'evt-duplicate-test';

  db.prepare('DELETE FROM webhook_event WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM merchant WHERE id = ?').run(merchantId);

  db.prepare('INSERT INTO merchant (id, name, weekly_spend_limit, currency) VALUES (?, ?, ?, ?)').run(
    merchantId,
    'Test Merchant',
    25000,
    'USD',
  );

  db.prepare(
    'INSERT INTO webhook_event (id, event_id, event_type, payload, signature_status, merchant_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('wh-1', eventId, 'PAYMENT.SALE.COMPLETED', '{"ok":true}', 'SUCCESS', merchantId);

  assert.throws(() => {
    db.prepare(
      'INSERT INTO webhook_event (id, event_id, event_type, payload, signature_status, merchant_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('wh-2', eventId, 'PAYMENT.SALE.COMPLETED', '{"ok":true}', 'SUCCESS', merchantId);
  }, /UNIQUE|constraint|duplicate/i);
});

test('invoice and promise CHECK constraints reject invalid enum values', { concurrency: false }, () => {
  const merchantId = 102;
  const customerId = 205;

  db.prepare('DELETE FROM promise WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM customer_note WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM action_log WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM invoice WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM customer WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM merchant WHERE id = ?').run(merchantId);

  db.prepare('INSERT INTO merchant (id, name, weekly_spend_limit, currency) VALUES (?, ?, ?, ?)').run(
    merchantId,
    'Check Merchant',
    5000,
    'USD',
  );
  db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)').run(
    customerId,
    merchantId,
    'Invoice Checker',
    'checker@example.com',
    'checker@paypal.com',
  );

  assert.throws(() => {
    db.prepare(
      'INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      301,
      merchantId,
      customerId,
      'inv-check-bad',
      1000,
      'USD',
      '2025-01-01T00:00:00Z',
      '2025-01-15T00:00:00Z',
      0,
      'staging',
    );
  }, /CHECK|constraint|source/i);

  assert.throws(() => {
    db.prepare(
      'INSERT INTO promise (id, merchant_id, customer_id, invoice_id, reason, promised_date, promised_cents, method, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      401,
      merchantId,
      customerId,
      null,
      'Need follow-up',
      '2025-01-10',
      1000,
      'email',
      0.9,
      'lost',
      '2025-01-02T00:00:00Z',
    );
  }, /CHECK|constraint|status/i);
});

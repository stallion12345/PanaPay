import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'client-test';
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || 'secret-test';
process.env.PAYPAL_MERCHANT_EMAIL = process.env.PAYPAL_MERCHANT_EMAIL || 'merchant@example.com';
process.env.PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || 'webhook-test-id';

const { app } = await import('./server.js');
const { db, ensureDefaultMerchant } = await import('./db.js');

async function listenOnApp() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, port };
}

function resetAll(merchantId = 1) {
  db.prepare('DELETE FROM customer_note WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM promise WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM invoice WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM customer WHERE merchant_id = ?').run(merchantId);
}

function insertCustomer(id, merchantId, name, email, paypalEmail) {
  db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(id, merchantId, name, email, paypalEmail);
}

function insertInvoice(id, merchantId, customerId, paypalInvoiceId, amountCents, currency, issuedAt, dueAt, paidCents, paidAt, source) {
  db.prepare(`
    INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, merchantId, customerId, paypalInvoiceId, amountCents, currency, issuedAt, dueAt, paidCents, paidAt, source);
}

function insertPromise(id, merchantId, customerId, invoiceId, promisedDate, status, confidence) {
  db.prepare(`
    INSERT INTO promise (id, merchant_id, customer_id, invoice_id, promised_date, status, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, merchantId, customerId, invoiceId, promisedDate, status, confidence ?? null, new Date().toISOString());
}

function insertNote(id, merchantId, customerId, invoiceId, text) {
  db.prepare(`
    INSERT INTO customer_note (id, merchant_id, customer_id, invoice_id, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, merchantId, customerId, invoiceId, text, new Date().toISOString());
}

async function post(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

function seedOverdueInvoiceWithPromise(promiseStatus) {
  ensureDefaultMerchant();
  resetAll();
  insertCustomer(101, 1, 'Test Customer', 'test@example.com', 'test@paypal.com');
  // Due long ago and unpaid: overdue unless an open promise exists.
  insertInvoice(1, 1, 101, 'INV-PROMISE-TEST', 16000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  // A far-future date keeps the invoice "promised" once the promise is open.
  insertPromise(401, 1, 101, 1, '2099-01-01', promiseStatus, 0.5);
}

test('confirming an unconfirmed promise makes it open and the invoice promised', async () => {
  seedOverdueInvoiceWithPromise('unconfirmed');
  const { server, port } = await listenOnApp();
  try {
    const before = await fetch(`http://127.0.0.1:${port}/api/receivables`).then((r) => r.json());
    assert.equal(before.invoices.find((i) => i.invoiceId === 1).status, 'overdue');

    const res = await post(port, '/api/promises/401/confirm');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.invoice.status, 'promised');

    const row = db.prepare('SELECT status FROM promise WHERE id = 401').get();
    assert.equal(row.status, 'open');
  } finally {
    server.close();
  }
});

test('confirming a promise that is already open returns 409 and changes nothing', async () => {
  seedOverdueInvoiceWithPromise('open');
  const { server, port } = await listenOnApp();
  try {
    const res = await post(port, '/api/promises/401/confirm');
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.equal(db.prepare('SELECT status FROM promise WHERE id = 401').get().status, 'open');
  } finally {
    server.close();
  }
});

test('rejecting an unconfirmed promise deletes it but keeps the customer note', async () => {
  seedOverdueInvoiceWithPromise('unconfirmed');
  insertNote(1, 1, 101, 1, 'My cousin will send the money on Friday');
  const { server, port } = await listenOnApp();
  try {
    const res = await post(port, '/api/promises/401/reject');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM promise WHERE id = 401').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_note WHERE id = 1').get().n, 1);
  } finally {
    server.close();
  }
});

test('rejecting a promise that is already open returns 409 and keeps it', async () => {
  seedOverdueInvoiceWithPromise('open');
  const { server, port } = await listenOnApp();
  try {
    const res = await post(port, '/api/promises/401/reject');
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM promise WHERE id = 401').get().n, 1);
  } finally {
    server.close();
  }
});

test('an unknown promise id returns 404 for both confirm and reject', async () => {
  seedOverdueInvoiceWithPromise('unconfirmed');
  const { server, port } = await listenOnApp();
  try {
    assert.equal((await post(port, '/api/promises/99999/confirm')).status, 404);
    assert.equal((await post(port, '/api/promises/99999/reject')).status, 404);
  } finally {
    server.close();
  }
});

test('a non-numeric promise id is rejected cleanly and never touches data', async () => {
  seedOverdueInvoiceWithPromise('unconfirmed');
  const { server, port } = await listenOnApp();
  try {
    const res = await post(port, '/api/promises/abc/confirm');
    assert.ok(res.status === 404 || res.status === 400, `expected 400 or 404, got ${res.status}`);
    assert.equal(db.prepare('SELECT status FROM promise WHERE id = 401').get().status, 'unconfirmed');
  } finally {
    server.close();
  }
});

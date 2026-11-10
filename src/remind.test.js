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

async function postJson(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const GOOD_DRAFT = 'Hi Test, your payment of $160.00 was due on Oct 1. Please pay today, or reply with the date you can pay.';

function setup({ source = 'live', paypalId = 'INV2-TEST-0001', paidCents = 0, paidAt = null } = {}) {
  ensureDefaultMerchant();
  resetAll();
  insertCustomer(101, 1, 'Test Customer', 'test@example.com', 'test@paypal.com');
  insertInvoice(1, 1, 101, paypalId, 16000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', paidCents, paidAt, source);
  const calls = [];
  app.locals.remindInvoice = async (invoiceId, options) => {
    calls.push({ invoiceId, options });
    return { ok: true };
  };
  return calls;
}

function cleanup() {
  delete app.locals.remindInvoice;
}

test('a live overdue invoice sends the reviewed draft through PayPal and records a note', async () => {
  const calls = setup();
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/1/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].invoiceId, 'INV2-TEST-0001');
    assert.equal(calls[0].options.note, GOOD_DRAFT);
    assert.ok(calls[0].options.subject.startsWith('Payment reminder from'));

    const note = db.prepare('SELECT text FROM customer_note WHERE invoice_id = 1').get();
    assert.ok(note.text.startsWith('Reminder sent via PayPal:'));
    assert.ok(note.text.includes(GOOD_DRAFT));
  } finally {
    cleanup();
    server.close();
  }
});

test('a seeded invoice is refused because it does not exist in PayPal', async () => {
  const calls = setup({ source: 'seeded', paypalId: 'SEED-TEST-0001' });
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/1/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
    server.close();
  }
});

test('a paid invoice is refused', async () => {
  const calls = setup({ paidCents: 16000, paidAt: '2026-10-05T12:00:00.000Z' });
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/1/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
    server.close();
  }
});

test('drafts with a link, a wrong amount, or no text are refused and never sent', async () => {
  const calls = setup();
  const { server, port } = await listenOnApp();
  try {
    const withLink = await postJson(port, '/api/invoices/1/remind', {
      draft: 'Please pay $160.00 at https://example.com/pay today.',
    });
    assert.equal(withLink.status, 400);

    const wrongAmount = await postJson(port, '/api/invoices/1/remind', {
      draft: 'Hi, please pay $999.00 today.',
    });
    assert.equal(wrongAmount.status, 400);

    const empty = await postJson(port, '/api/invoices/1/remind', { draft: '   ' });
    assert.equal(empty.status, 400);

    const missing = await postJson(port, '/api/invoices/1/remind', {});
    assert.equal(missing.status, 400);

    assert.equal(calls.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_note').get().n, 0);
  } finally {
    cleanup();
    server.close();
  }
});

test('an unknown invoice returns 404', async () => {
  setup();
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/99999/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 404);
  } finally {
    cleanup();
    server.close();
  }
});

test('PayPal rate limit (429) is reported clearly and records no note', async () => {
  setup();
  app.locals.remindInvoice = async () => {
    const error = new Error('limit');
    error.status = 429;
    throw error;
  };
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/1/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 429);
    assert.equal(res.body.ok, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_note').get().n, 0);
  } finally {
    cleanup();
    server.close();
  }
});

test('any other PayPal failure returns 502 and records no note', async () => {
  setup();
  app.locals.remindInvoice = async () => {
    throw new Error('PayPal exploded');
  };
  const { server, port } = await listenOnApp();
  try {
    const res = await postJson(port, '/api/invoices/1/remind', { draft: GOOD_DRAFT });
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_note').get().n, 0);
  } finally {
    cleanup();
    server.close();
  }
});

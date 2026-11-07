import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'client-test';
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || 'secret-test';
process.env.PAYPAL_MERCHANT_EMAIL = process.env.PAYPAL_MERCHANT_EMAIL || 'merchant@example.com';
process.env.PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || 'webhook-test-id';

const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/invoice-paid.json', import.meta.url), 'utf8'));
const { app, validateSupplierPayoutRequest, handleWebhook } = await import('./server.js');
const { db, ensureDefaultMerchant } = await import('./db.js');

function stubPayPalSignatureVerification() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url || '');
    if (target.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (target.includes('/v1/notifications/verify-webhook-signature')) {
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in test: ${target}`);
  };

  return () => { globalThis.fetch = originalFetch; };
}

function resetInvoiceFixtures(merchantId = 1) {
  db.prepare('DELETE FROM invoice_payment WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM promise WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM action_log WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM customer_note WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM invoice WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM customer WHERE merchant_id = ?').run(merchantId);
  db.prepare('DELETE FROM webhook_event WHERE merchant_id = ?').run(merchantId);
}

test('validateSupplierPayoutRequest rejects invalid supplier and amount values', () => {
  ensureDefaultMerchant();

  const supplierId = 'supplier-guard-test';
  db.prepare('DELETE FROM payout WHERE party_id = ?').run(supplierId);
  db.prepare('DELETE FROM party WHERE id = ?').run(supplierId);
  db.prepare('INSERT OR REPLACE INTO party (id, merchant_id, type, name, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(supplierId, 1, 'supplier', 'Guard Supplier', 'guard@example.com');

  const missingParty = validateSupplierPayoutRequest({ partyId: 'missing-party', amountCents: 2500, now: Date.now() });
  assert.equal(missingParty.ok, false);
  assert.match(missingParty.message, /supplier/i);

  const tooSmall = validateSupplierPayoutRequest({ partyId: supplierId, amountCents: 0, now: Date.now() });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.message, /amount/i);

  const tooLarge = validateSupplierPayoutRequest({ partyId: supplierId, amountCents: 100001, now: Date.now() });
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.message, /amount/i);

  db.prepare('DELETE FROM party WHERE id = ?').run(supplierId);
});

test('validateSupplierPayoutRequest rejects a duplicate payout within 60 seconds', () => {
  ensureDefaultMerchant();

  const supplierId = 'supplier-guard-test-duplicate';
  db.prepare('DELETE FROM payout WHERE party_id = ?').run(supplierId);
  db.prepare('DELETE FROM party WHERE id = ?').run(supplierId);
  db.prepare('INSERT OR REPLACE INTO party (id, merchant_id, type, name, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(supplierId, 1, 'supplier', 'Duplicate Supplier', 'duplicate@example.com');

  db.prepare(`
    INSERT INTO payout (id, merchant_id, party_id, amount_cents, batch_id, item_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('payout-guard-duplicate', 1, supplierId, 2500, 'batch-guard-duplicate', 'item-guard-duplicate', 'pending', new Date().toISOString());

  const duplicate = validateSupplierPayoutRequest({ partyId: supplierId, amountCents: 2500, now: Date.now() });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /already sent recently|wait a minute/i);

  db.prepare('DELETE FROM payout WHERE id = ?').run('payout-guard-duplicate');
  db.prepare('DELETE FROM party WHERE id = ?').run(supplierId);
});

test('handleWebhook processes the real invoice paid fixture and resolves the promise', async () => {
  const restoreFetch = stubPayPalSignatureVerification();

  try {
    ensureDefaultMerchant();
    resetInvoiceFixtures();

    db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
      .run(1001, 1, 'Test Customer', 'customer@example.com', 'customer@paypal.com');

    db.prepare(`
      INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      5001,
      1,
      1001,
      'INV2-4LAY-5LDV-7LXE-HA4A',
      2500,
      'USD',
      '2026-11-04T00:00:00Z',
      '2026-11-05T00:00:00Z',
      0,
      null,
      'live',
    );

    db.prepare(`
      INSERT INTO promise (id, merchant_id, customer_id, invoice_id, note_id, reason, promised_date, promised_cents, method, confidence, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7001,
      1,
      1001,
      5001,
      null,
      'Follow up on payment',
      '2026-11-05',
      2500,
      'email',
      0.95,
      'open',
      '2026-11-04T00:00:00Z',
    );

    const result = await handleWebhook(Buffer.from(JSON.stringify(fixture)), {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': '2026-11-05T00:17:17Z',
    });

    assert.equal(result.action, 'invoice payment processed');

    const invoiceRow = db.prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?').get(5001, 1);
    assert.equal(invoiceRow.paid_cents, 2500);
    assert.equal(invoiceRow.paid_at, fixture.create_time);

    const promiseRow = db.prepare('SELECT * FROM promise WHERE id = ?').get(7001);
    assert.equal(promiseRow.status, 'kept');
  } finally {
    restoreFetch();
  }
});

test('handleWebhook ignores pending payment events and leaves invoice unchanged', async () => {
  const restoreFetch = stubPayPalSignatureVerification();

  try {
    ensureDefaultMerchant();
    resetInvoiceFixtures();

    db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
      .run(1002, 1, 'Pending Customer', 'pending@example.com', 'pending@paypal.com');

    db.prepare(`
      INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      5002,
      1,
      1002,
      'INV-PENDING-TEST',
      2500,
      'USD',
      '2026-11-04T00:00:00Z',
      '2026-11-05T00:00:00Z',
      0,
      null,
      'live',
    );

    const pendingEvent = JSON.parse(JSON.stringify(fixture));
    pendingEvent.id = 'evt-pending-test';
    pendingEvent.create_time = '2026-11-05T00:17:17.890Z';
    pendingEvent.resource.invoice.id = 'INV-PENDING-TEST';
    pendingEvent.resource.invoice.payments.transactions = [
      {
        payment_id: 'PAY-RETRY-1',
        transaction_status: 'PENDING',
        amount: { currency_code: 'USD', value: '25.00' },
      },
    ];

    const result = await handleWebhook(Buffer.from(JSON.stringify(pendingEvent)), {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'tx-2',
      'paypal-transmission-sig': 'sig-2',
      'paypal-transmission-time': '2026-11-05T00:17:17Z',
    });

    assert.equal(result.action, 'ignored');
    const invoiceRow = db.prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?').get(5002, 1);
    assert.equal(invoiceRow.paid_cents, 0);
    assert.equal(invoiceRow.paid_at, null);
  } finally {
    restoreFetch();
  }
});

test('handleWebhook recomputes partial payments and ignores duplicate events', async () => {
  const restoreFetch = stubPayPalSignatureVerification();

  try {
    ensureDefaultMerchant();
    resetInvoiceFixtures();

    db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
      .run(1003, 1, 'Partial Customer', 'partial@example.com', 'partial@paypal.com');

    db.prepare(`
      INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      5003,
      1,
      1003,
      'INV-PARTIAL-TEST',
      2500,
      'USD',
      '2026-11-04T00:00:00Z',
      '2026-11-05T00:00:00Z',
      0,
      null,
      'live',
    );

    const partialEvent = JSON.parse(JSON.stringify(fixture));
    partialEvent.id = 'evt-partial-test';
    partialEvent.create_time = '2026-11-05T00:17:17.890Z';
    partialEvent.resource.invoice.id = 'INV-PARTIAL-TEST';
    partialEvent.resource.invoice.status = 'PARTIALLY_PAID';
    partialEvent.resource.invoice.payments.transactions = [
      {
        payment_id: 'PAY-PARTIAL-1',
        transaction_status: 'SUCCESS',
        amount: { currency_code: 'USD', value: '12.50' },
      },
      {
        payment_id: 'PAY-PARTIAL-2',
        transaction_status: 'FAILED',
        amount: { currency_code: 'USD', value: '5.00' },
      },
    ];

    const firstResult = await handleWebhook(Buffer.from(JSON.stringify(partialEvent)), {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'tx-3',
      'paypal-transmission-sig': 'sig-3',
      'paypal-transmission-time': '2026-11-05T00:17:17Z',
    });

    assert.equal(firstResult.action, 'invoice payment processed');
    const afterFirst = db.prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?').get(5003, 1);
    assert.equal(afterFirst.paid_cents, 1250);
    assert.equal(afterFirst.paid_at, null);

    const secondResult = await handleWebhook(Buffer.from(JSON.stringify(partialEvent)), {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'tx-4',
      'paypal-transmission-sig': 'sig-4',
      'paypal-transmission-time': '2026-11-05T00:17:17Z',
    });

    assert.equal(secondResult.action, 'duplicate ignored');
    const row = db.prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?').get(5003, 1);
    assert.equal(row.paid_cents, 1250);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_event WHERE event_id = ?').get(partialEvent.id).count, 1);
  } finally {
    restoreFetch();
  }
});

async function listenOnApp() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, port };
}

test('POST /api/invoices validates customer, amount, and due date', async () => {
  ensureDefaultMerchant();
  resetInvoiceFixtures();

  const customerId = 1111;
  db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(customerId, 1, 'Invoice Customer', 'invoice.customer@example.com', 'invoice.customer@paypal.com');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url || '');
    if (/^https?:\/\/127\.0\.0\.1:|^https?:\/\/localhost:/.test(target)) {
      return originalFetch(url, init);
    }

    if (target.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch during validation test: ${target}`);
  };

  try {
    const { server, port } = await listenOnApp();
    try {
      const invalidCustomer = await fetch(`http://127.0.0.1:${port}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: 99999, amountCents: 2500, dueDate: '2030-01-10', description: 'Bad customer' }),
      });
      assert.equal(invalidCustomer.status, 400);
      const invalidCustomerBody = await invalidCustomer.json();
      assert.match(invalidCustomerBody.error, /customer/i);

      const invalidAmount = await fetch(`http://127.0.0.1:${port}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, amountCents: 0, dueDate: '2030-01-10', description: 'Bad amount' }),
      });
      assert.equal(invalidAmount.status, 400);

      const invalidDate = await fetch(`http://127.0.0.1:${port}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, amountCents: 2500, dueDate: '2020-01-01', description: 'Past date' }),
      });
      assert.equal(invalidDate.status, 400);
      const invalidDateBody = await invalidDate.json();
      assert.match(invalidDateBody.error, /today or later/i);
    } finally {
      server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/invoices writes the live invoice only after successful PayPal calls and returns the payer link', async () => {
  ensureDefaultMerchant();
  resetInvoiceFixtures();

  const customerId = 2222;
  db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(customerId, 1, 'Live Customer', 'live.customer@example.com', 'live.customer@paypal.com');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url || '');
    if (/^https?:\/\/127\.0\.0\.1:|^https?:\/\/localhost:/.test(target)) {
      return originalFetch(url, init);
    }

    if (target.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (target.includes('/v2/invoicing/invoices') && !target.includes('/send')) {
      if (target.includes('/INV-')) {
        return new Response(JSON.stringify({
          id: 'INV-123456',
          detail: {
            metadata: {
              recipient_view_url: 'https://sandbox.paypal.com/invoice/p/#payer-link',
            },
          },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ id: 'INV-123456' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (target.includes('/send')) {
      return new Response(JSON.stringify({ status: 'SENT' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (target.includes('/INV-123456')) {
      return new Response(JSON.stringify({
        id: 'INV-123456',
        detail: {
          metadata: {
            recipient_view_url: 'https://sandbox.paypal.com/invoice/p/#payer-link',
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in invoice route test: ${target}`);
  };

  try {
    const { server, port } = await listenOnApp();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, amountCents: 2500, dueDate: '2030-01-10', description: 'Sandbox invoice' }),
      });

      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.invoice.customer_id, customerId);
      assert.equal(body.invoice.amount_cents, 2500);
      assert.equal(body.payer_link, 'https://sandbox.paypal.com/invoice/p/#payer-link');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invoice WHERE customer_id = ? AND merchant_id = ?').get(customerId, 1).count, 1);
    } finally {
      server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/invoices returns PayPal error details without inserting a row when the create call fails', async () => {
  ensureDefaultMerchant();
  resetInvoiceFixtures();

  const customerId = 3333;
  db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
    .run(customerId, 1, 'Failing Customer', 'failing.customer@example.com', 'failing.customer@paypal.com');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url || '');
    if (/^https?:\/\/127\.0\.0\.1:|^https?:\/\/localhost:/.test(target)) {
      return originalFetch(url, init);
    }

    if (target.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (target.includes('/v2/invoicing/invoices')) {
      return new Response(JSON.stringify({
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested invoice is invalid.',
        details: [{ field: 'detail.payment_term', issue: 'The specified payment term is invalid.' }],
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in failure test: ${target}`);
  };

  try {
    const { server, port } = await listenOnApp();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, amountCents: 2500, dueDate: '2030-01-10', description: 'Bad invoice' }),
      });

      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error.name, 'UNPROCESSABLE_ENTITY');
      assert.match(body.error.message, /invalid/i);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invoice WHERE customer_id = ? AND merchant_id = ?').get(customerId, 1).count, 0);
    } finally {
      server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleWebhook sums payments across events with different ids and never un-pays', async () => {
  const restoreFetch = stubPayPalSignatureVerification();

  try {
    ensureDefaultMerchant();
    resetInvoiceFixtures();

    db.prepare('INSERT INTO customer (id, merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?, ?)')
      .run(1090, 1, 'Cumulative Customer', 'cumulative@example.com', 'cumulative@paypal.com');

    db.prepare(`
      INSERT INTO invoice (id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(5090, 1, 1090, 'INV-CUMUL-TEST', 2500, 'USD', '2026-11-04T00:00:00Z', '2026-11-20T00:00:00Z', 0, null, 'live');

    const tx = (paymentId, value) => ({
      payment_id: paymentId,
      transaction_status: 'SUCCESS',
      amount: { currency_code: 'USD', value },
    });

    const makeEvent = (id, createTime, status, transactions) => {
      const event = JSON.parse(JSON.stringify(fixture));
      event.id = id;
      event.create_time = createTime;
      event.resource.invoice.id = 'INV-CUMUL-TEST';
      event.resource.invoice.status = status;
      event.resource.invoice.payments.transactions = transactions;
      return event;
    };

    const send = (event, n) => handleWebhook(Buffer.from(JSON.stringify(event)), {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': `tx-cumul-${n}`,
      'paypal-transmission-sig': `sig-cumul-${n}`,
      'paypal-transmission-time': '2026-11-05T00:17:17Z',
    });

    const readInvoice = () => db.prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?').get(5090, 1);

    // Event A: customer pays $10 of $25.
    const resultA = await send(
      makeEvent('evt-cumul-a', '2026-11-05T00:10:00.000Z', 'PARTIALLY_PAID', [tx('PAY-CUM-1', '10.00')]),
      1,
    );
    assert.equal(resultA.action, 'invoice payment processed');
    assert.equal(readInvoice().paid_cents, 1000);
    assert.equal(readInvoice().paid_at, null);

    // Event B (different id): PayPal lists the first payment again plus a new $15 one.
    const resultB = await send(
      makeEvent('evt-cumul-b', '2026-11-05T00:20:00.000Z', 'PAID', [tx('PAY-CUM-1', '10.00'), tx('PAY-CUM-2', '15.00')]),
      2,
    );
    assert.equal(resultB.action, 'invoice payment processed');
    assert.equal(readInvoice().paid_cents, 2500);
    assert.equal(readInvoice().paid_at, '2026-11-05T00:20:00.000Z');

    // Event C (different id again, same payments, later time): must change nothing.
    await send(
      makeEvent('evt-cumul-c', '2026-11-05T00:30:00.000Z', 'PAID', [tx('PAY-CUM-1', '10.00'), tx('PAY-CUM-2', '15.00')]),
      3,
    );
    assert.equal(readInvoice().paid_cents, 2500);
    assert.equal(readInvoice().paid_at, '2026-11-05T00:20:00.000Z');

    const recorded = db.prepare('SELECT COUNT(*) AS n FROM invoice_payment WHERE merchant_id = ? AND invoice_id = ?').get(1, 5090);
    assert.equal(recorded.n, 2);
  } finally {
    restoreFetch();
  }
});
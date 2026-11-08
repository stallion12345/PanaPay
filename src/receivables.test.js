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
const { toChicagoDateKey } = await import('./lib/receivables/status.js');
const { dayDifferenceInDays } = await import('./lib/receivables/profile.js');

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
  db.prepare('DELETE FROM customer').run();
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

test('GET /api/receivables returns every invoice with derived status, reason, and daysLate', async () => {
  ensureDefaultMerchant();
  resetAll();

  const now = new Date().toISOString();
  const todayKey = toChicagoDateKey(now);

  insertCustomer(101, 1, 'Alpha Customer', 'alpha@example.com', 'alpha@paypal.com');

  insertInvoice(1, 1, 101, 'INV-ISSUED', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertInvoice(2, 1, 101, 'INV-DUE', 10000, 'USD', '2026-11-01T00:00:00Z', todayKey, 0, null, 'live');
  insertInvoice(3, 1, 101, 'INV-OVER', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  insertInvoice(4, 1, 101, 'INV-BROKEN', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  insertPromise(401, 1, 101, 4, '2026-10-01', 'open', 0.9);
  insertInvoice(5, 1, 101, 'INV-PROMISED', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertPromise(501, 1, 101, 5, todayKey, 'open', 0.8);
  insertInvoice(6, 1, 101, 'INV-PARTIAL', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 3000, null, 'live');
  insertInvoice(7, 1, 101, 'INV-PAID', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 10000, '2026-12-01T10:00:00.000Z', 'live');
  insertInvoice(8, 1, 101, 'INV-LATE', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 10000, '2026-10-10T18:00:00.000Z', 'live');

  // Invoices with due dates computed relative to today in Chicago get exact daysLate.
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const dueFourDaysAgo = new Date(Date.UTC(ty, tm - 1, td - 4, 12, 0, 0));
  const dueFourDaysAgoIso = `${dueFourDaysAgo.getUTCFullYear()}-${String(dueFourDaysAgo.getUTCMonth() + 1).padStart(2, '0')}-${String(dueFourDaysAgo.getUTCDate()).padStart(2, '0')}`;

  insertInvoice(9, 1, 101, 'INV-OVER-4DAYS', 10000, 'USD', '2026-11-01T00:00:00Z', dueFourDaysAgoIso, 0, null, 'live');
  insertInvoice(
    10,
    1,
    101,
    'INV-LATE-4DAYS',
    10000,
    'USD',
    '2026-11-01T00:00:00Z',
    dueFourDaysAgoIso,
    10000,
    now,
    'live'
  );

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/receivables`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.invoices.length, 10);

    const byId = {};
    for (const inv of body.invoices) {
      byId[inv.invoiceId] = inv;
    }

    assert.equal(byId[1].status, 'issued');
    assert.equal(byId[1].reason, null);
    assert.equal(byId[1].daysLate, 0);
    assert.equal(byId[1].paypalInvoiceId, 'INV-ISSUED');
    assert.equal(byId[1].customerName, 'Alpha Customer');

    assert.equal(byId[2].status, 'due_today');
    assert.equal(byId[2].daysLate, 0);

    // Past-due unpaid invoices: days late is measured from the due date to today.
    const expectedOverdueDaysLate = dayDifferenceInDays('2026-10-01', todayKey);
    assert.equal(byId[3].status, 'overdue');
    assert.equal(byId[3].daysLate, expectedOverdueDaysLate);

    assert.equal(byId[4].status, 'broken_promise');
    assert.equal(byId[4].daysLate, expectedOverdueDaysLate);

    assert.equal(byId[5].status, 'promised');
    assert.equal(byId[5].daysLate, 0);

    assert.equal(byId[6].status, 'partially_paid');
    assert.equal(byId[6].paidCents, 3000);
    assert.equal(byId[6].daysLate, 0);

    assert.equal(byId[7].status, 'paid');
    assert.equal(byId[7].paidCents, 10000);
    assert.equal(byId[7].daysLate, 0);

    assert.equal(byId[8].status, 'paid_late');
    assert.equal(byId[8].daysLate, 9);
    assert.equal(byId[8].paidAt, '2026-10-10T18:00:00.000Z');

    assert.equal(byId[9].status, 'overdue');
    assert.equal(byId[9].daysLate, 4);

    assert.equal(byId[10].status, 'paid_late');
    assert.equal(byId[10].daysLate, 4);

    for (const inv of body.invoices) {
      assert.equal(typeof inv.invoiceId, 'number');
      assert.equal(typeof inv.paypalInvoiceId, 'string');
      assert.equal(typeof inv.customerId, 'number');
      assert.equal(typeof inv.amountCents, 'number');
      assert.equal(typeof inv.currency, 'string');
      assert.equal(typeof inv.dueAt, 'string');
      assert.equal(typeof inv.paidCents, 'number');
      assert.equal(typeof inv.status, 'string');
      assert.equal(typeof inv.source, 'string');
    }
  } finally {
    server.close();
  }
});

test('GET /api/receivables sorts by status rank: broken_promise first, paid last', async () => {
  ensureDefaultMerchant();
  resetAll();

  const now = new Date().toISOString();
  const todayKey = toChicagoDateKey(now);

  insertCustomer(102, 1, 'Beta Customer', 'beta@example.com', 'beta@paypal.com');

  insertInvoice(20, 1, 102, 'INV-PAID', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 10000, '2026-12-01T10:00:00.000Z', 'live');
  insertInvoice(19, 1, 102, 'INV-LATE', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 10000, '2026-10-10T18:00:00.000Z', 'live');
  insertInvoice(18, 1, 102, 'INV-ISSUED', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertInvoice(17, 1, 102, 'INV-PROMISED', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertPromise(171, 1, 102, 17, todayKey, 'open', 0.8);
  insertInvoice(16, 1, 102, 'INV-PARTIAL', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 3000, null, 'live');
  insertInvoice(15, 1, 102, 'INV-DUE', 10000, 'USD', '2026-11-01T00:00:00Z', todayKey, 0, null, 'live');
  insertInvoice(14, 1, 102, 'INV-OVER', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  insertInvoice(13, 1, 102, 'INV-BROKEN', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  insertPromise(131, 1, 102, 13, '2026-10-01', 'open', 0.9);

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/receivables`);
    const body = await response.json();
    const statuses = body.invoices.map((inv) => inv.status);

    const expectedOrder = [
      'broken_promise',
      'overdue',
      'due_today',
      'partially_paid',
      'promised',
      'issued',
      'paid_late',
      'paid',
    ];
    assert.deepEqual(statuses, expectedOrder);
  } finally {
    server.close();
  }
});

test('GET /api/receivables returns empty list when no invoices', async () => {
  ensureDefaultMerchant();
  resetAll();

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/receivables`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.invoices, []);
  } finally {
    server.close();
  }
});

test('GET /api/customers returns id, name, email, and canInvoice', async () => {
  ensureDefaultMerchant();
  resetAll();

  insertCustomer(101, 1, 'Good Customer', 'good@example.com', 'good@paypal.com');
  insertCustomer(102, 1, 'Bad Customer', 'bad@example.com', 'bad@example.com');
  insertCustomer(103, 1, 'No Email Customer', 'noemail@example.com', null);

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.customers.length, 3);

    const byId = {};
    for (const c of body.customers) {
      byId[c.id] = c;
    }

    assert.equal(byId[101].canInvoice, true);
    assert.equal(byId[101].email, 'good@example.com');

    assert.equal(byId[102].canInvoice, false);
    assert.equal(byId[102].email, 'bad@example.com');

    assert.equal(byId[103].canInvoice, false);
    assert.equal(byId[103].email, 'noemail@example.com');

    for (const c of body.customers) {
      assert.equal(Object.keys(c).sort().join(','), 'canInvoice,email,id,name');
    }
  } finally {
    server.close();
  }
});

test('GET /api/customers/:id returns customer, invoices, notes, promises, profile, nextAction null', async () => {
  ensureDefaultMerchant();
  resetAll();

  const now = new Date().toISOString();
  const todayKey = toChicagoDateKey(now);

  insertCustomer(101, 1, 'Alpha Customer', 'alpha@example.com', 'alpha@paypal.com');

  insertInvoice(1, 1, 101, 'INV-1', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertInvoice(2, 1, 101, 'INV-2', 10000, 'USD', '2026-10-01T00:00:00Z', '2026-10-01', 0, null, 'live');
  insertPromise(101, 1, 101, 2, '2026-10-01', 'open', 0.9);

  db.prepare('INSERT INTO customer_note (id, merchant_id, customer_id, invoice_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 1, 101, 1, 'Note about invoice 1', '2026-11-01T10:00:00.000Z');

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers/101`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.nextAction, null);

    assert.equal(body.customer.id, 101);
    assert.equal(body.customer.name, 'Alpha Customer');
    assert.equal(body.customer.email, 'alpha@example.com');

    assert.equal(body.invoices.length, 2);
    const invById = {};
    for (const inv of body.invoices) {
      invById[inv.id] = inv;
    }
    assert.equal(invById[1].status, 'issued');
    assert.equal(invById[2].status, 'broken_promise');

    assert.equal(body.notes.length, 1);
    assert.equal(body.notes[0].text, 'Note about invoice 1');

    assert.equal(body.promises.length, 1);
    assert.equal(body.promises[0].status, 'open');
    assert.equal(body.promises[0].confidence, 0.9);

    assert.equal(body.profile.invoiceCount, 2);
    assert.equal(body.profile.enoughHistory, false);
  } finally {
    server.close();
  }
});

test('GET /api/customers/:id returns 404 for unknown customer', async () => {
  ensureDefaultMerchant();
  resetAll();

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers/99999`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
  } finally {
    server.close();
  }
});

test('GET /api/customers/:id returns 404 for customer of another merchant', async () => {
  ensureDefaultMerchant();
  resetAll();

  db.prepare('INSERT INTO merchant (id, name, weekly_spend_limit, currency) VALUES (?, ?, ?, ?)')
    .run(2, 'Other Merchant', 0, 'USD');
  insertCustomer(101, 2, 'Other Merchant Customer', 'other@example.com', 'other@paypal.com');

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers/101`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
  } finally {
    server.close();
  }
});

test('unconfirmed promise is ignored and does not make invoice promised', async () => {
  ensureDefaultMerchant();
  resetAll();

  const now = new Date().toISOString();
  const todayKey = toChicagoDateKey(now);

  insertCustomer(101, 1, 'Alpha Customer', 'alpha@example.com', 'alpha@paypal.com');

  insertInvoice(1, 1, 101, 'INV-UNCONF', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-12-01', 0, null, 'live');
  insertPromise(101, 1, 101, 1, todayKey, 'unconfirmed', 0.5);

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/receivables`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.invoices.length, 1);
    assert.equal(body.invoices[0].status, 'issued');
    assert.equal(body.invoices[0].reason, null);
  } finally {
    server.close();
  }
});

test('GET /api/customers/:id includes profile from buildProfile with correct fields', async () => {
  ensureDefaultMerchant();
  resetAll();

  insertCustomer(101, 1, 'Alpha Customer', 'alpha@example.com', 'alpha@paypal.com');

  insertInvoice(1, 1, 101, 'INV-1', 10000, 'USD', '2026-11-01T00:00:00Z', '2026-11-01', 10000, '2026-11-01T10:00:00.000Z', 'live');
  insertInvoice(2, 1, 101, 'INV-2', 12000, 'USD', '2026-11-02T00:00:00Z', '2026-11-02', 12000, '2026-11-02T11:00:00.000Z', 'live');
  insertInvoice(3, 1, 101, 'INV-3', 15000, 'USD', '2026-11-03T00:00:00Z', '2026-11-03', 15000, '2026-11-03T17:00:00.000Z', 'live');

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers/101`);
    const body = await response.json();
    assert.equal(response.status, 200);

    const p = body.profile;
    assert.equal(p.invoiceCount, 3);
    assert.equal(p.totalInvoicedCents, 37000);
    assert.equal(p.totalPaidCents, 37000);
    assert.equal(p.outstandingCents, 0);
    assert.equal(p.paidLateCount, 0);
    assert.equal(p.avgDaysLate, 0);
    assert.equal(p.enoughHistory, true);
    assert.equal(p.label, 'Usually on time');
    assert.equal(Array.isArray(p.evidence), true);
  } finally {
    server.close();
  }
});

test('GET /api/customers/:id includes daysLate for each invoice', async () => {
  ensureDefaultMerchant();
  resetAll();

  const now = new Date().toISOString();
  const todayKey = toChicagoDateKey(now);
  const [todayYear, todayMonth, todayDay] = todayKey.split('-').map(Number);

  const overdueDue = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay - 1, 12, 0, 0)).toISOString();
  const futureDue = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay + 5, 12, 0, 0)).toISOString();

  insertCustomer(101, 1, 'Alpha Customer', 'alpha@example.com', 'alpha@paypal.com');
  insertInvoice(1, 1, 101, 'INV-OVERDUE', 10000, 'USD', '2026-11-01T00:00:00Z', overdueDue, 0, null, 'live');
  insertInvoice(2, 1, 101, 'INV-FUTURE', 10000, 'USD', '2026-11-01T00:00:00Z', futureDue, 0, null, 'live');

  const { server, port } = await listenOnApp();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/customers/101`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    const byId = {};
    for (const inv of body.invoices) byId[inv.id] = inv;
    assert.equal(byId[1].daysLate, 1);
    assert.equal(byId[2].daysLate, 0);
  } finally {
    server.close();
  }
});
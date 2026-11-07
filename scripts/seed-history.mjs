if (process.env.NODE_ENV === 'test') {
  throw new Error('Refusing to run the seed while NODE_ENV=test.');
}

const { db, initializeDb } = await import('../src/db.js');
const { buildProfile } = await import('../src/lib/receivables/profile.js');
const { derive } = await import('../src/lib/receivables/status.js');

const merchantId = 1;

// Never touch merchant 1's name or weekly spend limit; use it only as a FK.
// ensureDefaultMerchant() (invoked on db.js import) creates it if absent.
initializeDb();

// ---- Chicago date helpers ----
function todayChicagoKey() {
  const now = new Date();
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const m = {};
  for (const part of f.formatToParts(now)) {
    if (part.type !== 'literal') m[part.type] = part.value;
  }
  return `${m.year}-${m.month}-${m.day}`;
}

function chicagoDateKeyPlusDays(baseKey, days) {
  const [y, m, d] = baseKey.split('-').map(Number);
  // Noon UTC is always morning in Chicago, so it never crosses the Chicago date boundary.
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const mm = {};
  for (const part of f.formatToParts(date)) {
    if (part.type !== 'literal') mm[part.type] = part.value;
  }
  return `${mm.year}-${mm.month}-${mm.day}`;
}

const T = todayChicagoKey();
const d = (n) => chicagoDateKeyPlusDays(T, n); // Chicago date key for today + n days
const iso = (key, time) => `${key}T${time}`;
const issuedAt = (n) => iso(d(n), '10:00:00.000Z'); // mid-morning UTC -> morning Chicago
const paidAt = (n) => iso(d(n), '18:00:00.000Z'); // midday Chicago
const processedAt = (n) => iso(d(n), '18:00:00.000Z');
const dueAt = (n) => d(n); // plain YYYY-MM-DD, as live invoices use

const currency = 'USD';
const source = 'seeded';

const customers = [
  { name: 'Ada Okonkwo', email: 'ada.okonkwo@example.com' },
  { name: 'Chidi Nwosu', email: 'chidi.nwosu@example.com' },
  { name: 'Blessing Eze', email: 'blessing.eze@example.com' },
  { name: 'Emeka Ibeh', email: 'emeka.ibeh@example.com' },
];


// [customerIndex, paypalInvoiceId, amountCents, issuedOffset, dueOffset, paidOffsetOrNull, paymentCentsOrNull]
const invoices = [
  // Ada Okonkwo — reliable payer (label: Usually on time)
  [0, 'SEED-ADA-0001', 35000, -40, -15, -16, 35000],
  [0, 'SEED-ADA-0002', 28000, -50, -25, -26, 28000],
  [0, 'SEED-ADA-0003', 22000, -60, -35, -36, 22000],
  [0, 'SEED-ADA-0004', 40000, -70, -45, -46, 40000],
  [0, 'SEED-ADA-0005', 21000, -5, 30, null, null],
  // Chidi Nwosu — habitual late payer (label: Usually late)
  [1, 'SEED-CHI-0001', 32000, -40, -15, -10, 32000],
  [1, 'SEED-CHI-0002', 25000, -50, -20, -11, 25000],
  [1, 'SEED-CHI-0003', 18000, -30, -12, -4, 18000],
  [1, 'SEED-CHI-0004', 30000, -10, -4, null, null],
  [1, 'SEED-CHI-0005', 18000, -5, -2, null, null],
  // Blessing Eze — broken promise now (label: Mixed)
  [2, 'SEED-BLE-0001', 24000, -40, -20, -21, 24000],
  [2, 'SEED-BLE-0002', 31000, -50, -25, -26, 31000],
  [2, 'SEED-BLE-0003', 19000, -35, -15, -8, 19000],
  [2, 'SEED-BLE-0004', 16000, -10, -8, null, null],
  [2, 'SEED-BLE-0005', 20000, -5, 15, null, 8000],
  // Emeka Ibeh — new customer (label: Not enough history yet)
  [3, 'SEED-EME-0001', 18000, -5, 0, null, null],
];

// [customerIndex, paypalInvoiceId, status, promisedDateOffsetOrNull, createdOffset, reason, method, confidence]
const promises = [
  [1, 'SEED-CHI-0004', 'unconfirmed', null, -1, "I'll pay soon", 'paypal', 0.2],
  [
    1,
    'SEED-CHI-0005',
    'open',
    5,
    -1,
    'Will pay once their own customer pays them',
    'paypal',
    0.9,
  ],
  [
    2,
    'SEED-BLE-0004',
    'open',
    -3,
    -9,
    'Said payment was being sent after payday',
    'bank_transfer',
    0.85,
  ],
];

const insertedCustomers = [];
const insertedInvoices = [];
const insertedPayments = [];
const insertedPromises = [];

// ---- Customers (idempotent by merchant_id + email) ----
for (const cust of customers) {
  let row = db
    .prepare('SELECT id FROM customer WHERE merchant_id = ? AND email = ?')
    .get(merchantId, cust.email);
  if (!row) {
    db.prepare(
      'INSERT INTO customer (merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?)'
    ).run(merchantId, cust.name, cust.email, cust.email);
    row = db
      .prepare('SELECT id FROM customer WHERE merchant_id = ? AND email = ?')
      .get(merchantId, cust.email);
  }
  insertedCustomers.push({ ...cust, id: row.id });
  console.log(
    `Customer id: ${row.id} (${cust.name}) email: ${cust.email} source: seeded`
  );
}

const getCustomerId = (index) => insertedCustomers[index].id;

// ---- Invoices + payments (idempotent by paypal_invoice_id) ----
for (const [ci, paypalInvoiceId, amountCents, issuedOff, dueOff, paidOff, paymentCents] of invoices) {
  const customerId = getCustomerId(ci);
  const existing = db
    .prepare('SELECT id FROM invoice WHERE paypal_invoice_id = ?')
    .get(paypalInvoiceId);
  if (existing) {
    console.log(`Invoice ${paypalInvoiceId} already exists; skipping.`);
    continue;
  }

  const paidCents = paymentCents ?? 0;
  const paidAtValue = paidOff === null ? null : paidAt(paidOff);

  db.prepare(
    `INSERT INTO invoice
       (merchant_id, customer_id, paypal_invoice_id, amount_cents, currency,
        issued_at, due_at, paid_cents, paid_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    merchantId,
    customerId,
    paypalInvoiceId,
    amountCents,
    currency,
    issuedAt(issuedOff),
    dueAt(dueOff),
    paidCents,
    paidAtValue,
    source
  );

  const invoiceRow = db
    .prepare('SELECT id FROM invoice WHERE paypal_invoice_id = ?')
    .get(paypalInvoiceId);
  const invoiceId = invoiceRow.id;

  // Payment row so paid_cents equals the sum of invoice_payment.amount_cents.
  if (paymentCents) {
    const paymentId = `SEED-PAY-${paypalInvoiceId}`;
    const eventId = `seed-${paypalInvoiceId.toLowerCase()}`;
    db.prepare(
      `INSERT OR IGNORE INTO invoice_payment
         (merchant_id, invoice_id, payment_id, event_id, amount_cents, currency, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      merchantId,
      invoiceId,
      paymentId,
      eventId,
      paymentCents,
      currency,
      processedAt(paidOff)
    );
    insertedPayments.push({
      invoice: paypalInvoiceId,
      paymentId,
      amount: paymentCents,
      processedAt: processedAt(paidOff),
    });
  }

  insertedInvoices.push({
    paypalInvoiceId,
    customer: insertedCustomers[ci].name,
    amountCents,
    due: dueAt(dueOff),
    paidCents,
    paidAt: paidAtValue,
  });
  console.log(
    `Invoice ${paypalInvoiceId} for ${insertedCustomers[ci].name}: $${(amountCents / 100).toFixed(2)} due ${dueAt(dueOff)} paid_cents=${paidCents} source=seeded`
  );
}

// ---- Promises (idempotent by customer_id + invoice_id + status) ----
for (const [ci, paypalInvoiceId, status, promisedOff, createdOff, reason, method, confidence] of promises) {
  const customerId = getCustomerId(ci);
  const invoiceRow = db
    .prepare('SELECT id FROM invoice WHERE paypal_invoice_id = ?')
    .get(paypalInvoiceId);
  if (!invoiceRow) {
    console.log(`Promise skipped: invoice ${paypalInvoiceId} not found.`);
    continue;
  }
  const invoiceId = invoiceRow.id;

  const existing = db
    .prepare(
      'SELECT id FROM promise WHERE customer_id = ? AND invoice_id = ? AND status = ?'
    )
    .get(customerId, invoiceId, status);
  if (existing) {
    console.log(`Promise for ${paypalInvoiceId} (${status}) already exists; skipping.`);
    continue;
  }

  const promisedDate = promisedOff === null ? null : d(promisedOff);
  const createdAt = createdOff === null ? new Date().toISOString() : paidAt(createdOff);

  db.prepare(
    `INSERT INTO promise
       (merchant_id, customer_id, invoice_id, reason, promised_date, promised_cents,
        method, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    merchantId,
    customerId,
    invoiceId,
    reason,
    promisedDate,
    method,
    confidence,
    status,
    createdAt
  );

  insertedPromises.push({
    invoice: paypalInvoiceId,
    status,
    promisedDate,
    reason,
    method,
    confidence,
  });
  console.log(
    `Promise for ${paypalInvoiceId}: status=${status} promised_date=${promisedDate} reason="${reason}" method=${method} confidence=${confidence} source=seeded`
  );
}

// ---- Verify: run buildProfile + derive on the seeded data ----
const now = new Date().toISOString();

console.log('\n=== Customer profiles ===');
for (const cust of insertedCustomers) {
  const rows = db
    .prepare(
      'SELECT * FROM invoice WHERE customer_id = ? AND source = ? ORDER BY paypal_invoice_id'
    )
    .all(cust.id, source);
  const invList = rows.map((r) => ({
    id: r.id,
    paypal_invoice_id: r.paypal_invoice_id,
    amount_cents: r.amount_cents,
    paid_cents: r.paid_cents,
    issued_at: r.issued_at,
    due_at: r.due_at,
    paid_at: r.paid_at,
  }));
  const promList = db
    .prepare('SELECT * FROM promise WHERE customer_id = ?')
    .all(cust.id);
  const prof = buildProfile({
    invoices: invList,
    promises: promList,
    payments: [],
    now,
  });
  console.log(
    `${cust.name} (id ${cust.id}): label="${prof.label ?? 'Not enough history yet'}" invoices=${prof.invoiceCount} paid_late=${prof.paidLateCount} enoughHistory=${prof.enoughHistory} evidence=${prof.evidence.join(' | ')}`
  );

  console.log(`  Invoices:`);
  for (const inv of invList) {
    const custPromises = promList.filter((p) => p.invoice_id === inv.id);
    const status = derive({ invoice: inv, promises: custPromises, now }).status;
    console.log(
      `    ${inv.paypal_invoice_id ?? 'id=' + inv.id} due=${inv.due_at} paid_cents=${inv.paid_cents}/${inv.amount_cents} status=${status}`
    );
  }
}

console.log('\n=== Status coverage ===');
const allStatuses = new Set();
for (const cust of insertedCustomers) {
  const rows = db
    .prepare(
      'SELECT * FROM invoice WHERE customer_id = ? AND source = ? ORDER BY paypal_invoice_id'
    )
    .all(cust.id, source);
  for (const inv of rows) {
    const promList = db
      .prepare('SELECT * FROM promise WHERE customer_id = ? AND invoice_id = ?')
      .all(cust.id, inv.id);
    allStatuses.add(derive({ invoice: inv, promises: promList, now }).status);
  }
}
const required = ['issued', 'due_today', 'overdue', 'promised', 'broken_promise', 'partially_paid', 'paid', 'paid_late'];
const missing = required.filter((s) => !allStatuses.has(s));
console.log(`Observed statuses: ${[...allStatuses].sort().join(', ')}`);
console.log(`Missing required statuses: ${missing.length === 0 ? 'none' : missing.join(', ')}`);

console.log('\nSeed history complete.');


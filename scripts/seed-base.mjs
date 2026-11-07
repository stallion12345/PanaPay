if (process.env.NODE_ENV === 'test') {
  throw new Error('Refusing to run the seed while NODE_ENV=test.');
}

const { db, initializeDb } = await import('../src/db.js');

const merchantId = 1;
const merchantName = "Ngozi's Fabrics";
const merchantLocation = 'Houston, TX';
const weeklySpendLimit = 40000; // cents
const merchantCurrency = 'USD';

// Emails come from .env when set. Otherwise a fake placeholder is used so the seed
// never fails on a clean clone. Placeholders cannot receive real PayPal sandbox money.
function emailFor(envName, placeholder) {
  const value = process.env[envName]?.trim();
  if (value) return { email: value, isPlaceholder: false };
  console.log(`using placeholder for ${envName}: live PayPal actions for this party will not work until you set it in .env`);
  return { email: placeholder, isPlaceholder: true };
}

const supplier1 = emailFor('SUPPLIER_1_EMAIL', 'supplier1@example.com');
const supplier2 = emailFor('SUPPLIER_2_EMAIL', 'supplier2@example.com');
const customer = emailFor('CUSTOMER_EMAIL', 'customer@example.com');

const isPlaceholderEmail = (e) => typeof e === 'string' && e.endsWith('@example.com');

initializeDb();

// Merchant
const merchantRow = db.prepare('SELECT id FROM merchant WHERE id = ?').get(merchantId);
if (!merchantRow) {
  db.prepare('INSERT INTO merchant (id, name, weekly_spend_limit, currency) VALUES (?, ?, ?, ?)')
    .run(merchantId, merchantName, weeklySpendLimit, merchantCurrency);
}
console.log(`Merchant id: ${merchantId} (${merchantName}, ${merchantLocation})`);

// Suppliers
const suppliers = [
  { id: 'party-mama-nkechi', name: 'Mama Nkechi Stores', ...supplier1 },
  { id: 'party-kola', name: 'Kola Enterprises', ...supplier2 },
];

for (const s of suppliers) {
  const existing = db.prepare('SELECT id, paypal_email FROM party WHERE id = ?').get(s.id);
  if (!existing) {
    db.prepare('INSERT INTO party (id, merchant_id, type, name, paypal_email) VALUES (?, ?, ?, ?, ?)')
      .run(s.id, merchantId, 'supplier', s.name, s.email);
  } else if (!s.isPlaceholder && isPlaceholderEmail(existing.paypal_email)) {
    db.prepare('UPDATE party SET paypal_email = ? WHERE id = ?').run(s.email, s.id);
  }
  const row = db.prepare('SELECT id, paypal_email FROM party WHERE id = ?').get(s.id);
  console.log(`Supplier id: ${row.id} (${s.name}) email: ${row.paypal_email}`);
}

// Sandbox customer
const existingCustomer = db
  .prepare('SELECT id, paypal_email FROM customer WHERE merchant_id = ? AND name = ?')
  .get(merchantId, 'Sandbox Customer');

if (!existingCustomer) {
  db.prepare('INSERT INTO customer (merchant_id, name, email, paypal_email) VALUES (?, ?, ?, ?)')
    .run(merchantId, 'Sandbox Customer', customer.email, customer.email);
} else if (!customer.isPlaceholder && isPlaceholderEmail(existingCustomer.paypal_email)) {
  db.prepare('UPDATE customer SET email = ?, paypal_email = ? WHERE id = ?')
    .run(customer.email, customer.email, existingCustomer.id);
}

const customerRow = db
  .prepare('SELECT id, paypal_email FROM customer WHERE merchant_id = ? AND name = ?')
  .get(merchantId, 'Sandbox Customer');
console.log(`Customer id: ${customerRow.id} email: ${customerRow.paypal_email}`);

console.log('Seed complete.');
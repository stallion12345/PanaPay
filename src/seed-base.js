import { db, initializeDb } from './db.js';

initializeDb();

const merchantId = 1;
const supplier1Email = process.env.SUPPLIER_1_EMAIL;
const supplier2Email = process.env.SUPPLIER_2_EMAIL;
const sandboxCustomerEmail = process.env.CUSTOMER_EMAIL?.trim();

if (!supplier1Email || !supplier2Email) {
  throw new Error('Missing SUPPLIER_1_EMAIL or SUPPLIER_2_EMAIL in environment.');
}

if (!sandboxCustomerEmail) {
  throw new Error('Missing CUSTOMER_EMAIL in environment.');
}

const merchant = {
  id: merchantId,
  name: "Ngozi's Fabrics",
  weekly_spend_limit: 40000,
  currency: 'USD',
};

const suppliers = [
  { id: 'party-mama-nkechi', merchant_id: merchantId, type: 'supplier', name: 'Mama Nkechi Stores', paypal_email: supplier1Email },
  { id: 'party-kola', merchant_id: merchantId, type: 'supplier', name: 'Kola Enterprises', paypal_email: supplier2Email },
];

const upsertMerchant = db.prepare(`
  INSERT INTO merchant (id, name, weekly_spend_limit, currency)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    weekly_spend_limit = excluded.weekly_spend_limit,
    currency = excluded.currency
`);

const upsertSupplier = db.prepare(`
  INSERT OR IGNORE INTO party (id, merchant_id, type, name, paypal_email)
  VALUES (?, ?, ?, ?, ?)
`);

const upsertCustomer = db.prepare(`
  INSERT INTO customer (merchant_id, name, email, paypal_email)
  VALUES (?, ?, ?, ?)
`);

upsertMerchant.run(merchant.id, merchant.name, merchant.weekly_spend_limit, merchant.currency);
for (const supplier of suppliers) {
  upsertSupplier.run(supplier.id, supplier.merchant_id, supplier.type, supplier.name, supplier.paypal_email);
}

const customerRow = db.prepare('SELECT id FROM customer WHERE merchant_id = ? AND name = ?').get(merchantId, 'Sandbox Customer');
if (customerRow) {
  console.log(`Sandbox Customer id: ${customerRow.id}`);
} else {
  const result = upsertCustomer.run(merchantId, 'Sandbox Customer', sandboxCustomerEmail, sandboxCustomerEmail);
  console.log(`Sandbox Customer id: ${result.lastInsertRowid}`);
}

console.log('Base seed complete.');

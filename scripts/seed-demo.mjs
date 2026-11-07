import { DatabaseSync } from 'node:sqlite';

const API_BASE = process.env.PANAPAY_API_BASE || 'http://localhost:3000';
const PAYOUT_AMOUNTS = [
  { dollars: 240.00, note: 'Weekly fabric bolts and dye stock' },
  { dollars: 410.00, note: 'Bulk lace order for tailoring batch' },
  { dollars: 85.00, note: 'Thread and trim restock' },
  { dollars: 195.00, note: 'Local supplier top-up' },
  { dollars: 60.00, note: 'Packaging and labels' },
];

const db = new DatabaseSync('data/panapay.db');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const debugId = response.headers.get('Paypal-Debug-Id') || response.headers.get('PayPal-Debug-Id') || data?.debug_id || 'unknown';
    console.error(`Request failed: ${response.status} ${response.statusText} debug_id=${debugId}`);
    console.error(JSON.stringify(data, null, 2));
    throw new Error(`PanaPay API request failed (${response.status}) debug_id=${debugId}`);
  }

  return data;
}

async function main() {
  const suppliers = db.prepare(`
    SELECT id, name, paypal_email
    FROM party
    WHERE merchant_id = 1 AND type = 'supplier'
    ORDER BY name ASC
  `).all();

  if (suppliers.length < 2) {
    throw new Error('At least two suppliers are required in the seeded database. Run the base seed first.');
  }

  const created = [];
  for (let index = 0; index < PAYOUT_AMOUNTS.length; index += 1) {
    const supplier = suppliers[index % suppliers.length];
    const amount = PAYOUT_AMOUNTS[index];
    const amountCents = Math.round(amount.dollars * 100);
    const payload = {
      partyId: supplier.id,
      amountCents,
      note: amount.note,
    };

    console.log(`Sending payout ${index + 1}/${PAYOUT_AMOUNTS.length} to ${supplier.name} for $${amount.dollars.toFixed(2)}`);
    const result = await requestJson('/api/payouts', payload);
    created.push({
      supplier: supplier.name,
      amount_cents: amountCents,
      amount_dollars: amount.dollars,
      payout_id: result?.payout?.id,
      batch_id: result?.payout?.batch_id,
    });

    if (index < PAYOUT_AMOUNTS.length - 1) {
      console.log('Waiting 2 seconds before the next payout...');
      await sleep(2000);
    }
  }

  console.log('\nDemo data summary:');
  console.log(JSON.stringify({ created, count: created.length }, null, 2));

  const customerEmail = process.env.CUSTOMER_EMAIL;
  if (!customerEmail) {
    console.log('\nIncome demo was not sent because CUSTOMER_EMAIL is not set.');
    return;
  }

  console.log(`\nIncome demo check: CUSTOMER_EMAIL is set to ${customerEmail}.`);
  console.log('I am not sending an invoice yet because the exact PayPal Invoicing request shape is not safely verified in this environment.');
  console.log('The official docs confirm the endpoint exists at /v2/invoicing/invoices, but the request body must be verified before any live sandbox call.');
  console.log('Per your rule, I will stop instead of guessing an invoice payload or a debug_id.');
  process.exitCode = 0;
}

try {
  await main();
} catch (error) {
  console.error('\nSeed demo failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

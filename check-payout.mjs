// Read-only: shows the current status of an existing sandbox payout batch. Sends NO money.
// Run:  node --env-file=.env check-payout.mjs FRH7KPS2M2QFL
import "node:process";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
const batchId = process.argv[2];

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !batchId) {
  console.error("Usage: node --env-file=.env check-payout.mjs <batch_id>");
  process.exit(1);
}

async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    console.error(`PayPal error ${res.status} on ${path}`);
    console.error("debug_id:", body?.debug_id ?? res.headers.get("paypal-debug-id") ?? "none");
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
const token = await call("/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});

const batch = await call(`/v1/payments/payouts/${batchId}`, {
  headers: { Authorization: `Bearer ${token.access_token}` },
});

console.log("Batch status:", batch.batch_header.batch_status);
console.log("Amount:      ", batch.batch_header.amount?.value, batch.batch_header.amount?.currency);
for (const item of batch.items ?? []) {
  console.log(`Item ${item.payout_item_id}: ${item.transaction_status}`);
  if (item.errors) console.log("  errors:", JSON.stringify(item.errors));
  // The single-item endpoint carries the failure reason when the batch view does not.
  const detail = await call(`/v1/payments/payouts-item/${item.payout_item_id}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  console.log("  item detail:", JSON.stringify(detail.errors ?? detail, null, 2));
}

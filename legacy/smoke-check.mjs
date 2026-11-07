// PayPal SANDBOX smoke test: get a token, send one $1.00 payout, read its status.
// Run:  node --env-file=.env smoke-test.mjs      (needs Node 20.6 or newer; check with: node -v)
// This is a throwaway check. It never prints your secret.
import { randomUUID } from "node:crypto";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYOUT_RECEIVER_EMAIL } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYOUT_RECEIVER_EMAIL) {
  console.error("Missing values. Fill PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYOUT_RECEIVER_EMAIL in .env");
  process.exit(1);
}

// One place for every PayPal call, so errors always show the debug_id PayPal support asks for.
async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    console.error(`\nPayPal error ${res.status} on ${path}`);
    console.error("debug_id:", body?.debug_id ?? res.headers.get("paypal-debug-id") ?? "none");
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

// 1) Access token (OAuth2 client credentials)
const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
const token = await call("/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
console.log(`1) Token OK (expires in ${token.expires_in}s)`);

const authHeaders = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" };

// 2) One test payout from your sandbox Business account to your sandbox Personal account
const stamp = Date.now();
const created = await call("/v1/payments/payouts", {
  method: "POST",
  headers: { ...authHeaders, "PayPal-Request-Id": randomUUID() }, // idempotency key
  body: JSON.stringify({
    sender_batch_header: { sender_batch_id: `smoke-${stamp}`, email_subject: "PanaPay sandbox test" },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: PAYOUT_RECEIVER_EMAIL,
        amount: { value: "1.00", currency: "USD" },
        note: "Smoke test",
        sender_item_id: `item-${stamp}`,
      },
    ],
  }),
});
const batchId = created.batch_header.payout_batch_id;
console.log(`2) Payout created. batch id: ${batchId}, status: ${created.batch_header.batch_status}`);

// 3) Read it back after a short wait
await new Promise((r) => setTimeout(r, 3000));
const status = await call(`/v1/payments/payouts/${batchId}`, { headers: authHeaders });
console.log(`3) Batch status: ${status.batch_header.batch_status}`);
for (const item of status.items ?? []) {
  console.log(`   item ${item.payout_item_id}: ${item.transaction_status}`);
}
console.log("\nDone. Check the Personal sandbox account's activity to confirm the $1.00 arrived.");

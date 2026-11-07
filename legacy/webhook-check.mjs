// Minimal PayPal SANDBOX webhook receiver. No dependencies.
// Run:  node --env-file=.env webhook-server.mjs
// Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and (after you register the webhook) PAYPAL_WEBHOOK_ID.
import http from "node:http";

const BASE = "https://api-m.sandbox.paypal.com";
const PORT = process.env.PORT || 3000;
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}

// Token is cached until shortly before it expires.
let cached = { token: null, expiresAt: 0 };
async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

// Ask PayPal whether this event really came from PayPal.
// Returns "SUCCESS", "FAILURE", or a note explaining why it was not checked.
async function verifySignature(headers, event) {
  if (!PAYPAL_WEBHOOK_ID) return "NOT_CHECKED (no PAYPAL_WEBHOOK_ID yet)";
  const token = await getToken();
  const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return body.verification_status ?? `ERROR (${res.status})`;
}

const seen = new Set(); // in-memory duplicate guard. The real app will use a UNIQUE column in the database.

async function handleEvent(headers, raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.log("Received a body that is not JSON. Ignored.");
    return;
  }
  const duplicate = seen.has(event.id);
  seen.add(event.id);
  let verification;
  try {
    verification = await verifySignature(headers, event);
  } catch (err) {
    verification = `ERROR (${err.message})`;
  }
  const r = event.resource ?? {};
  const status = r.batch_header?.batch_status ?? r.transaction_status ?? r.status ?? "n/a";
  console.log("\n--- Webhook event ---");
  console.log("id:           ", event.id, duplicate ? "(DUPLICATE, would be ignored)" : "");
  console.log("type:         ", event.event_type);
  console.log("created:      ", event.create_time);
  console.log("status:       ", status);
  console.log("signature:    ", verification);
}

http
  .createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("PanaPay webhook receiver is up. PayPal should POST to /webhook\n");
      return;
    }
    if (req.method === "POST" && req.url === "/webhook") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200).end("ok"); // reply fast, PayPal retries if it does not get a 2xx
        handleEvent(req.headers, Buffer.concat(chunks).toString("utf8")).catch((e) =>
          console.error("Handler error:", e.message)
        );
      });
      return;
    }
    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`Webhook receiver listening on http://localhost:${PORT}  (POST /webhook)`));

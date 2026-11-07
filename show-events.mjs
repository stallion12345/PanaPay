// Prints stored webhook events so you can copy the real shapes. Emails are masked.
// Run:  node scripts/show-events.mjs             (list the last 15 events)
//       node scripts/show-events.mjs INVOICING    (full payloads of events whose type contains INVOICING)
// Reads ./data/panapay.db with built-in node:sqlite. No secrets are printed.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("./data/panapay.db", { readOnly: true });
const filter = (process.argv[2] ?? "").toUpperCase();

const rows = db.prepare("SELECT * FROM webhook_event ORDER BY rowid DESC LIMIT 100").all();
const mask = (s) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");

if (!filter) {
  console.log("Last events (newest first):\n");
  for (const r of rows.slice(0, 15)) {
    console.log(`${String(r.event_type).padEnd(48)} signature=${r.signature_status ?? "n/a"}  id=${r.event_id}`);
  }
  console.log("\nTo see a full payload: node scripts/show-events.mjs INVOICING");
} else {
  const hits = rows.filter((r) => String(r.event_type).toUpperCase().includes(filter));
  if (hits.length === 0) console.log(`No stored events with a type containing "${filter}".`);
  for (const r of hits.slice(0, 5)) {
    console.log(`\n===== ${r.event_type}  (signature=${r.signature_status ?? "n/a"}) =====`);
    let body = r.payload;
    try { body = JSON.stringify(JSON.parse(r.payload), null, 2); } catch { /* print as stored */ }
    console.log(mask(String(body)));
  }
}

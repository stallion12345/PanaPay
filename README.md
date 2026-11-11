# PanaPay

**Know who owes you, what they promised, and whether PayPal confirms they actually paid.**

*(Pana, from "panacea": a remedy for late payments.)*

PanaPay is a receivables app for a small business. It reads what a customer says ("I'll pay Friday"), tracks it as a promise, checks it against what PayPal confirms really happened, and tells the owner what to do next, with the evidence shown. Built for the PayPal AI Hackathon.

## The problem

"I'll pay you Friday." Then Friday comes and nothing arrives.

Our demo owner, Ngozi, runs a fabric shop in Houston. Her customers make payment promises by text and phone. Her invoices live in PayPal. Nothing connects the two, so she cannot easily say who owes her, what they promised, or whether the money came.

## What it does

- **A receivables board.** Every invoice has a status worked out by code: issued, due today, overdue, promised, broken promise, partly paid, paid, paid late. Each customer panel shows the evidence behind it (payment history, days late, promises kept).
- **Messages become promises.** The owner pastes what a customer said. AI extracts the promised date, amount and a confidence level. Vague wording, or someone else paying, is held as *unconfirmed* (or ignored) until the owner confirms or rejects it.
- **Promises are checked against payments.** When a promised date passes and no payment has been recorded, the invoice becomes *broken promise*.
- **Next action and a drafted message.** Rules pick the action (friendly reminder, firm reminder, ask for the balance, or "owner review" above $500). AI drafts the wording from verified facts only. Code rejects a draft with a wrong amount, any link, or threatening wording. For invoices issued through PayPal, the owner can send the reviewed message as a PayPal invoice reminder.
- **Live payment tracking.** Create an invoice through PayPal, pay it in the sandbox, and a signature-verified webhook updates the board to *Paid* within seconds.

PanaPay never sends anything on its own. It flags, recommends and drafts; the owner decides.

## How it uses PayPal (sandbox)

- **Invoicing API v2:** create, send, get and remind invoices (OAuth 2.0 client credentials).
- **Webhooks:** `INVOICING.INVOICE.PAID` events are verified against PayPal's signature, de-duplicated, and recorded as payments. The paid total is the sum of recorded payments, and an invoice is never "un-paid".

## How it uses AI

One adapter (`src/lib/llm.js`) calls Google Gemini (`gemini-3.5-flash-lite`); OpenAI is also supported. AI does two jobs:

1. **Reads a customer's message** into a structured promise (date, amount, method, confidence). The output is validated with Zod, and code rules apply: the date must be real, not in the past, and within 60 days, otherwise it is dropped and confidence is capped.
2. **Drafts the reminder wording** from a fixed set of facts. Code checks the draft, and falls back to standard wording if the model fails, times out, or breaks a rule.

## Code decides, AI interprets

| Code decides | AI interprets |
|---|---|
| Invoice status and days late (Chicago calendar day) | Reading a message into date, amount, confidence |
| The next action | Drafting the reminder wording |
| Whether a promise is accepted | |
| Whether a draft may be shown or sent | |
| Recording payments from verified webhooks | |
| All money as integer cents | |

Customer messages are passed to the model as delimited data, never as instructions.

## Run it

Requires **Node.js 24 or newer** (it uses the built-in `node:sqlite`).

### 1. Quick start (no keys needed)

```bash
git clone https://github.com/stallion12345/PanaPay.git
cd PanaPay
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run seed
npm run seed:history
npm start
```

Open <http://localhost:3000>. With no keys you get the board, Overview, customer panels with evidence, next actions and standard-wording drafts. Adding a note saves it, but the AI step reports that it could not read it.

### 2. Turn on the AI

In `.env` set:

```
LLM_PROVIDER=gemini
LLM_API_KEY=<your Gemini API key>   # a free key works
LLM_MODEL=gemini-3.5-flash-lite
```

Restart. Now pasting "I'll pay the $160 on Friday" into a customer's **Add note** box creates a promise, and drafts are AI-written.

### 3. Turn on the live PayPal flow (create, pay, update)

Create a free sandbox app at <https://developer.paypal.com>, then set in `.env`:

```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_MERCHANT_EMAIL=<your sandbox BUSINESS account email>
CUSTOMER_EMAIL=<a sandbox PERSONAL account email that will pay>
```

`CUSTOMER_EMAIL` becomes the **Sandbox Customer**, the only customer that can be invoiced. Set it **before seeding**; if you set it later, delete the database file in `data/` and run both seed commands again.

For the live "Paid" update, PayPal must reach your machine:

1. Start a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000`.
2. In your sandbox app, add a webhook with URL `https://<your-tunnel>/webhook` subscribed to the Invoicing events (including **Invoice paid**).
3. Put the webhook's ID in `PAYPAL_WEBHOOK_ID` and restart.

Then click **+ New invoice**, choose Sandbox Customer, open the payer link, pay with your sandbox personal account, and watch the board flip to Paid. (Tunnel addresses change every time you restart them, so update the webhook URL if you do.)

No credentials are shipped in this repository. Use your own free sandbox accounts.

## Demo data and what is real

The history in the demo (four customers, their invoices and promises) is **seeded and labelled "Demo data"**, because the PayPal sandbox cannot age invoices or back-date payments. Seeded dates are set relative to the day you run the seed. Seeded invoices do not exist in PayPal, so PayPal reminders are only offered on invoices created through the app.

**Real:** invoice creation, sending and reminders through PayPal, the payer link, the signed webhook, payment recording, and the status update.

## Tests

```bash
npm test
```

150+ automated tests cover the status rules (including Chicago-time edge cases and DST), promise extraction with a fake model, draft checks, next-action rules, webhook handling against a real PayPal event fixture, and the API routes. PayPal and the model are stubbed, so the tests need no keys.

## Limitations

- Messages are **pasted in by the owner**. Automatic capture from WhatsApp and SMS is not built.
- The history is seeded, and everything runs against the PayPal **sandbox** only.
- One merchant, no login. Do not expose it to the public internet.
- Models are not deterministic. A vague message may be held as unconfirmed or ignored, which is why the owner confirms or rejects.
- Nothing is sent automatically. PayPal allows only two reminders per day per invoice.
- `src/` still contains modules from an earlier cash-flow prototype (categorizer, forecast, escalation rules, supplier payouts). They are not part of the product or its interface.

## Roadmap

- Capture promises automatically from WhatsApp and SMS.
- CSV import of existing invoices.
- Opt-in scheduled reminders.
- Hosted demo.

## Tools used

Node.js 24, Express 5, SQLite (`node:sqlite`), Zod, AG Grid Community (the receivables board), PayPal Invoicing API v2 and webhooks (sandbox), Google Gemini via a single adapter. Claude and Cline were used as coding assistants.

## Project layout

```
src/server.js                    API routes and webhook
src/db.js                        schema and database
src/lib/paypal.js                PayPal Invoicing and webhook verification
src/lib/llm.js                   model adapter
src/lib/receivables/             status, profile, extract, nextAction, draft
public/                          the web app (plain JavaScript + AG Grid)
scripts/seed-base.mjs            merchant and customers
scripts/seed-history.mjs         demo invoices and promises
```

## License

MIT. See [LICENSE](LICENSE).

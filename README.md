# PanaPay

## 1. What it is and who it's for

- PanaPay is a small PayPal sandbox cash-flow dashboard for a micro-merchant.
- It is built for Ngozi, a Houston fabric shop owner who needs a quick view of cash in, cash out, and payment status.
- The app helps track supplier payouts, recent ledger activity, and support questions without guessing.
- It is designed for a single merchant, not a large multi-tenant platform.
- It keeps a plain, local dashboard with a simple Express + SQLite backend and a lightweight browser UI.

## 2. Screenshots placeholder list

- Home dashboard (safe-to-spend, weekly limit, forecast area, alert banner)
- Ledger view (AG Grid table with category, reason, and status)
- Pay supplier form
- Support assistant chat screen
- Escalation queue page
- Webhook or payout status example (if added locally)

## 3. How it uses PayPal and AI

PayPal use:
- The app uses the PayPal sandbox base URL: `https://api-m.sandbox.paypal.com`.
- It can create payouts with OAuth2 client-credentials auth and logs any non-2xx PayPal response with status and `debug_id` before stopping.
- The webhook route reads the raw request body and checks the PayPal signature before it allows processing.
- The code includes a payout flow and webhook handling for payouts. Invoicing was not implemented as a confirmed live feature in this repo, so it is not claimed as built.

AI use:
- The categorizer is in `src/lib/categorizer.js` and calls the single LLM adapter in `src/lib/llm.js` to classify a ledger item.
- The model output is validated with `zod`; if the confidence is below `0.7` or the output fails validation, the entry is set to category `Other` and marked `needs review`.
- The support assistant is in `src/server.js` and uses tool functions that read the local database. It does not send money or call PayPal.
- Escalation rules are hard-coded in `src/lib/escalation-rules.js`; they trigger before a model answer if the issue matches dispute/refund/fraud language, amounts over $500, a request for a human, or repeated unresolved questions.

Deterministic code vs AI:
- Deterministic code: payout validation, duplicate protection, webhook verification, forecast calculations, escalation rule checks, database writes, and cash-flow safe-to-spend logic.
- AI: categorization of ledger entries and support-agent responses, both scoped to the current merchant data and a controlled tool set.

## 4. Setup (under 10 steps)

1. Install Node.js 20 or newer. This project uses ES modules and built-in `node:sqlite`.
2. In the repo root, run: `npm install`
3. Copy `.env.example` to `.env`.
4. Fill in the required values in `.env`:
   - `PORT`
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
   - `PAYPAL_WEBHOOK_ID`
   - `LLM_PROVIDER`
   - `LLM_API_KEY`
   - `PAYOUT_RECEIVER_EMAIL`
5. Create PayPal sandbox credentials in the PayPal Developer Dashboard. Use a Business account for the merchant and Personal or Business sandbox accounts for recipients as needed.
6. Create the US sandbox accounts for the merchant and supplier flow. Use U.S.-based accounts only; this repo intentionally does not rely on unsupported non-U.S. sandbox accounts.
7. Start the app: `npm start`
8. Open `http://localhost:3000` in a browser.
9. For webhook testing, expose the local app with a tunnel such as ngrok or Cloudflare Tunnel, then configure the PayPal webhook to point at `https://<your-tunnel>/webhook`.
10. Seed the merchant and supplier data by running: `node scripts/seed-demo.mjs` (this script sends payout requests through the app API, not by inserting fake rows).

## 5. Test accounts and sandbox notes for judges

- Use sandbox accounts only. Do not use real PayPal accounts.
- Merchant: a U.S. sandbox Business account.
- Suppliers: U.S. sandbox Personal or Business recipients.
- Keep all credentials in `.env` and do not check them into the repo.
- The app expects sandbox credentials and uses the PayPal sandbox API base URL.
- The project does not ship any secret values in code or in the repository.

## 6. Honest limitations

- This sandbox flow is intentionally limited to U.S. PayPal sandbox accounts. The project notes that PayPal payouts failed on Nigerian sandbox accounts, while U.S. sandbox accounts were used successfully.
- The repo does not claim that every PayPal integration path is fully live in all regions or account types.
- Invoicing was not finished as a verified live feature in this codebase, so the project does not claim a complete PayPal Invoicing implementation.
- The forecast area and app still include some static/demo-shaped presentation elements in the current browser state, even though the server exposes forecast data and the ledger is live-backed.
- Not built: full multi-merchant support, full invoice management, hosted demo deployment, and complete fraud scoring beyond the current scoped code.

## 7. Tools used

- GitHub Copilot: used for coding assistance, implementation iteration, and review during the project build.
- Node.js: runtime for the Express app and test suite.
- Express: web server and API layer.
- `node:sqlite`: local SQLite database for merchant, ledger, payout, and support-thread data.
- HTML/CSS/JavaScript: browser front end in `public/`.
- AG Grid Community: used by the ledger view via CDN for the table display.
- OpenAI (configured via `LLM_PROVIDER=openai` and `LLM_API_KEY`): used by the single adapter in `src/lib/llm.js` for the categorizer.
- Zod: validates the LLM response before writing the category and confidence back to the ledger.
- PayPal Developer Dashboard: used to create sandbox accounts and webhook configuration.

## 8. What is new during the submission period

- Everything in this repository was created during the current submission period.
- This includes the Node/Express server, SQLite schema, payout flow, webhook verification, support-thread flow, support assistant, escalation logic, forecast helpers, and the browser UI.
- The repo has not been previously published as a stable product; it is a current hackathon build.

## 9. License

- No explicit license file is included in this repository at the time of writing.
- This means the project is not currently declaring a repository license in code.
- If this is being prepared for public release, a LICENSE file should be added before redistribution.

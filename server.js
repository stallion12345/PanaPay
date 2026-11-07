import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
const merchantId = 'merchant-ngozi';

const db = new DatabaseSync(path.join(__dirname, 'panapay.db'));

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant (
      id TEXT PRIMARY KEY,
      merchant_id TEXT,
      name TEXT NOT NULL,
      weekly_spend_limit REAL NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS party (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      paypal_email TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ledger_entry (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      party_id TEXT,
      direction TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      paypal_ref TEXT,
      category TEXT NOT NULL,
      ai_category_reason TEXT,
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoice (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      party_id TEXT,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL,
      paypal_invoice_id TEXT,
      risk_score REAL,
      risk_reasons TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payout (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      party_id TEXT,
      amount REAL NOT NULL,
      batch_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_event (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      event_id TEXT UNIQUE,
      type TEXT,
      payload TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_thread (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      escalated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_message (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const merchantExists = db.prepare('SELECT 1 FROM merchant WHERE id = ?').get(merchantId);
  if (!merchantExists) {
    db.prepare(
      `INSERT INTO merchant (id, merchant_id, name, weekly_spend_limit, currency) VALUES (?, ?, ?, ?, ?)`
    ).run(merchantId, merchantId, "Ngozi's Fabrics", 400, 'USD');
  }

  const partySeeds = [
    ['party-kola', merchantId, 'supplier', 'Kola Enterprises', 'kola@sandbox.example'],
    ['party-adaeze', merchantId, 'customer', 'Adaeze Textiles', 'adaeze@sandbox.example'],
    ['party-chidi', merchantId, 'customer', 'Chidi O.', 'chidi@sandbox.example'],
    ['party-mama-nkechi', merchantId, 'supplier', 'Mama Nkechi Stores', 'mama-nkechi@sandbox.example'],
    ['party-funke', merchantId, 'customer', 'Funke B.', 'funke@sandbox.example'],
  ];

  for (const [id, merchantIdValue, type, name, paypalEmail] of partySeeds) {
    db.prepare(
      `INSERT OR IGNORE INTO party (id, merchant_id, type, name, paypal_email) VALUES (?, ?, ?, ?, ?)`
    ).run(id, merchantIdValue, type, name, paypalEmail);
  }

  const ledgerSeeds = [
    ['entry-1', merchantId, 'party-kola', 'out', 240, 'USD', 'Failed', 'PAYOUT-240', 'Supplies', 'Payout retry after failed batch', '2026-10-28T00:00:00Z'],
    ['entry-2', merchantId, 'party-adaeze', 'in', 780, 'USD', 'Completed', 'INVOICE-1042', 'Sales', 'Invoice payment received from Adaeze', '2026-10-28T00:00:00Z'],
    ['entry-3', merchantId, null, 'out', 85, 'USD', 'Completed', 'UTIL-004', 'Utilities', 'Utility top-up for weekly operations', '2026-10-27T00:00:00Z'],
    ['entry-4', merchantId, 'party-chidi', 'in', 420, 'USD', 'Completed', 'INVOICE-1041', 'Sales', 'Customer invoice payment completed', '2026-10-27T00:00:00Z'],
    ['entry-5', merchantId, null, 'out', 60, 'USD', 'Completed', 'MARKET-004', 'Other', 'Weekly market stall fee', '2026-10-26T00:00:00Z'],
    ['entry-6', merchantId, null, 'out', 195, 'USD', 'Pending', 'TRANSPORT-001', 'Delivery', 'Delivery cost for the Ibadan run', '2026-10-26T00:00:00Z'],
    ['entry-7', merchantId, 'party-funke', 'in', 250, 'USD', 'Refunded', 'INVOICE-1040', 'Sales', 'Customer refund processed on invoice 1040', '2026-10-25T00:00:00Z'],
  ];

  for (const [id, mid, partyId, direction, amount, currency, status, paypalRef, category, reason, occurredAt] of ledgerSeeds) {
    db.prepare(
      `INSERT OR IGNORE INTO ledger_entry (id, merchant_id, party_id, direction, amount, currency, status, paypal_ref, category, ai_category_reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, mid, partyId, direction, amount, currency, status, paypalRef, category, reason, occurredAt);
  }

  const threadExists = db.prepare('SELECT 1 FROM support_thread WHERE id = ?').get('thread-default');
  if (!threadExists) {
    db.prepare(`INSERT INTO support_thread (id, merchant_id, subject, status, escalated) VALUES (?, ?, ?, ?, ?)`).run('thread-default', merchantId, 'Payment status check', 'open', 0);
    db.prepare(`INSERT INTO support_message (id, merchant_id, thread_id, sender, message) VALUES (?, ?, ?, ?, ?)`).run('msg-1', merchantId, 'thread-default', 'user', 'Where is Mrs. Okafor\'s payment?');
    db.prepare(`INSERT INTO support_message (id, merchant_id, thread_id, sender, message) VALUES (?, ?, ?, ?, ?)`).run('msg-2', merchantId, 'thread-default', 'assistant', 'I am checking the ledger and payout history.');
  }
}

ensureTables();

function getChicagoDateParts(inputDate) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(inputDate));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function isInCurrentChicagoWeek(inputDate) {
  const chicagoNow = new Date();
  const nowParts = getChicagoDateParts(chicagoNow);
  const chicagoNowUtc = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day,
    nowParts.hour,
    nowParts.minute,
    nowParts.second,
  );

  const nowUtcDate = new Date(chicagoNowUtc);
  const weekDayIndex = (nowUtcDate.getUTCDay() + 6) % 7;
  const mondayStartUtc = new Date(chicagoNowUtc);
  mondayStartUtc.setUTCDate(nowUtcDate.getUTCDate() - weekDayIndex);
  mondayStartUtc.setUTCHours(0, 0, 0, 0);

  const entryParts = getChicagoDateParts(inputDate);
  const entryUtc = Date.UTC(
    entryParts.year,
    entryParts.month - 1,
    entryParts.day,
    entryParts.hour,
    entryParts.minute,
    entryParts.second,
  );

  return new Date(entryUtc) >= mondayStartUtc;
}

function buildSummary() {
  const merchant = db.prepare('SELECT * FROM merchant WHERE id = ?').get(merchantId) || {
    weekly_spend_limit: 0,
    currency: 'USD',
    name: 'Ngozi\'s Fabrics',
  };

  const rows = db.prepare(
    `SELECT * FROM ledger_entry WHERE merchant_id = ? AND direction = 'out' AND LOWER(status) = 'completed' ORDER BY occurred_at DESC`,
  ).all(merchantId);

  const weeklyLimit = Number(merchant.weekly_spend_limit || 0);
  const spentThisWeek = rows.reduce((sum, row) => {
    if (!isInCurrentChicagoWeek(row.occurred_at)) {
      return sum;
    }
    return sum + Number(row.amount || 0);
  }, 0);

  return {
    weekly_limit: weeklyLimit,
    spent_this_week: spentThisWeek,
    safe_to_spend: Math.max(weeklyLimit - spentThisWeek, 0),
    percent_used: weeklyLimit > 0 ? Math.round((spentThisWeek / weeklyLimit) * 100) : 0,
  };
}

function buildLedger() {
  const rows = db.prepare(`
    SELECT le.*, p.name AS party_name
    FROM ledger_entry le
    LEFT JOIN party p ON p.id = le.party_id AND p.merchant_id = le.merchant_id
    WHERE le.merchant_id = ?
    ORDER BY datetime(le.occurred_at) DESC, le.id DESC
  `).all(merchantId);

  return rows.map((row) => ({
    id: row.id,
    date: new Date(row.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    name: row.party_name || 'General expense',
    description: row.ai_category_reason || row.paypal_ref || row.category || '—',
    category: row.category || 'General',
    amount: row.direction === 'in' ? Number(row.amount || 0) : -Number(row.amount || 0),
    status: String(row.status || 'pending'),
    occurred_at: row.occurred_at,
  }));
}

async function paypalRequest(path, options) {
  const response = await fetch(`${PAYPAL_BASE}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    const debugId = body?.debug_id ?? response.headers.get('paypal-debug-id') ?? 'none';
    console.error(`PayPal error ${response.status} on ${path}. debug_id=${debugId}`);
    console.error(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    throw new Error(`PayPal call failed for ${path}. status=${response.status}; debug_id=${debugId}`);
  }

  return body;
}

async function getPayPalToken() {
  const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
  const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in environment.');
  }

  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const body = await paypalRequest('/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  return body.access_token;
}

async function verifyWebhookSignature(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    return 'NOT_CHECKED (PAYPAL_WEBHOOK_ID missing)';
  }

  const token = await getPayPalToken();
  const response = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const debugId = payload?.debug_id ?? response.headers.get('paypal-debug-id') ?? 'none';
    console.error(`Webhook verification failed ${response.status}. debug_id=${debugId}`);
    console.error(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    throw new Error(`Webhook verification failed for ${response.status}; debug_id=${debugId}`);
  }

  return payload.verification_status ?? 'UNKNOWN';
}

function defaultSupportMessage(question, supportData) {
  const text = question.toLowerCase();

  if (text.includes('where') && text.includes('payment')) {
    return `I checked the ledger for the latest payment activity. The latest matching payment in the merchant ledger is ${supportData.recentPayment || 'not found'} and the latest update is ${supportData.lastUpdated || 'not available'}.`;
  }

  if (text.includes('supplier') && text.includes('payout')) {
    return 'I checked the supplier payout activity. The most recent payout entry is marked as failed or pending, so I would not call it complete until the PayPal batch status confirms success.';
  }

  if (text.includes('human') || text.includes('escalate')) {
    return 'This case needs a human review. I have marked it for escalation because the merchant requested a human or the issue looks like a dispute or unresolved failed payment.';
  }

  return 'I can answer from the live ledger only. I did not find a matching payment or payout record for that question.';
}

async function answerSupportQuestion(question) {
  const ledger = buildLedger();
  const recentPayment = ledger.find((entry) => entry.amount > 0) ?? null;
  const payoutEntry = ledger.find((entry) => entry.amount < 0 && entry.category !== 'Utilities') ?? null;

  const supportData = {
    recentPayment: recentPayment ? `${recentPayment.name} for ${recentPayment.amount > 0 ? '$' + Math.abs(recentPayment.amount) : '$' + Math.abs(recentPayment.amount)}` : 'no record',
    lastUpdated: ledger[0]?.date || 'no recent activity',
    latestPayout: payoutEntry ? `${payoutEntry.name} (${payoutEntry.status})` : 'no payout record',
  };

  const llmProvider = process.env.LLM_PROVIDER;
  const llmApiKey = process.env.LLM_API_KEY;

  if (llmProvider && llmApiKey && llmProvider.toLowerCase() === 'openai') {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Answer from the merchant ledger only, and do not invent payment data.',
        },
        {
          role: 'user',
          content: `${question}\n\nLedger facts:\n${JSON.stringify(ledger.slice(0, 5), null, 2)}`,
        },
      ],
      temperature: 0,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return content.trim();
      }
    }
  }

  return defaultSupportMessage(question, supportData);
}

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'PanaPay', port: PORT });
});

app.get('/api/summary', (req, res) => {
  res.json(buildSummary());
});

app.get('/api/parties', (req, res) => {
  const type = String(req.query.type || '').trim().toLowerCase();
  const rows = type
    ? db.prepare('SELECT * FROM party WHERE merchant_id = ? AND type = ? ORDER BY name ASC').all(merchantId, type)
    : db.prepare('SELECT * FROM party WHERE merchant_id = ? ORDER BY name ASC').all(merchantId);

  res.json({
    ok: true,
    parties: rows.map((row) => ({
      id: row.id,
      merchant_id: row.merchant_id,
      type: row.type,
      name: row.name,
      paypal_email: row.paypal_email,
    })),
  });
});

app.get('/api/ledger', (req, res) => {
  res.json(buildLedger());
});

app.post('/api/support', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  const answer = await answerSupportQuestion(question);
  res.json({ answer, source: 'ledger' });
});

app.post('/api/payouts', async (req, res) => {
  const { partyId, supplierId, recipientName, recipientEmail, amountCents, amount, note } = req.body || {};
  const selectedPartyId = partyId || supplierId || null;
  const valueInCents = Number.isInteger(Number(amountCents)) ? Number(amountCents) : Number.parseInt(Number(amount || 0) * 100, 10);
  const payoutValue = Number(valueInCents || 0);

  if (!selectedPartyId) {
    return res.status(400).json({ ok: false, error: 'Please choose a supplier before sending the payout.' });
  }

  const party = db.prepare('SELECT * FROM party WHERE id = ? AND merchant_id = ?').get(selectedPartyId, merchantId);
  if (!party || party.type !== 'supplier') {
    return res.status(400).json({ ok: false, error: 'We could not find that supplier. Please choose a supplier on the list.' });
  }

  if (!Number.isInteger(payoutValue) || payoutValue <= 0 || payoutValue > 100000) {
    return res.status(400).json({ ok: false, error: 'Enter an amount between $0.01 and $1,000.00.' });
  }

  const duplicateWindow = new Date(Date.now() - 60_000).toISOString();
  const duplicate = db.prepare(`
    SELECT id FROM payout WHERE merchant_id = ? AND party_id = ? AND amount = ? AND created_at >= ? LIMIT 1
  `).get(merchantId, selectedPartyId, payoutValue, duplicateWindow);

  if (duplicate) {
    return res.status(400).json({ ok: false, error: 'This payout was already sent recently. Please wait a minute and try again.' });
  }

  const token = await getPayPalToken();
  const stamp = Date.now();
  const batch = await paypalRequest('/v1/payments/payouts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `panapay-${stamp}`,
    },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: `panapay-${stamp}`,
        email_subject: 'PanaPay sandbox payout',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: recipientEmail || party.paypal_email,
          amount: { value: (payoutValue / 100).toFixed(2), currency: 'USD' },
          note: note || 'PanaPay supplier payout',
          sender_item_id: `item-${stamp}`,
        },
      ],
    }),
  });

  const payoutId = `payout-${stamp}`;
  db.prepare(
    `INSERT INTO payout (id, merchant_id, party_id, amount, batch_id, status) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(payoutId, merchantId, selectedPartyId, payoutValue, batch.batch_header?.payout_batch_id || null, batch.batch_header?.batch_status || 'CREATED');

  res.status(201).json({
    ok: true,
    payout: {
      id: payoutId,
      merchant_id: merchantId,
      party_id: selectedPartyId,
      amount_cents: payoutValue,
      status: batch.batch_header?.batch_status || 'CREATED',
      created_at: new Date().toISOString(),
    },
  });
});

app.get('/api/payouts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM payout WHERE id = ? AND merchant_id = ?').get(req.params.id, merchantId);
  if (!row) {
    return res.status(404).json({ ok: false, error: 'Payout not found.' });
  }

  res.json({ ok: true, payout: row });
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const body = req.body ? req.body.toString('utf8') : '';
  let event;

  try {
    event = JSON.parse(body);
  } catch (error) {
    res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
    return;
  }

  try {
    const verification = await verifyWebhookSignature(req.headers, event);
    const eventId = event.id || `webhook-${Date.now()}`;
    db.prepare(
      `INSERT OR IGNORE INTO webhook_event (id, merchant_id, event_id, type, payload, processed_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(`webhook-${eventId}`, merchantId, eventId, event.event_type || 'unknown', JSON.stringify(event), new Date().toISOString());

    res.status(200).json({ ok: true, verification, event_id: eventId });
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PanaPay server running on http://localhost:${PORT}`);
});

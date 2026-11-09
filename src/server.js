import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { db, ensureDefaultMerchant } from './db.js';
import { categorize } from './lib/categorizer.js';
import { evaluateEscalation } from './lib/escalation-rules.js';
import { limitAlarm, lowPoint, projectBalance, weeklyBuckets } from './lib/forecast.js';
import { createInvoice, createPayout, extractInvoiceId, getInvoice, sendInvoice, verifyWebhookSignature } from './lib/paypal.js';
import { derive, toChicagoDateKey, computeDaysLate } from './lib/receivables/status.js';
import { buildProfile } from './lib/receivables/profile.js';
import { callModel } from './lib/llm.js';
import { extractPromise } from './lib/receivables/extract.js';
import { computeNextAction, pickPromise } from './lib/receivables/nextAction.js';
import { buildFacts, draftMessage } from './lib/receivables/draft.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const DEFAULT_MERCHANT_ID = 1;

export function validateSupplierPayoutRequest({ partyId, amountCents, note, merchantId = DEFAULT_MERCHANT_ID, now = Date.now() }) {
  if (!partyId || typeof partyId !== 'string') {
    return { ok: false, message: 'Please choose a supplier before sending the payout.' };
  }

  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100000) {
    return { ok: false, message: 'Enter an amount between $0.01 and $1,000.00.' };
  }

  const party = db.prepare('SELECT id, merchant_id, type, paypal_email FROM party WHERE id = ?').get(partyId);
  if (!party) {
    return { ok: false, message: 'We could not find that supplier. Please choose a supplier on the list.' };
  }

  if (party.type !== 'supplier') {
    return { ok: false, message: 'That contact is not a supplier, so it cannot receive a payout.' };
  }

  if (party.merchant_id !== merchantId) {
    return { ok: false, message: 'That supplier is not linked to this merchant.' };
  }

  const duplicateWindow = new Date(now - 60_000).toISOString();
  const duplicate = db.prepare(`
    SELECT id
    FROM payout
    WHERE merchant_id = ?
      AND party_id = ?
      AND amount_cents = ?
      AND created_at >= ?
    LIMIT 1
  `).get(merchantId, partyId, amountCents, duplicateWindow);

  if (duplicate) {
    return { ok: false, message: 'This payout was already sent recently. Please wait a minute and try again.' };
  }

  return { ok: true, party };
}

export function validateInvoiceCreateRequest({ customerId, amountCents, dueDate, description, merchantId = DEFAULT_MERCHANT_ID }) {
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return { ok: false, error: 'Please choose a customer before creating the invoice.' };
  }

  const customer = db.prepare('SELECT id, merchant_id, paypal_email FROM customer WHERE id = ? AND merchant_id = ?').get(Number(customerId), merchantId);
  if (!customer) {
    return { ok: false, error: 'We could not find that customer for this merchant.' };
  }

  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 500000) {
    return { ok: false, error: 'Enter an amount between $0.01 and $5,000.00.' };
  }

  if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())) {
    return { ok: false, error: 'The due date must be in YYYY-MM-DD format.' };
  }

  const normalizedDueDate = dueDate.trim();
  const due = new Date(`${normalizedDueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) {
    return { ok: false, error: 'The due date must be in YYYY-MM-DD format.' };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (due < today) {
    return { ok: false, error: 'The due date must be today or later.' };
  }

  return { ok: true, customer, dueDate: normalizedDueDate, description: typeof description === 'string' ? description.trim() : '' };
}

function queueCategorization(entry) {
  Promise.resolve()
    .then(() => categorize(entry))
    .catch((error) => {
      console.error('[categorizer] failed:', error.message);
    });
}

function getPaymentStatus(entryId) {
  if (!entryId) {
    return { ok: false, error: 'No entryId was provided.' };
  }

  const row = db.prepare(`
    SELECT le.id, le.direction, le.amount_cents, le.currency, le.status, le.description, p.name AS party_name
    FROM ledger_entry le
    LEFT JOIN party p ON p.id = le.party_id AND p.merchant_id = le.merchant_id
    WHERE le.id = ? AND le.merchant_id = ?
  `).get(entryId, DEFAULT_MERCHANT_ID);

  if (!row) {
    return { ok: false, error: 'No payment record found for that entry.' };
  }

  return { ok: true, entry: row };
}

function listRecentEntries(limit = 5) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 5;
  const rows = db.prepare(`
    SELECT le.id, le.direction, le.amount_cents, le.currency, le.status, le.description, p.name AS party_name
    FROM ledger_entry le
    LEFT JOIN party p ON p.id = le.party_id AND p.merchant_id = le.merchant_id
    WHERE le.merchant_id = ?
    ORDER BY datetime(le.occurred_at) DESC, le.id DESC
    LIMIT ?
  `).all(DEFAULT_MERCHANT_ID, safeLimit);

  return { ok: true, entries: rows };
}

function getPayoutStatus(payoutId) {
  if (!payoutId) {
    return { ok: false, error: 'No payoutId was provided.' };
  }

  const row = db.prepare('SELECT * FROM payout WHERE id = ? AND merchant_id = ?').get(payoutId, DEFAULT_MERCHANT_ID);
  if (!row) {
    return { ok: false, error: 'No payout record found for that ID.' };
  }

  return { ok: true, payout: row };
}

function getForecast() {
  const merchant = db.prepare('SELECT weekly_spend_limit FROM merchant WHERE id = ?').get(DEFAULT_MERCHANT_ID) ?? { weekly_spend_limit: 0 };
  const weeklyLimit = Number(merchant.weekly_spend_limit || 0);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);

  const entries = db.prepare(`
    SELECT id, merchant_id, party_id, direction, amount_cents, currency, status, description, occurred_at
    FROM ledger_entry
    WHERE merchant_id = ?
      AND occurred_at IS NOT NULL
    ORDER BY datetime(occurred_at) DESC
    LIMIT 200
  `).all(DEFAULT_MERCHANT_ID);

  const buckets = weeklyBuckets(entries, start.toISOString(), 4);
  const projection = projectBalance(0, buckets);
  const low = lowPoint(projection);
  const spentThisWeek = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM ledger_entry
    WHERE merchant_id = ?
      AND direction = 'out'
      AND status = 'completed'
      AND occurred_at >= ?
  `).get(DEFAULT_MERCHANT_ID, start.toISOString()).total;

  return {
    ok: true,
    weeklyLimit,
    spentThisWeek: Number(spentThisWeek || 0),
    safeToSpend: Math.max(weeklyLimit - Number(spentThisWeek || 0), 0),
    lowPoint: low,
    projection,
  };
}

function escalateToHuman(reason, severity = 'medium') {
  const safeReason = String(reason || 'Escalation requested by the support assistant.').slice(0, 200);
  const safeSeverity = ['low', 'medium', 'high'].includes(String(severity || '').toLowerCase()) ? String(severity).toLowerCase() : 'medium';

  return {
    ok: true,
    escalated: true,
    reason: safeReason,
    severity: safeSeverity,
  };
}

async function runSupportTool(name, args = {}) {
  const toolMap = {
    get_payment_status: () => getPaymentStatus(args.entryId),
    list_recent_entries: () => listRecentEntries(Number(args.limit ?? 5)),
    get_payout_status: () => getPayoutStatus(args.payoutId),
    get_forecast: () => getForecast(),
    escalate_to_human: () => escalateToHuman(args.reason, args.severity),
  };

  if (!toolMap[name]) {
    return { ok: false, error: `Tool "${name}" is not available.` };
  }

  return toolMap[name]();
}

function findOrCreateThread(threadId) {
  if (threadId) {
    const existing = db.prepare('SELECT * FROM support_thread WHERE id = ? AND merchant_id = ?').get(threadId, DEFAULT_MERCHANT_ID);
    if (existing) return existing;
  }

  const createdId = threadId || `thread-${randomUUID()}`;
  db.prepare(`
    INSERT INTO support_thread (id, merchant_id, escalated, escalation_reason, severity)
    VALUES (?, ?, 0, NULL, NULL)
  `).run(createdId, DEFAULT_MERCHANT_ID);

  return db.prepare('SELECT * FROM support_thread WHERE id = ? AND merchant_id = ?').get(createdId, DEFAULT_MERCHANT_ID);
}

async function buildAssistantReply({ threadId, message, threadMessages = [] }) {
  const system = 'You are PanaPay support. Use only tool results to answer. If the tool results are empty or not relevant, say you have no data and offer to escalate.';
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_payment_status',
        description: 'Get the ledger status for a specific payment entry by entry ID.',
        parameters: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_recent_entries',
        description: 'List recent ledger entries for the merchant.',
        parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['limit'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_payout_status',
        description: 'Get payout details by payout ID.',
        parameters: { type: 'object', properties: { payoutId: { type: 'string' } }, required: ['payoutId'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_forecast',
        description: 'Get the current merchant forecast and safe-to-spend numbers.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];

  const provider = process.env.LLM_PROVIDER;
  const apiKey = process.env.LLM_API_KEY;

  if (!provider || !apiKey) {
    const recent = listRecentEntries(5);
    const forecast = getForecast();
    const relevantTools = [recent, forecast].filter((result) => result && result.ok);
    const hasData = relevantTools.length > 0;
    const fallback = hasData
      ? `I checked the latest ledger and forecast data. I do not see enough information to answer this specific question, so I can escalate it for a human.`
      : 'I have no data to answer that question yet and can escalate it for a human.';
    return { reply: fallback, toolResults: relevantTools, usedToolCalls: 0 };
  }

  const inputMessages = [
    ...threadMessages.map((row) => ({ role: row.role, content: String(row.content ?? '') })),
    { role: 'user', content: String(message ?? '') },
  ];

  const results = [];
  let toolCallsUsed = 0;
  let finalText = '';

  for (let i = 0; i < 4; i += 1) {
    let modelResponse;
    try {
      modelResponse = await import('./lib/llm.js').then(({ callModel }) => callModel({
        system,
        messages: inputMessages,
        tools,
      }));
    } catch (error) {
      const fallback = `I do not have enough live data to answer that question. I can escalate this for a human.`;
      return { reply: fallback, toolResults: results, usedToolCalls: toolCallsUsed };
    }

    const calls = Array.isArray(modelResponse?.toolCalls) ? modelResponse.toolCalls : [];
    if (calls.length === 0) {
      finalText = (modelResponse && modelResponse.text) ? modelResponse.text : '';
      break;
    }

    for (const call of calls) {
      if (toolCallsUsed >= 4) {
        break;
      }

      const toolName = call && typeof call.name === 'string' ? call.name : null;
      if (!toolName) {
        const errorResult = { ok: false, error: 'The model called a tool without a name.' };
        results.push(errorResult);
        inputMessages.push({ role: 'tool', tool_call_id: call?.id || `tool-${Date.now()}`, content: JSON.stringify(errorResult) });
        continue;
      }

      const parsed = (() => {
        try {
          return JSON.parse(call.arguments || '{}');
        } catch {
          return {};
        }
      })();

      const toolResult = await runSupportTool(toolName, parsed);
      results.push(toolResult);
      inputMessages.push({ role: 'tool', tool_call_id: call?.id || `tool-${Date.now()}`, content: JSON.stringify(toolResult) });
      toolCallsUsed += 1;
    }

    if (toolCallsUsed >= 4) {
      break;
    }
  }

  if (!finalText) {
    const relevant = results.filter((result) => result && result.ok && (result.entry || result.entries || result.payout || result.projection || result.weeklyLimit !== undefined));
    if (relevant.length === 0) {
      finalText = 'I have no data to answer that question from the merchant records, and I can escalate it for a human if you want.';
    } else {
      finalText = 'I checked the merchant records and there is not enough detail to answer that question precisely. I can escalate it for a human.';
    }
  }

  return { reply: finalText, toolResults: results, usedToolCalls: toolCallsUsed };
}

function updateThreadEscalation(threadId, reason, severity) {
  db.prepare(`
    UPDATE support_thread
    SET escalated = 1,
        escalation_reason = ?,
        severity = ?
    WHERE id = ?
      AND merchant_id = ?
  `).run(String(reason || 'Escalated by policy'), String(severity || 'medium'), threadId, DEFAULT_MERCHANT_ID);
}

function mapPayPalStatusToLocalStatus(paypalStatus) {
  const normalized = String(paypalStatus || '').trim().toUpperCase();

  if (normalized === 'SUCCESS') return 'completed';
  if (['FAILED', 'DENIED', 'RETURNED', 'BLOCKED'].includes(normalized)) return 'failed';
  return 'pending';
}

function toChicagoDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

function parseMoneyStringToCents(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const raw = String(value).trim();
  if (!raw) {
    return 0;
  }

  const sign = raw.startsWith('-') ? -1 : 1;
  const unsigned = raw.replace(/^-/, '');
  if (!/^\d+(?:\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid money value: ${value}`);
  }

  const [wholePart, fractionalPart = ''] = unsigned.split('.');
  const centsString = `${fractionalPart.padEnd(2, '0')}`.slice(0, 2);
  const wholeCents = Number.parseInt(wholePart || '0', 10) * 100;
  const fractionalCents = Number.parseInt(centsString || '0', 10);

  return (wholeCents + fractionalCents) * sign;
}

export function applyInvoicePaymentWebhookEvent(event, merchantId = DEFAULT_MERCHANT_ID) {
  const resource = event?.resource ?? {};
  const invoiceResource = resource?.invoice;
  if (!invoiceResource || !invoiceResource.id) {
    return { action: 'ignored', handled: false, reason: 'missing invoice resource' };
  }

  const invoiceId = String(invoiceResource.id);
  const invoice = db.prepare(`
    SELECT *
    FROM invoice
    WHERE merchant_id = ? AND paypal_invoice_id = ?
  `).get(merchantId, invoiceId);

  if (!invoice) {
    console.log(`[webhook] invoice ${invoiceId} not found locally; ignoring event ${event?.id ?? 'unknown'}`);
    return { action: 'ignored', handled: false, reason: 'invoice not found' };
  }

  const targetCurrency = String(invoice.currency || '').toUpperCase();
  const eventCurrency = String(invoiceResource.amount?.currency_code || invoiceResource.currency_code || invoiceResource.detail?.currency_code || '').toUpperCase();
  if (targetCurrency && eventCurrency && targetCurrency !== eventCurrency) {
    console.log(`[webhook] currency mismatch for invoice ${invoiceId}: expected ${targetCurrency}, got ${eventCurrency}`);
    return { action: 'currency mismatch ignored', handled: false, reason: 'currency mismatch' };
  }

  
  const transactions = Array.isArray(invoiceResource.payments?.transactions) ? invoiceResource.payments.transactions : [];
  let sawSuccessfulTransaction = false;

  for (const transaction of transactions) {
    const transactionStatus = String(transaction?.transaction_status ?? '').toUpperCase();
    if (transactionStatus !== 'SUCCESS') {
      console.log(`[webhook] ignoring invoice payment transaction ${transaction?.payment_id ?? 'unknown'} status=${transactionStatus || 'missing'}`);
      continue;
    }

    const paymentId = transaction?.payment_id;
    if (!paymentId) {
      console.log(`[webhook] successful transaction without payment_id on invoice ${invoiceId}; skipping because it cannot be de-duplicated`);
      continue;
    }

    sawSuccessfulTransaction = true;

    const existingPayment = db.prepare(`
      SELECT 1
      FROM invoice_payment
      WHERE merchant_id = ? AND invoice_id = ? AND payment_id = ?
    `).get(merchantId, invoice.id, paymentId);

    if (existingPayment) {
      console.log(`[webhook] duplicate payment_id ${paymentId} for invoice ${invoice.id}; no-op`);
      continue;
    }

    const paymentCents = parseMoneyStringToCents(transaction?.amount?.value ?? '0');
    db.prepare(`
      INSERT INTO invoice_payment (merchant_id, invoice_id, payment_id, event_id, amount_cents, currency, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(merchantId, invoice.id, paymentId, event?.id ?? `${invoiceId}-${Date.now()}`, paymentCents, eventCurrency || targetCurrency, new Date(event?.create_time || Date.now()).toISOString());
  }

  if (!sawSuccessfulTransaction) {
    return { action: 'ignored', handled: false, reason: 'no successful payment transactions' };
  }

  // invoice_payment is the source of truth: the paid total is the sum of every recorded payment, never just this event.
  const updatedPaidCents = Number(
    db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM invoice_payment
      WHERE merchant_id = ? AND invoice_id = ?
    `).get(merchantId, invoice.id).total
  );
  const eventCreateTime = event?.create_time;
  const invoiceAmountCents = Number(invoice.amount_cents || 0);
  const isFullyPaid = updatedPaidCents >= invoiceAmountCents;

  db.prepare(`
    UPDATE invoice
    SET paid_cents = ?,
        paid_at = CASE WHEN ? THEN COALESCE(paid_at, ?) ELSE NULL END
    WHERE id = ? AND merchant_id = ?
  `).run(updatedPaidCents, isFullyPaid ? 1 : 0, eventCreateTime ?? null, invoice.id, merchantId);

  if (updatedPaidCents >= Number(invoice.amount_cents || 0) && eventCreateTime) {
    const paidOnDate = toChicagoDateString(eventCreateTime);
    const openPromises = db.prepare(`
      SELECT id, promised_date, status
      FROM promise
      WHERE merchant_id = ? AND invoice_id = ? AND status = 'open'
      ORDER BY datetime(created_at) DESC, id DESC
    `).all(merchantId, invoice.id);

    for (const promise of openPromises) {
      const promisedDate = String(promise.promised_date || '').slice(0, 10);
      const nextStatus = promisedDate && paidOnDate <= promisedDate ? 'kept' : 'broken';
      db.prepare(`
        UPDATE promise
        SET status = ?
        WHERE id = ? AND merchant_id = ?
      `).run(nextStatus, promise.id, merchantId);
    }
  }

  return { action: 'invoice payment processed', handled: true, invoiceId: invoice.id, paidCents: updatedPaidCents };
}

function updatePayoutAndLedgerFromEvent(event) {
  const resource = event?.resource ?? {};
  const batchId = resource?.batch_header?.payout_batch_id ?? resource?.batch_header?.batch_id ?? resource?.batch_id ?? null;
  const itemId = resource?.payout_item_id ?? resource?.item_id ?? resource?.id ?? null;
  const currentStatus = resource?.batch_header?.batch_status ?? resource?.transaction_status ?? resource?.status ?? resource?.state ?? 'pending';
  const mappedStatus = mapPayPalStatusToLocalStatus(currentStatus);
  const refs = [batchId, itemId, resource?.id].filter(Boolean);

  let action = 'ignored';

  if (batchId || itemId) {
    const payoutStmt = db.prepare(`
      UPDATE payout
      SET status = ?
      WHERE merchant_id = ?
        AND (batch_id = ? OR item_id = ?)
    `);

    payoutStmt.run(mappedStatus, DEFAULT_MERCHANT_ID, batchId ?? null, itemId ?? null);

    if (refs.length > 0) {
      const placeholders = refs.map(() => '?').join(', ');
      const ledgerStmt = db.prepare(`
        UPDATE ledger_entry
        SET status = ?
        WHERE merchant_id = ?
          AND paypal_ref IN (${placeholders})
      `);
      ledgerStmt.run(mappedStatus, DEFAULT_MERCHANT_ID, ...refs);
    }

    action = `updated payout/ledger to ${mappedStatus}`;
  }

  return action;
}

export async function handleWebhook(rawBody, headers) {
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { eventType: 'unknown', eventId: 'unknown', signatureStatus: 'INVALID_JSON', action: 'ignored' };
  }

  const eventId = event?.id ?? `webhook-${Date.now()}`;
  const eventType = event?.event_type ?? 'unknown';
  ensureDefaultMerchant();
  let signatureStatus = 'ERROR';
  let action = 'ignored';

  try {
    signatureStatus = await verifyWebhookSignature(headers, event);
  } catch (error) {
    signatureStatus = 'ERROR';
  }

  const payload = JSON.stringify(event);
  const storeResult = db.prepare(`
    INSERT OR IGNORE INTO webhook_event (id, event_id, event_type, payload, signature_status, merchant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`webhook-${eventId}`, eventId, eventType, payload, signatureStatus, DEFAULT_MERCHANT_ID);

  if (storeResult.changes === 0) {
    action = 'duplicate ignored';
  } else if (signatureStatus === 'SUCCESS') {
    const resource = event?.resource ?? {};
    const isPayoutEvent = String(eventType || '').toUpperCase().includes('PAYOUT');
    const isInvoicePaymentEvent = String(eventType || '').toUpperCase().includes('INVOICE') && !!resource?.invoice;

    if (isInvoicePaymentEvent) {
      const result = applyInvoicePaymentWebhookEvent(event, DEFAULT_MERCHANT_ID);
      action = result.action;
    } else if (isPayoutEvent && (resource?.batch_header || resource?.payout_item_id || resource?.item_id)) {
      action = updatePayoutAndLedgerFromEvent(event);
    } else {
      action = 'stored for review';
    }
  } else {
    action = 'stored for debugging';
  }

  console.log(`[webhook] type=${eventType} id=${eventId} signature=${signatureStatus} action=${action}`);
  return { eventType, eventId, signatureStatus, action };
}

app.disable('x-powered-by');
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  res.status(200).end('ok');

  void handleWebhook(rawBody, req.headers).catch((error) => {
    console.error('[webhook] processing error:', error.message);
  });
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/parties', (req, res) => {
  const type = String(req.query.type ?? '').trim().toLowerCase();
  const query = type
    ? 'SELECT id, merchant_id, type, name, paypal_email FROM party WHERE merchant_id = ? AND type = ? ORDER BY name ASC'
    : 'SELECT id, merchant_id, type, name, paypal_email FROM party WHERE merchant_id = ? ORDER BY name ASC';
  const params = type ? [DEFAULT_MERCHANT_ID, type] : [DEFAULT_MERCHANT_ID];
  const rows = db.prepare(query).all(...params);

  res.json({ ok: true, parties: rows });
});

app.get('/api/escalations', (req, res) => {
  const rows = db.prepare(`
    SELECT id, merchant_id, escalated, escalation_reason, severity, created_at
    FROM support_thread
    WHERE merchant_id = ? AND escalated = 1
    ORDER BY datetime(created_at) DESC
  `).all(DEFAULT_MERCHANT_ID);

  res.json({ ok: true, escalations: rows });
});

app.post('/api/invoices', async (req, res) => {
  const { customerId, amountCents, dueDate, description } = req.body ?? {};
  const validation = validateInvoiceCreateRequest({ customerId, amountCents, dueDate, description, merchantId: DEFAULT_MERCHANT_ID });

  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  const customer = validation.customer;
  const invoiceNumber = `INV-${Date.now()}`;
  const amountUsd = (Number(amountCents) / 100).toFixed(2);
  const invoiceDescription = validation.description || 'PanaPay invoice';
  const issuedAt = new Date().toISOString();

  try {
    const created = await createInvoice({
      invoiceNumber,
      customerEmail: customer.paypal_email,
      amountUsd,
      description: invoiceDescription,
      note: 'This invoice was created by PanaPay in the sandbox.',
      terms: 'Payment is due in 7 days.',
      paymentTerm: {
        term_type: 'DUE_ON_DATE_SPECIFIED',
        due_date: validation.dueDate,
      },
    });

    const invoiceId = extractInvoiceId(created);
    if (!invoiceId) {
      throw new Error('PayPal did not return an invoice id.');
    }

    await sendInvoice(invoiceId, { sendToInvoicer: true });

    const details = await getInvoice(invoiceId);
    const payerLink = details?.detail?.metadata?.recipient_view_url ?? null;

    const insertResult = db.prepare(`
      INSERT INTO invoice (merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 'live')
    `).run(DEFAULT_MERCHANT_ID, customer.id, invoiceId, Number(amountCents), 'USD', issuedAt, validation.dueDate);

    const invoiceRow = db.prepare(`
      SELECT id, merchant_id, customer_id, paypal_invoice_id, amount_cents, currency, issued_at, due_at, paid_cents, paid_at, source
      FROM invoice
      WHERE id = ? AND merchant_id = ?
    `).get(insertResult.lastInsertRowid, DEFAULT_MERCHANT_ID);

    return res.status(201).json({
      ok: true,
      invoice: invoiceRow,
      payer_link: payerLink,
    });
  } catch (error) {
    const apiError = error && typeof error === 'object' && 'paypalError' in error ? error.paypalError : null;
    const name = apiError && typeof apiError === 'object' && apiError.name ? apiError.name : (error && error.name ? error.name : 'PayPalApiError');
    const message = apiError && typeof apiError === 'object' && apiError.message ? apiError.message : (error && error.message ? error.message : 'PayPal invoice request failed.');
    return res.status(502).json({ ok: false, error: { name, message } });
  }
});

app.post('/api/assistant', async (req, res) => {
  const { threadId, message } = req.body ?? {};
  const text = String(message ?? '').trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Please enter a message.' });
  }

  const thread = findOrCreateThread(threadId);
  const threadMessages = db.prepare(`
    SELECT id, thread_id, role, content, created_at
    FROM support_message
    WHERE thread_id = ? AND merchant_id = ?
    ORDER BY datetime(created_at) ASC, id ASC
  `).all(thread.id, DEFAULT_MERCHANT_ID);

  const escalation = evaluateEscalation(text, [...threadMessages, { role: 'user', content: text }]);

  db.prepare(`
    INSERT INTO support_message (id, merchant_id, thread_id, role, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(`msg-${randomUUID()}`, DEFAULT_MERCHANT_ID, thread.id, 'user', text);

  if (escalation.escalate) {
    updateThreadEscalation(thread.id, escalation.reason, escalation.severity);
    const reply = 'I’m escalating this to a human support agent. A person will review the issue and follow up with the next steps.';
    db.prepare(`
      INSERT INTO support_message (id, merchant_id, thread_id, role, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(`msg-${randomUUID()}`, DEFAULT_MERCHANT_ID, thread.id, 'assistant', reply);

    return res.json({
      ok: true,
      threadId: thread.id,
      reply,
      escalated: true,
      escalation,
    });
  }

  const { reply, toolResults, usedToolCalls } = await buildAssistantReply({
    threadId: thread.id,
    message: text,
    threadMessages: db.prepare(`
      SELECT id, thread_id, role, content, created_at
      FROM support_message
      WHERE thread_id = ? AND merchant_id = ?
      ORDER BY datetime(created_at) ASC, id ASC
    `).all(thread.id, DEFAULT_MERCHANT_ID),
  });

  db.prepare(`
    INSERT INTO support_message (id, merchant_id, thread_id, role, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(`msg-${randomUUID()}`, DEFAULT_MERCHANT_ID, thread.id, 'assistant', reply);

  res.json({
    ok: true,
    threadId: thread.id,
    reply,
    escalated: false,
    toolResults,
    usedToolCalls,
  });
});

app.get('/api/forecast', (req, res) => {
  const merchantId = DEFAULT_MERCHANT_ID;
  const merchant = db.prepare('SELECT weekly_spend_limit FROM merchant WHERE id = ?').get(merchantId) ?? { weekly_spend_limit: 0 };
  const weeklyLimit = Number(merchant.weekly_spend_limit || 0);

  const today = new Date();
  const day = today.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() + diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  const historicalEntries = db.prepare(`
    SELECT id, merchant_id, party_id, direction, amount_cents, currency, status, paypal_ref, description, occurred_at
    FROM ledger_entry
    WHERE merchant_id = ?
      AND occurred_at IS NOT NULL
    ORDER BY datetime(occurred_at) DESC
    LIMIT 200
  `).all(merchantId);

  const scheduledPayouts = db.prepare(`
    SELECT id, merchant_id, party_id, amount_cents, created_at, status
    FROM payout
    WHERE merchant_id = ?
      AND status IN ('pending', 'failed', 'completed')
    ORDER BY datetime(created_at) DESC
  `).all(merchantId);

  const entries = [
    ...historicalEntries.map((entry) => ({
      ...entry,
      amount_cents: Number(entry.amount_cents || 0),
      direction: entry.direction || 'in',
      occurred_at: entry.occurred_at,
    })),
    ...scheduledPayouts.map((entry) => ({
      ...entry,
      amount_cents: Number(entry.amount_cents || 0),
      direction: 'out',
      occurred_at: entry.created_at,
    })),
  ];

  const buckets = weeklyBuckets(entries, startOfWeek, 4);
  const projection = projectBalance(0, buckets);
  const low = lowPoint(projection);
  const spentThisWeek = Number(db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS spent
    FROM ledger_entry
    WHERE merchant_id = ?
      AND direction = 'out'
      AND status = 'completed'
      AND occurred_at >= ?
  `).get(merchantId, startOfWeek.toISOString())?.spent || 0);

  const alarm = limitAlarm(spentThisWeek, weeklyLimit);

  res.json({
    startDate: startOfWeek.toISOString(),
    weeks: 4,
    buckets: projection,
    lowPoint: low,
    alarm,
    safeToSpend: Math.max(weeklyLimit - spentThisWeek, 0),
    spentThisWeek,
    weeklyLimit,
  });
});

app.get('/api/ledger', (req, res) => {
  const rows = db.prepare(`
    SELECT
      le.id,
      le.merchant_id,
      le.party_id,
      le.direction,
      le.amount_cents,
      le.currency,
      le.status,
      le.paypal_ref,
      le.category,
      le.category_confidence,
      le.category_reason,
      le.description,
      le.occurred_at,
      p.name,
      p.paypal_email
    FROM ledger_entry le
    LEFT JOIN party p ON p.id = le.party_id AND p.merchant_id = le.merchant_id
    WHERE le.merchant_id = ?
    ORDER BY datetime(le.occurred_at) DESC, le.id DESC
  `).all(DEFAULT_MERCHANT_ID);

  res.json(rows.map((row) => ({
    ...row,
    amount: row.amount_cents,
  })));
});

app.get('/api/summary', (req, res) => {
  const merchant = db.prepare('SELECT weekly_spend_limit FROM merchant WHERE id = ?').get(DEFAULT_MERCHANT_ID) ?? { weekly_spend_limit: 0 };
  const weeklyLimit = Number(merchant.weekly_spend_limit || 0);

  function getMondayStartInChicago(now = new Date()) {
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

    const parts = Object.fromEntries(
      formatter.formatToParts(now)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );

    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour || 0);
    const minute = Number(parts.minute || 0);
    const second = Number(parts.second || 0);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const dayOffset = (utcDate.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate() - dayOffset, 0, 0, 0));
    return monday.toISOString();
  }

  const startOfWeekIso = getMondayStartInChicago();
  const spentRow = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS spent_this_week
    FROM ledger_entry
    WHERE merchant_id = ?
      AND direction = 'out'
      AND status = 'completed'
      AND occurred_at >= ?
  `).get(DEFAULT_MERCHANT_ID, startOfWeekIso);

  const spentThisWeek = Number(spentRow?.spent_this_week || 0);
  const safeToSpend = Math.max(weeklyLimit - spentThisWeek, 0);
  const percentUsed = weeklyLimit > 0 ? (spentThisWeek / weeklyLimit) * 100 : 0;

  res.json({
    weekly_limit: weeklyLimit,
    spent_this_week: spentThisWeek,
    safe_to_spend: safeToSpend,
    percent_used: percentUsed,
  });
});

app.post('/api/payouts', async (req, res) => {
  const { partyId, amountCents, note } = req.body ?? {};
  const validation = validateSupplierPayoutRequest({ partyId, amountCents, note });

  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.message });
  }

  const party = validation.party;
  const payoutId = `payout-${randomUUID()}`;
  const ledgerId = `ledger-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const itemId = `item-${randomUUID()}`;
  const amountInDollars = (Number(amountCents) / 100).toFixed(2);

  try {
    const payoutResponse = await createPayout({
      batchId: payoutId,
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: party.paypal_email,
          amount: {
            value: amountInDollars,
            currency: 'USD',
          },
          note: note || 'PanaPay supplier payout',
          sender_item_id: itemId,
        },
      ],
    });

    const batchId = payoutResponse?.batch_header?.payout_batch_id ?? payoutId;
    const payPalItemId = payoutResponse?.items?.[0]?.payout_item_id ?? itemId;

    db.prepare(`
      INSERT INTO payout (id, merchant_id, party_id, amount_cents, batch_id, item_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(payoutId, DEFAULT_MERCHANT_ID, party.id, Number(amountCents), batchId, payPalItemId, 'pending', nowIso);

    db.prepare(`
      INSERT INTO ledger_entry (id, merchant_id, party_id, direction, amount_cents, currency, status, paypal_ref, category, category_confidence, category_reason, description, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ledgerId,
      DEFAULT_MERCHANT_ID,
      party.id,
      'out',
      Number(amountCents),
      'USD',
      'pending',
      batchId,
      null,
      null,
      null,
      note || 'Supplier payout',
      nowIso,
    );

    queueCategorization({
      id: ledgerId,
      merchant_id: DEFAULT_MERCHANT_ID,
      party_id: party.id,
      direction: 'out',
      amount_cents: Number(amountCents),
      currency: 'USD',
      status: 'pending',
      paypal_ref: batchId,
      description: note || 'Supplier payout',
      party_name: party.name,
    });

    return res.status(201).json({
      ok: true,
      payout: {
        id: payoutId,
        merchant_id: DEFAULT_MERCHANT_ID,
        party_id: party.id,
        amount_cents: Number(amountCents),
        batch_id: batchId,
        item_id: payPalItemId,
        status: 'pending',
        created_at: nowIso,
      },
      ledger_entry: {
        id: ledgerId,
        merchant_id: DEFAULT_MERCHANT_ID,
        party_id: party.id,
        direction: 'out',
        amount_cents: Number(amountCents),
        currency: 'USD',
        status: 'pending',
        paypal_ref: batchId,
        category: null,
        description: note || 'Supplier payout',
        occurred_at: nowIso,
      },
    });
  } catch (error) {
    console.error('[payout] submission failed:', error.message);
    return res.status(502).json({ ok: false, error: 'We could not submit the payout right now. Please try again.' });
  }
});

app.get('/api/payouts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM payout WHERE id = ? AND merchant_id = ?').get(req.params.id, DEFAULT_MERCHANT_ID);
  if (!row) {
    return res.status(404).json({ ok: false, error: 'Payout not found.' });
  }

  res.json({ ok: true, payout: row });
});
const STATUS_RANK = {
  broken_promise: 0,
  overdue: 1,
  due_today: 2,
  partially_paid: 3,
  promised: 4,
  issued: 5,
  paid_late: 6,
  paid: 7,
};

function buildInvoiceSummary(invoice, now) {
  const customer = db.prepare('SELECT name FROM customer WHERE id = ?').get(invoice.customer_id);
  const promises = db
    .prepare('SELECT * FROM promise WHERE invoice_id = ? AND merchant_id = ?')
    .all(invoice.id, DEFAULT_MERCHANT_ID);
  const derived = derive({ invoice, promises, now });

  return {
    invoiceId: invoice.id,
    paypalInvoiceId: invoice.paypal_invoice_id,
    customerId: invoice.customer_id,
    customerName: customer?.name ?? null,
    amountCents: invoice.amount_cents,
    currency: invoice.currency,
    dueAt: invoice.due_at,
    paidCents: invoice.paid_cents,
    paidAt: invoice.paid_at,
    daysLate: computeDaysLate(invoice, now),
    status: derived.status,
    reason: derived.reason,
    source: invoice.source,
  };
}

app.post('/api/promises/:id/confirm', (req, res) => {
  const id = Number(req.params.id);
  const promise = db
    .prepare('SELECT * FROM promise WHERE id = ? AND merchant_id = ?')
    .get(id, DEFAULT_MERCHANT_ID);
  if (!promise) return res.status(404).json({ ok: false, error: 'Promise not found.' });
  if (promise.status !== 'unconfirmed') {
    return res.status(409).json({ ok: false, error: 'Only unconfirmed promises can be confirmed.' });
  }
  db.prepare("UPDATE promise SET status = 'open' WHERE id = ? AND merchant_id = ?")
    .run(id, DEFAULT_MERCHANT_ID);
  const invoice = db
    .prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?')
    .get(promise.invoice_id, DEFAULT_MERCHANT_ID);
  res.json({
    ok: true,
    invoice: invoice ? buildInvoiceSummary(invoice, new Date().toISOString()) : null,
  });
});

app.post('/api/promises/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const promise = db
    .prepare('SELECT * FROM promise WHERE id = ? AND merchant_id = ?')
    .get(id, DEFAULT_MERCHANT_ID);
  if (!promise) return res.status(404).json({ ok: false, error: 'Promise not found.' });
  if (promise.status !== 'unconfirmed') {
    return res.status(409).json({ ok: false, error: 'Only unconfirmed promises can be rejected.' });
  }
  db.prepare("DELETE FROM promise WHERE id = ? AND merchant_id = ? AND status = 'unconfirmed'")
    .run(id, DEFAULT_MERCHANT_ID);
  res.json({ ok: true });
});

app.get('/api/receivables', (_req, res) => {
  const now = new Date().toISOString();
  const invoices = db
    .prepare('SELECT * FROM invoice WHERE merchant_id = ?')
    .all(DEFAULT_MERCHANT_ID);

  const summaries = invoices.map((invoice) => buildInvoiceSummary(invoice, now));

  summaries.sort(
    (a, b) => (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99),
  );

  res.json({ ok: true, invoices: summaries });
});

app.get('/api/customers', (_req, res) => {
  const customers = db
    .prepare('SELECT id, name, email, paypal_email FROM customer WHERE merchant_id = ?')
    .all(DEFAULT_MERCHANT_ID);

  res.json({
    ok: true,
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      canInvoice: Boolean(c.paypal_email && !String(c.paypal_email).endsWith('@example.com')),
    })),
  });
});

app.get('/api/customers/:id', (req, res) => {
  const customerId = Number(req.params.id);
  const customer = db
    .prepare('SELECT * FROM customer WHERE id = ? AND merchant_id = ?')
    .get(customerId, DEFAULT_MERCHANT_ID);

  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }

  const now = new Date().toISOString();
  const invoices = db
    .prepare('SELECT * FROM invoice WHERE customer_id = ? AND merchant_id = ?')
    .all(customerId, DEFAULT_MERCHANT_ID);

  const allPromises = db
    .prepare('SELECT * FROM promise WHERE customer_id = ? AND merchant_id = ?')
    .all(customerId, DEFAULT_MERCHANT_ID);

  const notes = db
    .prepare('SELECT * FROM customer_note WHERE customer_id = ? AND merchant_id = ? ORDER BY created_at')
    .all(customerId, DEFAULT_MERCHANT_ID);

  const invoicesWithStatus = invoices.map((invoice) => {
    const invPromises = allPromises.filter((p) => p.invoice_id === invoice.id);
    const derived = derive({ invoice, promises: invPromises, now });
    return {
      ...invoice,
      status: derived.status,
      reason: derived.reason,
      daysLate: computeDaysLate(invoice, now),
    };
  });

  const profile = buildProfile({
    invoices: invoices,
    promises: allPromises,
    payments: [],
    now,
  });

    const invoicesWithActions = invoicesWithStatus.map((inv) => ({
    ...inv,
    nextAction: computeNextAction({
      status: inv.status,
      daysLate: inv.daysLate,
      owedCents: inv.amount_cents - inv.paid_cents,
      promise: pickPromise(allPromises.filter((p) => p.invoice_id === inv.id)),
      label: profile.label,
    }),
  }));

  res.json({
    ok: true,
    customer,
    invoices: invoicesWithActions,
    notes,
    promises: allPromises,
    profile,
    nextAction: null,
  });
});
async function defaultExtractionModel({ system, user }) {
  const result = await callModel({ system, messages: [{ role: 'user', content: user }] });
  return result.text;
}

app.post('/api/customers/:id/notes', async (req, res) => {
  const customerId = Number(req.params.id);
  const customer = db
    .prepare('SELECT id FROM customer WHERE id = ? AND merchant_id = ?')
    .get(customerId, DEFAULT_MERCHANT_ID);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }

  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 1000) {
    return res.status(400).json({ ok: false, error: 'Note must be between 1 and 1000 characters.' });
  }

  let invoice;
  if (req.body?.invoiceId != null) {
    invoice = db
      .prepare('SELECT * FROM invoice WHERE id = ? AND customer_id = ? AND merchant_id = ?')
      .get(Number(req.body.invoiceId), customerId, DEFAULT_MERCHANT_ID);
    if (!invoice) {
      return res.status(400).json({ ok: false, error: 'Invoice not found for this customer.' });
    }
  } else {
    invoice = db
      .prepare(
        `SELECT * FROM invoice
         WHERE customer_id = ? AND merchant_id = ? AND paid_cents < amount_cents
         ORDER BY due_at ASC, id ASC LIMIT 1`,
      )
      .get(customerId, DEFAULT_MERCHANT_ID);
  }

  const nowDate = new Date();
  const nowIso = nowDate.toISOString();
  const noteResult = db
    .prepare('INSERT INTO customer_note (merchant_id, customer_id, invoice_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_MERCHANT_ID, customerId, invoice?.id ?? null, text, nowIso);
  const noteId = Number(noteResult.lastInsertRowid);

  let extractionState = 'no_open_invoice';
  let promise = null;

  if (invoice && invoice.paid_cents < invoice.amount_cents) {
    const model = app.locals.extractionModel ?? defaultExtractionModel;
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/Chicago' }).format(nowDate);
    const extraction = await extractPromise({
      text,
      todayKey: toChicagoDateKey(nowIso),
      weekday,
      model,
    });

    if (!extraction.ok) {
      extractionState = 'failed';
      console.error(`[notes] extraction failed: ${extraction.error}`);
    } else if (extraction.isPromise && extraction.promisedDate) {
      const unpaid = invoice.amount_cents - invoice.paid_cents;
      const promisedCents = extraction.amountCents > 0 ? Math.min(extraction.amountCents, unpaid) : unpaid;
      const status = extraction.confidence >= 0.7 ? 'open' : 'unconfirmed';
      const promiseResult = db
        .prepare(
          `INSERT INTO promise
           (merchant_id, customer_id, invoice_id, note_id, reason, promised_date, promised_cents, method, confidence, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          DEFAULT_MERCHANT_ID, customerId, invoice.id, noteId, extraction.reason,
          extraction.promisedDate, promisedCents, extraction.method, extraction.confidence, status, nowIso,
        );
      promise = db.prepare('SELECT * FROM promise WHERE id = ?').get(Number(promiseResult.lastInsertRowid));
      extractionState = status === 'open' ? 'promise' : 'needs_confirmation';
    } else {
      extractionState = 'no_promise';
    }
  }

  const note = db.prepare('SELECT * FROM customer_note WHERE id = ?').get(noteId);
  const freshInvoice = invoice ? db.prepare('SELECT * FROM invoice WHERE id = ?').get(invoice.id) : null;

  res.status(201).json({
    ok: true,
    note,
    promise,
    extraction: extractionState,
    invoice: freshInvoice ? buildInvoiceSummary(freshInvoice, nowIso) : null,
  });
});
app.post('/api/invoices/:id/draft', async (req, res) => {
  const invoice = db
    .prepare('SELECT * FROM invoice WHERE id = ? AND merchant_id = ?')
    .get(Number(req.params.id), DEFAULT_MERCHANT_ID);
  if (!invoice) {
    return res.status(404).json({ ok: false, error: 'Invoice not found.' });
  }

  const customer = db.prepare('SELECT * FROM customer WHERE id = ?').get(invoice.customer_id);
  const merchant = db.prepare('SELECT name FROM merchant WHERE id = ?').get(DEFAULT_MERCHANT_ID);
  const nowIso = new Date().toISOString();
  const allPromises = db
    .prepare('SELECT * FROM promise WHERE customer_id = ? AND merchant_id = ?')
    .all(invoice.customer_id, DEFAULT_MERCHANT_ID);
  const invoicePromises = allPromises.filter((p) => p.invoice_id === invoice.id);
  const customerInvoices = db
    .prepare('SELECT * FROM invoice WHERE customer_id = ? AND merchant_id = ?')
    .all(invoice.customer_id, DEFAULT_MERCHANT_ID);

  const derived = derive({ invoice, promises: invoicePromises, now: nowIso });
  const profile = buildProfile({ invoices: customerInvoices, promises: allPromises, payments: [], now: nowIso });
  const daysLate = computeDaysLate(invoice, nowIso);
  const owedCents = invoice.amount_cents - invoice.paid_cents;
  const promise = pickPromise(invoicePromises);
  const action = computeNextAction({ status: derived.status, daysLate, owedCents, promise, label: profile.label });

  if (!action.draftable) {
    return res.status(400).json({ ok: false, error: 'No message is needed for this invoice.' });
  }

  const facts = buildFacts({
    customerName: customer?.name,
    businessName: merchant?.name,
    owedCents,
    dueDate: String(invoice.due_at ?? '').slice(0, 10),
    daysLate,
    promisedDate: promise?.promised_date ?? null,
    action,
  });
  const result = await draftMessage({ facts, model: app.locals.draftModel ?? defaultExtractionModel });

  res.json({ ok: true, action, draft: result.text, source: result.source });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? 'Internal server error' : (error?.message || 'Request failed');

  res.status(status).json({ ok: false, error: message });
});

if (isDirectRun) {
  app.listen(port, () => {
    console.log(`PanaPay server running on http://localhost:${port}`);
  });
}

export default app;


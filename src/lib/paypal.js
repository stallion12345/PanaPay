import { randomUUID } from 'node:crypto';

const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

let tokenCache = { value: null, expiresAt: 0 };

function serializePayPalError(payload) {
  if (!payload || typeof payload !== 'object') {
    return typeof payload === 'string' ? payload : null;
  }

  const details = Array.isArray(payload.details)
    ? payload.details.map((detail) => ({
        field: detail?.field ?? null,
        issue: detail?.issue ?? null,
      }))
    : [];

  return {
    name: payload.name ?? 'PayPalApiError',
    message: payload.message ?? 'PayPal API request failed.',
    details,
  };
}

async function readPayPalResponse(response) {
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const debugId =
      typeof payload === 'object' && payload && 'debug_id' in payload
        ? payload.debug_id
        : response.headers.get('paypal-debug-id') ?? 'none';

    const paypalError = serializePayPalError(payload);
    const error = new Error(
      paypalError && typeof paypalError === 'object'
        ? JSON.stringify(paypalError, null, 2)
        : String(paypalError ?? `PayPal request failed with status ${response.status} and debug_id=${debugId}`)
    );

    error.name = paypalError && typeof paypalError === 'object' ? paypalError.name : 'PayPalApiError';
    error.debugId = debugId;
    error.status = response.status;
    error.paypalError = paypalError;

    throw error;
  }

  return payload;
}

export async function getToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in environment.');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const payload = await readPayPalResponse(response);
  const expiresIn = Number(payload.expires_in) || 3600;
  const expiryWindowMs = Math.max(expiresIn - 60, 0) * 1000;

  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + expiryWindowMs,
  };

  return payload.access_token;
}

export async function createPayout({ batchId, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Payout items are required.');
  }

  const token = await getToken();
  const requestId = batchId || randomUUID();
  const response = await fetch(`${PAYPAL_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: String(requestId),
        email_subject: 'PanaPay sandbox payout',
      },
      items,
    }),
  });

  return readPayPalResponse(response);
}

export async function getPayout(batchId) {
  if (!batchId) {
    throw new Error('Missing payout batchId.');
  }

  const token = await getToken();
  const response = await fetch(`${PAYPAL_BASE}/v1/payments/payouts/${encodeURIComponent(String(batchId))}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return readPayPalResponse(response);
}

export async function verifyWebhookSignature(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new Error('Missing PAYPAL_WEBHOOK_ID in environment.');
  }

  const token = await getToken();
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

  const payload = await readPayPalResponse(response);
  return payload.verification_status;
}

export function extractInvoiceId(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return null;
  }

  const directId = typeof responseBody.id === 'string' && responseBody.id.trim() ? responseBody.id.trim() : null;
  if (directId) {
    return directId;
  }

  const nestedId = typeof responseBody.invoice?.id === 'string' && responseBody.invoice.id.trim() ? responseBody.invoice.id.trim() : null;
  if (nestedId) {
    return nestedId;
  }

  const hrefCandidates = [
    responseBody.href,
    responseBody.self?.href,
    responseBody.links?.find((link) => typeof link?.href === 'string' && /\/invoices\//i.test(link.href))?.href,
    ...((Array.isArray(responseBody.links) ? responseBody.links : []).map((link) => link?.href).filter((href) => typeof href === 'string')),
  ];

  for (const href of hrefCandidates) {
    if (typeof href !== 'string' || !href.trim()) {
      continue;
    }

    const lastSegment = href.split('/').filter(Boolean).pop();
    if (lastSegment && /^(INV|INVOICE|[A-Za-z0-9-]+)$/i.test(lastSegment)) {
      return lastSegment;
    }
  }

  return null;
}

export async function createInvoice({
  invoiceNumber,
  customerEmail,
  amountUsd,
  description = 'PanaPay sandbox invoice',
  note = 'Thank you for your business.',
  terms = 'Payment is due in 15 days.',
  paymentTerm = null,
}) {
  if (!invoiceNumber) {
    throw new Error('Missing invoiceNumber.');
  }

  if (!customerEmail) {
    throw new Error('Missing CUSTOMER_EMAIL for the invoice recipient.');
  }

  const merchantEmail = process.env.PAYPAL_MERCHANT_EMAIL;
  if (!merchantEmail) {
    throw new Error('Missing PAYPAL_MERCHANT_EMAIL in environment.');
  }

  const token = await getToken();
  const amountValue = String(amountUsd ?? '0.00');
  const detail = {
    invoice_number: invoiceNumber,
    reference: `panapay-${Date.now()}`,
    currency_code: 'USD',
    note,
    terms,
    memo: 'PanaPay sandbox invoice',
  };

  if (paymentTerm && typeof paymentTerm === 'object') {
    detail.payment_term = paymentTerm;
  }

  const payload = {
    detail,
    invoicer: {
      name: {
        given_name: 'Ngozi',
        surname: 'Merchant',
      },
      email_address: merchantEmail,
    },
    primary_recipients: [
      {
        billing_info: {
          name: {
            given_name: 'Sandbox',
            surname: 'Customer',
          },
          email_address: customerEmail,
        },
      },
    ],
    items: [
      {
        name: description,
        quantity: '1',
        unit_amount: {
          currency_code: 'USD',
          value: amountValue,
        },
      },
    ],
    amount: {
      breakdown: {
        item_total: {
          currency_code: 'USD',
          value: amountValue,
        },
      },
      currency_code: 'USD',
      value: amountValue,
    },
  };

  const response = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return readPayPalResponse(response);
}

export async function sendInvoice(invoiceId, { sendToInvoicer = true } = {}) {
  if (!invoiceId) {
    throw new Error('Missing invoiceId.');
  }

  const token = await getToken();
  const response = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${encodeURIComponent(String(invoiceId))}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ send_to_invoicer: sendToInvoicer }),
  });

  return readPayPalResponse(response);
}

export async function getInvoice(invoiceId) {
  if (!invoiceId) {
    throw new Error('Missing invoiceId.');
  }

  const token = await getToken();
  const response = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${encodeURIComponent(String(invoiceId))}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return readPayPalResponse(response);
}

export async function remindInvoice(invoiceId, { subject, note, sendToInvoicer = true } = {}) {
  if (!invoiceId) {
    throw new Error('Missing invoiceId.');
  }

  const token = await getToken();
  const body = { send_to_invoicer: sendToInvoicer };
  if (subject) body.subject = String(subject).slice(0, 200);
  if (note) body.note = String(note).slice(0, 1000);

  const response = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${encodeURIComponent(String(invoiceId))}/remind`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 204) {
    return { ok: true };
  }
  return readPayPalResponse(response);
}

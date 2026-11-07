import { createInvoice, extractInvoiceId, getInvoice, sendInvoice } from '../src/lib/paypal.js';

function printFailure(status, debugId, extraMessage) {
  console.error(`Invoice smoke test stopped. status=${status}; debug_id=${debugId}`);
  if (extraMessage) {
    console.error(extraMessage);
  }
  process.exitCode = 1;
}

async function main() {
  const customerEmail = process.env.CUSTOMER_EMAIL?.trim();

  if (!customerEmail) {
    printFailure('missing-env', 'none', 'I need CUSTOMER_EMAIL set to the sandbox personal account email before creating an invoice.');
    return;
  }

  if (!process.env.PAYPAL_MERCHANT_EMAIL) {
    printFailure('missing-env', 'none', 'I need PAYPAL_MERCHANT_EMAIL set to the sandbox merchant account email before creating an invoice.');
    return;
  }

  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    printFailure('missing-env', 'none', 'I need PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment before I can create a live PayPal invoice.');
    return;
  }

  const invoiceNumber = `INV-${Date.now()}`;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const dueDateIso = dueDate.toISOString().slice(0, 10);

  try {
    const created = await createInvoice({
      invoiceNumber,
      customerEmail,
      amountUsd: '25.00',
      description: 'Sandbox invoice smoke test',
      note: 'This invoice was created by the PanaPay smoke test in the PayPal sandbox.',
      terms: 'Payment is due in 7 days.',
      paymentTerm: {
        term_type: 'DUE_ON_DATE_SPECIFIED',
        due_date: dueDateIso,
      },
    });

    console.log('Create invoice raw response:');
    console.log(JSON.stringify(created, null, 2));

    const invoiceId = extractInvoiceId(created);
    if (!invoiceId) {
      printFailure('unknown', 'none', `I could not find an invoice id in the create response. Raw response:\n${JSON.stringify(created, null, 2)}`);
      return;
    }

    try {
      await sendInvoice(invoiceId, { sendToInvoicer: true });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : 'unknown';
      const debugId = error && typeof error === 'object' && 'debugId' in error ? String(error.debugId) : 'none';
      const paypalError = error && typeof error === 'object' && 'paypalError' in error ? error.paypalError : null;
      printFailure(status, debugId, paypalError ? JSON.stringify(paypalError, null, 2) : String(error instanceof Error ? error.message : error));
      return;
    }

    const invoice = await getInvoice(invoiceId);
    const payerLink = Array.isArray(invoice?.links)
      ? invoice.links.find((link) => link?.rel === 'payer-action-url')?.href
        ?? invoice.links.find((link) => link?.rel === 'self')?.href
        ?? 'not available'
      : 'not available';

    console.log('payment_term from details call:');
    console.log(JSON.stringify(invoice?.detail?.payment_term ?? null, null, 2));

    console.log(JSON.stringify({
      invoice_id: invoice?.id ?? invoiceId,
      status: invoice?.status ?? 'unknown',
      payer_action_url: payerLink,
    }, null, 2));
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : 'unknown';
    const debugId = error && typeof error === 'object' && 'debugId' in error ? String(error.debugId) : 'none';
    const paypalError = error && typeof error === 'object' && 'paypalError' in error ? error.paypalError : null;
    printFailure(status, debugId, paypalError ? JSON.stringify(paypalError, null, 2) : String(error instanceof Error ? error.message : error));
  }
}

await main();

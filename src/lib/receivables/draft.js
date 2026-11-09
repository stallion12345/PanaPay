import { formatMoneyCents, formatDateKey } from './nextAction.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LENGTH = 700;
const BANNED = /\b(lawyer|legal action|sue|court|collections?|police|arrest|blacklist)\b/i;

export const DRAFT_SYSTEM_PROMPT = [
  'You write one short payment reminder from a small business owner to a customer.',
  'You receive a JSON object of facts. Use only those facts. Never invent amounts, dates, names or fees.',
  'Write 2 to 4 plain sentences, no greeting longer than "Hi <first name>,", no subject line, no emoji.',
  'The only dollar amount allowed is "amountOwed", written exactly as given.',
  'Tone "friendly": warm and brief. Tone "firm": polite but direct, state the missed date, ask for payment today or a reply with a date.',
  'Never threaten, never mention lawyers, courts, fees or collections, never include links.',
  'Tell them they can pay through the PayPal invoice they already received.',
  'Reply with the message text only.',
].join('\n');

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';

export function buildFacts({ customerName, businessName, owedCents, dueDate, daysLate, promisedDate, action }) {
  return {
    customerFirstName: firstName(customerName),
    business: businessName || 'us',
    amountOwed: formatMoneyCents(owedCents),
    dueDate: formatDateKey(dueDate) || null,
    daysLate: Number(daysLate) || 0,
    promisedDate: formatDateKey(promisedDate) || null,
    action: action.key,
    tone: action.tone,
  };
}

// Plain wording that needs no AI. Used when the model fails or breaks a rule.
export function templateDraft(facts) {
  const hi = `Hi ${facts.customerFirstName},`;
  const pay = 'You can pay through the PayPal invoice we sent you.';
  if (facts.action === 'ask_balance') {
    return `${hi} thank you for your payment. ${facts.amountOwed} of your invoice with ${facts.business} is still open. Could you send the remaining balance? ${pay}`;
  }
  if (facts.tone === 'firm' && facts.promisedDate) {
    return `${hi} you told us you would pay on ${facts.promisedDate}, and we have not received ${facts.amountOwed} yet. Please pay today, or reply to let us know when to expect it. ${pay} Thank you.`;
  }
  if (facts.tone === 'firm') {
    const late = facts.daysLate > 0 ? ` and is now ${facts.daysLate} day${facts.daysLate === 1 ? '' : 's'} overdue` : '';
    return `${hi} your invoice of ${facts.amountOwed} with ${facts.business} was due${facts.dueDate ? ` on ${facts.dueDate}` : ''}${late}. Please pay today, or reply to let us know when to expect it. ${pay} Thank you.`;
  }
  const when = facts.daysLate > 0 && facts.dueDate ? `was due on ${facts.dueDate}` : facts.dueDate ? `is due ${facts.dueDate}` : 'is due';
  return `${hi} a quick reminder that ${facts.amountOwed} for your invoice with ${facts.business} ${when}. ${pay} Thank you!`;
}

// Code checks what the AI wrote. Returns an error string, or null when the text is acceptable.
export function checkDraft(text, facts) {
  const body = String(text ?? '').trim();
  if (!body) return 'empty';
  if (body.length > MAX_LENGTH) return 'too_long';
  if (/https?:\/\/|www\./i.test(body)) return 'contains_link';
  if (BANNED.test(body)) return 'threatening_language';
  const amounts = body.match(/\$\s?[\d,]+(?:\.\d{1,2})?/g) ?? [];
  const allowed = facts.amountOwed.replace(/[^\d.]/g, '');
  for (const found of amounts) {
    const normal = found.replace(/[^\d.]/g, '');
    if (Number(normal) !== Number(allowed)) return 'wrong_amount';
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** model: async ({ system, user }) => string. Always returns a usable draft. */
export async function draftMessage({ facts, model, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    const raw = await withTimeout(Promise.resolve(model({ system: DRAFT_SYSTEM_PROMPT, user: JSON.stringify(facts) })), timeoutMs);
    const text = String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    const problem = checkDraft(text, facts);
    if (!problem) return { text, source: 'ai' };
    return { text: templateDraft(facts), source: 'template', reason: problem };
  } catch (error) {
    return { text: templateDraft(facts), source: 'template', reason: error?.message === 'timeout' ? 'timeout' : 'model_failed' };
  }
}

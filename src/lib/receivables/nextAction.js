// Deterministic "what should the owner do next" rules.
// Code decides the action. The AI never picks it; it only words the message later.

const OWNER_REVIEW_CENTS = 50000; // above $500 the owner handles it personally
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DRAFTABLE = new Set(['friendly_reminder', 'firm_reminder', 'ask_balance']);
const UNPAID = new Set(['issued', 'due_today', 'overdue', 'promised', 'broken_promise', 'partially_paid']);

export function formatMoneyCents(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
}

// 'YYYY-MM-DD' -> 'Nov 13' without any timezone shifting.
export function formatDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return '';
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
}

// The open promise with the latest promised date, or null.
export function pickPromise(promises = []) {
  const open = promises
    .filter((p) => p && p.status === 'open' && p.promised_date)
    .sort((a, b) => String(b.promised_date).localeCompare(String(a.promised_date)));
  return open[0] ?? null;
}

function result(key, title, reason, tone = 'friendly') {
  return { key, title, reason, tone, draftable: DRAFTABLE.has(key) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function computeNextAction({ status, daysLate = 0, owedCents = 0, promise = null, label = null }) {
  if (status === 'paid') return result('none', 'No action needed', 'Paid in full.');
  if (status === 'paid_late') return result('none', 'No action needed', 'Paid, but after the due date.');
  if (!UNPAID.has(status)) return result('none', 'No action needed', '');

  if (owedCents > OWNER_REVIEW_CENTS) {
    return result(
      'owner_review',
      'Handle this one yourself',
      `${formatMoneyCents(owedCents)} is above the ${formatMoneyCents(OWNER_REVIEW_CENTS)} limit for automatic reminders.`,
      'firm',
    );
  }

  if (status === 'broken_promise') {
    const when = promise ? formatDateKey(promise.promised_date) : '';
    return result(
      'firm_reminder',
      'Send a firm reminder',
      when ? `Promised to pay on ${when} and has not paid.` : 'Missed a promised payment date.',
      'firm',
    );
  }

  if (status === 'overdue') {
    const firm = daysLate >= 7;
    let reason = `${plural(daysLate, 'day')} past due.`;
    if (label === 'Usually on time') reason += ' Usually pays on time, so this may be an oversight.';
    if (label === 'Usually late') reason += ' Usually pays late.';
    return result(
      firm ? 'firm_reminder' : 'friendly_reminder',
      firm ? 'Send a firm reminder' : 'Send a friendly reminder',
      reason,
      firm ? 'firm' : 'friendly',
    );
  }

  if (status === 'due_today') {
    return result('friendly_reminder', 'Send a friendly reminder', 'Due today.');
  }

  if (status === 'partially_paid') {
    return result(
      'ask_balance',
      'Ask for the balance',
      `${formatMoneyCents(owedCents)} is still unpaid.`,
      daysLate >= 7 ? 'firm' : 'friendly',
    );
  }

  if (status === 'promised') {
    const when = promise ? formatDateKey(promise.promised_date) : '';
    return result('wait', when ? `Wait until ${when}` : 'Wait for the promised date', when ? `They promised to pay by ${when}.` : 'They made a promise to pay.');
  }

  return result('none', 'Nothing to do yet', 'Not due yet.');
}

const DISPUTE_TERMS = /(dispute|chargeback|refund|fraud|scam|stolen)/i;
const HUMAN_TERMS = /(human|person|agent|representative|live agent|someone|talk to a person|talk to someone)/i;
const NO_TERMS = /(no|not helpful|didn't help|did not help|still|again|repeat|repeated|same issue|still stuck)/i;

function getDollarAmounts(message) {
  const matches = String(message ?? '').match(/\$?\d+(?:,\d{3})*(?:\.\d{1,2})?/g) ?? [];
  return matches
    .map((value) => Number(value.replace(/[$,]/g, '')))
    .filter((value) => Number.isFinite(value));
}

export function evaluateEscalation(message, threadMessages = []) {
  const text = String(message ?? '').trim();
  if (!text) {
    return { escalate: false, reason: '', severity: 'low' };
  }

  const reasons = [];
  const amounts = getDollarAmounts(text);
  const over500 = amounts.some((amount) => amount > 500);
  const mentionsDispute = DISPUTE_TERMS.test(text);
  const asksForHuman = HUMAN_TERMS.test(text);

  if (mentionsDispute) {
    reasons.push('The message mentions a dispute, refund, fraud, scam, or stolen funds issue.');
  }

  if (over500) {
    reasons.push('An amount over $500 was mentioned in the message.');
  }

  if (asksForHuman) {
    reasons.push('The user asked to speak with a human or person.');
  }

  const priorMessages = Array.isArray(threadMessages) ? threadMessages : [];
  const userMessages = priorMessages.filter((row) => row && row.role === 'user').map((row) => String(row.content ?? ''));
  const lastUser = userMessages.at(-1) ?? '';
  const recentAssistantCount = priorMessages.filter((row) => row && row.role === 'assistant').length;

  if (recentAssistantCount >= 2 && NO_TERMS.test(lastUser)) {
    reasons.push('Two recent assistant replies did not resolve the issue and the user said no or repeated the problem.');
  }

  if (reasons.length === 0) {
    return { escalate: false, reason: '', severity: 'low' };
  }

  const severity = mentionsDispute || over500 ? 'high' : asksForHuman || /did not resolve/.test(reasons.join(' ')) ? 'medium' : 'low';

  return {
    escalate: true,
    reason: reasons.join(' '),
    severity,
  };
}

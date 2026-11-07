process.env.DB_PATH = ':memory:';
process.env.PANAPAY_DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEscalation } from './escalation-rules.js';

test('refund dispute triggers an escalation', () => {
  const result = evaluateEscalation('I need a refund because of a billing dispute.', []);
  assert.equal(result.escalate, true);
  assert.equal(result.severity, 'high');
});

test('chargeback language triggers an escalation', () => {
  const result = evaluateEscalation('I filed a chargeback and need help now.', []);
  assert.equal(result.escalate, true);
});

test('fraud language triggers an escalation', () => {
  const result = evaluateEscalation('This looks like fraud and my card was stolen.', []);
  assert.equal(result.escalate, true);
});

test('amount over $500 triggers escalation', () => {
  const result = evaluateEscalation('Please check the $750 payment that went missing.', []);
  assert.equal(result.escalate, true);
  assert.equal(result.severity, 'high');
});

test('asking for a human triggers escalation', () => {
  const result = evaluateEscalation('I want to talk to a person about this payout.', []);
  assert.equal(result.escalate, true);
});

test('repeated unresolved replies trigger escalation', () => {
  const threadMessages = [
    { role: 'assistant', content: 'I checked the ledger.' },
    { role: 'assistant', content: 'I still do not see the issue.' },
    { role: 'user', content: 'No, that did not help.' },
  ];
  const result = evaluateEscalation('Please keep looking.', threadMessages);
  assert.equal(result.escalate, true);
});

test('normal status questions do not escalate', () => {
  const result = evaluateEscalation('Can you tell me whether my latest payout is still pending?', []);
  assert.equal(result.escalate, false);
});

test('exactly $500 does not escalate', () => {
  const result = evaluateEscalation('We discussed a $500 payment and I am not sure it is correct.', []);
  assert.equal(result.escalate, false);
});

test('stolen funds language triggers escalation', () => {
  const result = evaluateEscalation('My account was stolen and the refund is stuck.', []);
  assert.equal(result.escalate, true);
});

test('ordinary forecast questions stay without escalation', () => {
  const result = evaluateEscalation('How much can I spend this week based on the forecast?', []);
  assert.equal(result.escalate, false);
});

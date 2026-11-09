import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, templateDraft, checkDraft, draftMessage } from './draft.js';

const action = { key: 'firm_reminder', tone: 'firm' };
const facts = buildFacts({
  customerName: 'Blessing Eze', businessName: "Ngozi's Fabrics", owedCents: 16000,
  dueDate: '2026-10-30', daysLate: 9, promisedDate: '2026-11-04', action,
});

test('facts hold only values the code computed', () => {
  assert.equal(facts.customerFirstName, 'Blessing');
  assert.equal(facts.amountOwed, '$160.00');
  assert.equal(facts.dueDate, 'Oct 30');
  assert.equal(facts.promisedDate, 'Nov 4');
  assert.equal(facts.tone, 'firm');
});

test('a good AI draft is used as written', async () => {
  const text = 'Hi Blessing, you said you would pay on Nov 4 and we have not received $160.00 yet. Please pay today through your PayPal invoice, or tell me when to expect it.';
  const r = await draftMessage({ facts, model: async () => text });
  assert.equal(r.source, 'ai');
  assert.equal(r.text, text);
});

test('an AI draft with a different amount is replaced by the template', async () => {
  const r = await draftMessage({ facts, model: async () => 'Hi Blessing, please pay $200.00 today.' });
  assert.equal(r.source, 'template');
  assert.equal(r.reason, 'wrong_amount');
  assert.match(r.text, /\$160\.00/);
});

test('amount formats are compared by value, so $160 and $160.00 both pass', () => {
  assert.equal(checkDraft('Please pay $160 today.', facts), null);
  assert.equal(checkDraft('Please pay $160.00 today.', facts), null);
  assert.equal(checkDraft('Please pay $1,600.00 today.', facts), 'wrong_amount');
});

test('links, threats, empty and overlong drafts are rejected', async () => {
  assert.equal(checkDraft('Pay at https://example.com now', facts), 'contains_link');
  assert.equal(checkDraft('Pay or we will take legal action', facts), 'threatening_language');
  assert.equal(checkDraft('Hand this to collections', facts), 'threatening_language');
  assert.equal(checkDraft('   ', facts), 'empty');
  assert.equal(checkDraft('x'.repeat(701), facts), 'too_long');
});

test('a model that throws or hangs falls back to the template', async () => {
  const a = await draftMessage({ facts, model: async () => { throw new Error('503'); } });
  assert.equal(a.source, 'template');
  assert.equal(a.reason, 'model_failed');
  const b = await draftMessage({ facts, timeoutMs: 20, model: () => new Promise(() => {}) });
  assert.equal(b.source, 'template');
  assert.equal(b.reason, 'timeout');
});

test('quotes the model puts around the message are stripped', async () => {
  const r = await draftMessage({ facts, model: async () => '"Hi Blessing, a reminder about $160.00. Please pay through your PayPal invoice."' });
  assert.equal(r.source, 'ai');
  assert.ok(!r.text.startsWith('"'));
});

test('the facts, not the customer note, are what the model receives', async () => {
  let seen;
  await draftMessage({ facts, model: async (args) => { seen = args; return 'Hi Blessing, $160.00 is open.'; } });
  assert.deepEqual(JSON.parse(seen.user), facts);
  assert.ok(!seen.system.includes('Blessing'));
});

test('every template contains the amount, and never a link or threat', () => {
  const variants = [
    buildFacts({ customerName: 'Ada Okonkwo', businessName: 'X', owedCents: 21000, dueDate: '2026-12-07', daysLate: 0, promisedDate: null, action: { key: 'friendly_reminder', tone: 'friendly' } }),
    buildFacts({ customerName: 'Ada Okonkwo', businessName: 'X', owedCents: 21000, dueDate: '2026-11-01', daysLate: 8, promisedDate: null, action }),
    buildFacts({ customerName: 'Ada Okonkwo', businessName: 'X', owedCents: 12000, dueDate: '2026-11-01', daysLate: 2, promisedDate: null, action: { key: 'ask_balance', tone: 'friendly' } }),
    facts,
  ];
  for (const f of variants) {
    const text = templateDraft(f);
    assert.ok(text.includes(f.amountOwed), text);
    assert.equal(checkDraft(text, f), null, text);
  }
});

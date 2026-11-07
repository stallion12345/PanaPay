import { z } from 'zod';

import { db } from '../db.js';
import { callModel } from './llm.js';

export const CATEGORY_OPTIONS = ['Sales', 'Supplies', 'Rent', 'Utilities', 'Delivery', 'Fees', 'Other'];

const categorySchema = z.object({
  category: z.enum(CATEGORY_OPTIONS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(200),
}).strict();

function normalizeText(value) {
  return String(value ?? '').trim();
}

function buildJsonSchema() {
  return {
    name: 'ledger_category_result',
    schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORY_OPTIONS,
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        reason: {
          type: 'string',
          maxLength: 200,
        },
      },
      required: ['category', 'confidence', 'reason'],
      additionalProperties: false,
    },
  };
}

export async function categorize(entry) {
  const safeEntry = entry ?? {};
  const entryId = safeEntry.id ?? null;

  const fallback = {
    category: 'Other',
    confidence: 0,
    reason: 'needs review',
  };

  if (!entryId) {
    return fallback;
  }

  const system = 'Classify this ledger item for a small merchant. Use only the allowed categories.';
  const messages = [{
    role: 'user',
    content: JSON.stringify({
      description: normalizeText(safeEntry.description),
      partyName: normalizeText(safeEntry.party_name ?? safeEntry.partyName),
      direction: normalizeText(safeEntry.direction),
      amount_cents: Number(safeEntry.amount_cents ?? safeEntry.amount ?? 0),
      status: normalizeText(safeEntry.status),
      category: normalizeText(safeEntry.category),
      paypal_ref: normalizeText(safeEntry.paypal_ref),
    }),
  }];

  try {
    const { text } = await callModel({
      system,
      messages,
      jsonSchema: buildJsonSchema(),
    });

    const trimmed = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(trimmed || '{}');
    const result = categorySchema.safeParse(parsed);

    if (!result.success) {
      throw new Error('invalid model response');
    }

    const final = {
      category: result.data.category,
      confidence: Number(result.data.confidence),
      reason: normalizeText(result.data.reason).slice(0, 200),
    };

    if (final.confidence < 0.7) {
      const review = { ...fallback, reason: 'needs review' };
      db.prepare(`
        UPDATE ledger_entry
        SET category = ?, category_confidence = ?, category_reason = ?
        WHERE id = ?
      `).run(review.category, review.confidence, review.reason, entryId);
      return review;
    }

    db.prepare(`
      UPDATE ledger_entry
      SET category = ?, category_confidence = ?, category_reason = ?
      WHERE id = ?
    `).run(final.category, final.confidence, final.reason, entryId);

    return final;
  } catch (error) {
    const review = { ...fallback, reason: 'needs review' };
    db.prepare(`
      UPDATE ledger_entry
      SET category = ?, category_confidence = ?, category_reason = ?
      WHERE id = ?
    `).run(review.category, review.confidence, review.reason, entryId);
    return review;
  }
}

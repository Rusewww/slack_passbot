/**
 * Issuer-specific document number formats.
 *
 * ICAO leaves the document number free-form: nine alphanumeric characters,
 * padded with `<`. Individual issuers are far more regular than that, and the
 * regularity is worth exploiting because it reaches exactly where the check
 * digits cannot.
 *
 * A mod-10 checksum is blind to any substitution that shifts a character's
 * value by a multiple of 10. That covers the digit/letter pairs `0↔A` up to
 * `9↔J`, which includes `6↔G`, one of the commonest OCR-B confusions. `6C000000` and
 * `GC000000` satisfy the same check digit, and no amount of arithmetic can
 * separate them. A rule saying "this issuer's passport numbers are two letters
 * followed by six digits" separates them immediately.
 *
 * The table is deliberately narrow. An unknown issuer gets no constraint at
 * all, so adding a rule can only ever help the issuers it names and can never
 * corrupt a document from anywhere else. Add an entry only with a real sample
 * to justify it.
 */

import type { MrzFormat } from './fields.js';
import { confusionVariants } from './repair.js';
import { verifyCheckDigit } from './checkDigit.js';

export interface DocumentNumberRule {
  /** Matched against the MRZ nationality field, which is check-digit covered. */
  issuingState: string;
  format: MrzFormat;
  /** Characters in the number itself, before `<` padding. */
  length: number;
  pattern: RegExp;
  /** Human-readable, used in warnings. */
  description: string;
}

export const DOCUMENT_NUMBER_RULES: readonly DocumentNumberRule[] = [
  {
    issuingState: 'UKR',
    format: 'TD3',
    length: 8,
    pattern: /^[A-Z]{2}\d{6}$/,
    description: 'two letters followed by six digits',
  },
  {
    issuingState: 'UKR',
    format: 'TD1',
    length: 9,
    pattern: /^\d{9}$/,
    description: 'nine digits',
  },
];

export function ruleFor(issuingState: string, format: MrzFormat): DocumentNumberRule | null {
  return (
    DOCUMENT_NUMBER_RULES.find(
      (rule) => rule.issuingState === issuingState && rule.format === format,
    ) ?? null
  );
}

/** Whether a document number, padding stripped, matches its issuer's shape. */
export function matchesRule(documentNumber: string, rule: DocumentNumberRule): boolean {
  return rule.pattern.test(documentNumber.replace(/<+$/, ''));
}

/**
 * Re-reads a document number so that it satisfies both its check digit and its
 * issuer's format.
 *
 * Only the first `rule.length` characters are considered; the remainder of the
 * field is padding and is regenerated rather than corrected. That matters,
 * because the padding is itself a common casualty. A trailing `<` misread as
 * `6` is not reachable by any glyph-confusion substitution, but knowing the
 * number is eight characters long fixes it trivially.
 *
 * Returns candidates nearest to the original first. An empty result means the
 * reading cannot be reconciled, which is itself worth reporting.
 */
export function repairToIssuerFormat(
  field: string,
  statedCheck: string,
  rule: DocumentNumberRule,
  maxEdits = 3,
): string[] {
  const prefix = field.slice(0, rule.length);
  const padding = '<'.repeat(Math.max(0, field.length - rule.length));
  const out: string[] = [];

  for (const candidate of confusionVariants(prefix, maxEdits)) {
    if (!rule.pattern.test(candidate)) continue;

    const padded = candidate + padding;
    if (verifyCheckDigit(padded, statedCheck)) out.push(padded);
  }

  return out;
}

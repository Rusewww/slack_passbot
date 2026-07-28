import { describe, expect, it } from 'vitest';

import { formatMrzDate, formatPassbotLine } from '../../src/mrz/format.js';
import {
  bestEffortLine2,
  bestEffortTd1Lines,
  countVerified,
  repairLine2,
} from '../../src/mrz/repair.js';
import { parseTd3 } from '../../src/mrz/td3.js';
import {
  SPECIMEN_LINE_1,
  SPECIMEN_LINE_2,
  TD1_MIDDLE,
  TD1_UPPER,
} from '../fixtures/specimen.js';

/** Replaces one character, simulating a specific OCR misread. */
function corrupt(line: string, index: number, replacement: string): string {
  return line.slice(0, index) + replacement + line.slice(index + 1);
}

/**
 * Damage the check digits cannot reconcile: the *stated* expiry check digit is
 * changed, so no substitution in the expiry field can satisfy it. The document
 * number and date of birth are untouched and must still prove out.
 */
const UNRECONCILABLE = corrupt(SPECIMEN_LINE_2, 27, '1');

describe('countVerified', () => {
  it('counts a fully valid reading as five', () => {
    expect(countVerified(parseTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2).validation)).toBe(5);
  });
});

describe('bestEffortLine2', () => {
  it('returns the clean reading untouched when everything verifies', () => {
    const attempt = bestEffortLine2(SPECIMEN_LINE_2);

    expect(attempt?.reading).toBe(SPECIMEN_LINE_2);
    expect(attempt?.edits).toBe(0);
    expect(attempt?.validation.allValid).toBe(true);
  });

  it('salvages the fields that still prove out when one field cannot', () => {
    // The strict path refuses this outright...
    expect(repairLine2(UNRECONCILABLE)).toBeNull();

    // ...while the best-effort path keeps what the arithmetic still confirms.
    const attempt = bestEffortLine2(UNRECONCILABLE);

    expect(attempt).not.toBeNull();
    expect(attempt?.validation.documentNumber).toBe(true);
    expect(attempt?.validation.birthDate).toBe(true);
    expect(attempt?.validation.expiryDate).toBe(false);
    expect(attempt?.validation.allValid).toBe(false);
  });

  it('still repairs the fields whose own check digit is intact', () => {
    // 0 -> O in the document number, plus the unreconcilable expiry digit.
    const damaged = corrupt(UNRECONCILABLE, 2, 'O');
    const attempt = bestEffortLine2(damaged);

    expect(attempt?.validation.documentNumber).toBe(true);
    expect(attempt?.reading.slice(0, 9)).toBe('XX000000<');
  });

  it('rejects a line of the wrong length', () => {
    expect(bestEffortLine2(SPECIMEN_LINE_2.slice(0, 40))).toBeNull();
  });
});

describe('bestEffortTd1Lines', () => {
  it('salvages the upper line when the middle line is damaged', () => {
    const damaged = corrupt(TD1_MIDDLE, 14, '1');
    const attempt = bestEffortTd1Lines(TD1_UPPER, damaged);

    expect(attempt?.validation.documentNumber).toBe(true);
    expect(attempt?.validation.birthDate).toBe(true);
    expect(attempt?.validation.expiryDate).toBe(false);
    expect(attempt?.validation.allValid).toBe(false);
  });
});

describe('formatPassbotLine on an unverified reading', () => {
  it('never throws on a date that is not a usable YYMMDD', () => {
    // A field whose check digit failed can hold anything the recogniser saw.
    // The strict formatter rejects it; the delivery formatter must not, or one
    // bad field would take down the whole reply.
    expect(() => formatMrzDate('9I0824')).toThrow();

    const damaged = corrupt(SPECIMEN_LINE_2, 14, 'I');
    const parsed = parseTd3(SPECIMEN_LINE_1, damaged);

    expect(() => formatPassbotLine(parsed.fields)).not.toThrow();
  });

  it('reports the raw characters for an unparseable date', () => {
    const damaged = corrupt(SPECIMEN_LINE_2, 14, 'I');
    const parsed = parseTd3(SPECIMEN_LINE_1, damaged);

    // Verbatim, so the reader can compare it against the document.
    expect(formatPassbotLine(parsed.fields)).toContain('9I0824');
  });

  it('still emits nine fields', () => {
    const damaged = corrupt(SPECIMEN_LINE_2, 14, 'I');
    const parsed = parseTd3(SPECIMEN_LINE_1, damaged);

    expect(formatPassbotLine(parsed.fields).split('/')).toHaveLength(9);
  });
});

import { describe, expect, it } from 'vitest';

import { formatPassbotLine } from '../../src/mrz/format.js';
import { confusionVariants, repairField, repairTd3 } from '../../src/mrz/repair.js';
import {
  SPECIMEN_EXPECTED_OUTPUT,
  SPECIMEN_LINE_1,
  SPECIMEN_LINE_2,
} from '../fixtures/specimen.js';

/** Replaces one character of line 2, simulating a specific OCR misread. */
function corrupt(line: string, index: number, replacement: string): string {
  return line.slice(0, index) + replacement + line.slice(index + 1);
}

describe('confusionVariants', () => {
  it('yields the original reading first', () => {
    const [first] = [...confusionVariants('910824', 1)];
    expect(first).toBe('910824');
  });

  it('honours a digits-only field constraint', () => {
    const variants = [...confusionVariants('I10824', 1, 'digits')];
    expect(variants).toContain('110824');
    expect(variants.every((v) => /^[0-9I]+$/.test(v))).toBe(true);
  });
});

describe('repairField', () => {
  it('recovers a digit misread as a letter', () => {
    // Date of birth 910824 read as 9I0824 (1 -> I).
    expect(repairField('9I0824', '2', { alphabet: 'digits' })).toContain('910824');
  });

  it('returns nothing when no confusion reconciles the check digit', () => {
    expect(repairField('910825', '2', { alphabet: 'digits' })).toHaveLength(0);
  });
});

describe('repairTd3', () => {
  it('is a no-op on a clean read', () => {
    const result = repairTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2);
    expect(result?.edits).toBe(0);
    expect(result?.parsed.validation.allValid).toBe(true);
  });

  it('recovers 0 read as O in the document number', () => {
    // XX000000< -> XXO00000<
    const damaged = corrupt(SPECIMEN_LINE_2, 2, 'O');
    const result = repairTd3(SPECIMEN_LINE_1, damaged);

    expect(result).not.toBeNull();
    expect(result?.edits).toBe(1);
    expect(formatPassbotLine(result!.parsed.fields)).toBe(SPECIMEN_EXPECTED_OUTPUT);
  });

  it('recovers 1 read as I in the date of birth', () => {
    // 910824 -> 9I0824, at line 2 offset 14
    const damaged = corrupt(SPECIMEN_LINE_2, 14, 'I');
    const result = repairTd3(SPECIMEN_LINE_1, damaged);

    expect(result?.parsed.fields.birthDate).toBe('910824');
    expect(result?.parsed.validation.allValid).toBe(true);
  });

  it('recovers two independent misreads in different fields', () => {
    // 0 -> O in the document number and 5 -> S in the expiry date.
    let damaged = corrupt(SPECIMEN_LINE_2, 3, 'O');
    damaged = corrupt(damaged, 26, 'S');

    const result = repairTd3(SPECIMEN_LINE_1, damaged);
    expect(result?.edits).toBe(2);
    expect(formatPassbotLine(result!.parsed.fields)).toBe(SPECIMEN_EXPECTED_OUTPUT);
  });

  it('refuses to invent a reading when the composite cannot be satisfied', () => {
    // Corrupt the composite check digit itself: no substitution in the data
    // fields can reconcile it, so the read must be rejected rather than
    // guessed at.
    const damaged = corrupt(SPECIMEN_LINE_2, 43, '5');
    expect(repairTd3(SPECIMEN_LINE_1, damaged)).toBeNull();
  });

  it('rejects lines of the wrong length outright', () => {
    expect(repairTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2.slice(0, 20))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { formatPassbotLine } from '../../src/mrz/format.js';
import { chooseNames } from '../../src/mrz/names.js';
import { repairTd1Lines } from '../../src/mrz/repair.js';
import {
  compositeInputTd1,
  looksLikeNameLine,
  parseTd1,
  Td1FormatError,
  validateTd1,
  TD1_LINE_LENGTH,
} from '../../src/mrz/td1.js';
import {
  TD1_EXPECTED_OUTPUT,
  TD1_MIDDLE,
  TD1_NAMES,
  TD1_UPPER,
  SPECIMEN_LINE_2,
} from '../fixtures/specimen.js';

/** Replaces one character, simulating a specific OCR misread. */
function corrupt(line: string, index: number, replacement: string): string {
  return line.slice(0, index) + replacement + line.slice(index + 1);
}

describe('TD1 fixture', () => {
  it('is three lines of 30', () => {
    for (const line of [TD1_UPPER, TD1_MIDDLE, TD1_NAMES]) {
      expect(line).toHaveLength(TD1_LINE_LENGTH);
    }
  });
});

describe('compositeInputTd1', () => {
  it('spans both the upper and middle lines', () => {
    // Upper positions 6-30 plus middle 1-7, 9-15 and 19-29, per ICAO 9303
    // Part 5, so 25 + 7 + 7 + 11 characters.
    expect(compositeInputTd1(TD1_UPPER, TD1_MIDDLE)).toHaveLength(50);
  });
});

describe('validateTd1', () => {
  it('accepts a well-formed card', () => {
    expect(validateTd1(TD1_UPPER, TD1_MIDDLE)).toMatchObject({
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      composite: true,
      allValid: true,
    });
  });

  it('catches a corrupted document number', () => {
    const damaged = corrupt(TD1_UPPER, 7, '9');
    const validation = validateTd1(damaged, TD1_MIDDLE);

    expect(validation.documentNumber).toBe(false);
    expect(validation.allValid).toBe(false);
  });

  it('catches a corrupted date of birth', () => {
    const damaged = corrupt(TD1_MIDDLE, 2, '9');
    expect(validateTd1(TD1_UPPER, damaged).allValid).toBe(false);
  });

  it('catches corruption in the optional data, via the composite alone', () => {
    // The optional data has no check digit of its own on TD1; only the
    // composite covers it.
    const damaged = corrupt(TD1_UPPER, 20, '7');
    const validation = validateTd1(damaged, TD1_MIDDLE);

    expect(validation.documentNumber).toBe(true);
    expect(validation.composite).toBe(false);
    expect(validation.allValid).toBe(false);
  });
});

describe('parseTd1', () => {
  const result = parseTd1(TD1_UPPER, TD1_MIDDLE, TD1_NAMES);

  it('extracts every field at its standard offset', () => {
    expect(result.fields).toMatchObject({
      documentCode: 'ID',
      issuingState: 'UKR',
      documentNumber: 'XX0000000',
      nationality: 'UKR',
      birthDate: '910824',
      sex: 'F',
      expiryDate: '230925',
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('produces the delivery string in the same shape as a passport', () => {
    expect(formatPassbotLine(result.fields)).toBe(TD1_EXPECTED_OUTPUT);
  });

  it('rejects lines of the wrong length', () => {
    expect(() => parseTd1(TD1_UPPER, TD1_MIDDLE, TD1_NAMES.slice(0, 29))).toThrow(Td1FormatError);
  });

  it('rejects a TD3 line, which is a different length entirely', () => {
    expect(() => parseTd1(SPECIMEN_LINE_2, TD1_MIDDLE, TD1_NAMES)).toThrow(Td1FormatError);
  });
});

describe('repairTd1Lines', () => {
  it('is a no-op on a clean read', () => {
    expect(repairTd1Lines(TD1_UPPER, TD1_MIDDLE)?.edits).toBe(0);
  });

  it('recovers 0 read as O in the document number', () => {
    const damaged = corrupt(TD1_UPPER, 8, 'O');
    const repaired = repairTd1Lines(damaged, TD1_MIDDLE);

    expect(repaired?.edits).toBe(1);
    expect(repaired?.upper).toBe(TD1_UPPER);
  });

  it('recovers a misread digit in the expiry date', () => {
    // 230925 -> 23092S, at middle-line offset 13
    const damaged = corrupt(TD1_MIDDLE, 13, 'S');
    expect(repairTd1Lines(TD1_UPPER, damaged)?.middle).toBe(TD1_MIDDLE);
  });

  it('refuses when the composite cannot be satisfied', () => {
    const damaged = corrupt(TD1_MIDDLE, 29, '1');
    expect(repairTd1Lines(TD1_UPPER, damaged)).toBeNull();
  });
});

describe('name line handling', () => {
  it('recognises the name line', () => {
    expect(looksLikeNameLine(TD1_NAMES)).toBe(true);
  });

  it('does not mistake the upper or middle line for it', () => {
    // The upper line starts with letters too, so this is a real risk.
    expect(looksLikeNameLine(TD1_UPPER)).toBe(false);
    expect(looksLikeNameLine(TD1_MIDDLE)).toBe(false);
  });

  it('recovers the name by consensus when the padding is misread', () => {
    // Same corruption class as TD3: the filler read as letters.
    const variants = [
      'TKACHENKO<<MARIANA<<<<<<<KKKKK',
      'TKACHENKO<K<MARIANA<<<<<KKEEKK',
      'TKACHENKO<<NARIANA<K<<KKKKKEKE',
    ];

    expect(chooseNames(variants.map((field) => ({ field, weight: 1 })))).toEqual({
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });
});

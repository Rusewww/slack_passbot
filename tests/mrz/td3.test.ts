import { describe, expect, it } from 'vitest';

import {
  extractTd3Lines,
  normaliseLine,
  parseTd3,
  Td3FormatError,
  TD3_LINE_LENGTH,
} from '../../src/mrz/td3.js';
import { SPECIMEN_LINE_1, SPECIMEN_LINE_2 } from '../fixtures/specimen.js';

describe('specimen fixture', () => {
  it('is well-formed TD3', () => {
    expect(SPECIMEN_LINE_1).toHaveLength(TD3_LINE_LENGTH);
    expect(SPECIMEN_LINE_2).toHaveLength(TD3_LINE_LENGTH);
  });
});

describe('parseTd3', () => {
  const result = parseTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2);

  it('extracts every field at its standard offset', () => {
    expect(result.fields).toEqual({
      documentCode: 'P',
      issuingState: 'UKR',
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
      documentNumber: 'XX000000',
      nationality: 'UKR',
      birthDate: '910824',
      sex: 'F',
      expiryDate: '230925',
      personalNumber: '1234567890',
    });
  });

  it('validates all five check digits', () => {
    expect(result.validation).toEqual({
      documentNumber: true,
      birthDate: true,
      expiryDate: true,
      personalNumber: true,
      composite: true,
      allValid: true,
    });
  });

  it('detects a single corrupted character via the check digits', () => {
    // 9108242 -> 9108243: the date of birth check digit no longer holds, and
    // because that digit also feeds the composite, both fail.
    const corrupted = SPECIMEN_LINE_2.slice(0, 19) + '3' + SPECIMEN_LINE_2.slice(20);
    const bad = parseTd3(SPECIMEN_LINE_1, corrupted);

    expect(bad.validation.birthDate).toBe(false);
    expect(bad.validation.composite).toBe(false);
    expect(bad.validation.allValid).toBe(false);
  });

  it('splits multiple given names on the single filler', () => {
    const line1 = ('P<UKRTKACHENKO<<MARIANA<ANNA' + '<'.repeat(16)).padEnd(44, '<');
    expect(parseTd3(line1, SPECIMEN_LINE_2).fields.secondaryIdentifier).toBe('MARIANA ANNA');
  });

  it('reports unspecified sex as X', () => {
    const line2 = SPECIMEN_LINE_2.slice(0, 20) + '<' + SPECIMEN_LINE_2.slice(21);
    expect(parseTd3(SPECIMEN_LINE_1, line2).fields.sex).toBe('X');
  });

  it('rejects lines of the wrong length', () => {
    expect(() => parseTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2.slice(0, 43))).toThrow(Td3FormatError);
  });

  it('rejects characters outside the MRZ alphabet', () => {
    const line2 = '!' + SPECIMEN_LINE_2.slice(1);
    expect(() => parseTd3(SPECIMEN_LINE_1, line2)).toThrow(Td3FormatError);
  });
});

describe('normaliseLine', () => {
  it('folds OCR renderings of the filler character', () => {
    expect(normaliseLine('p«ukr')).toBe('P<UKR');
    expect(normaliseLine('P UKR')).toBe('P<UKR');
  });
});

describe('extractTd3Lines', () => {
  it('picks the two MRZ lines out of noisy OCR output', () => {
    const noisy = ['UKRAINE', 'PASSPORT', SPECIMEN_LINE_1, SPECIMEN_LINE_2, ''].join('\n');
    expect(extractTd3Lines(noisy)).toEqual([SPECIMEN_LINE_1, SPECIMEN_LINE_2]);
  });

  it('returns null when fewer than two full-length lines are present', () => {
    expect(extractTd3Lines(`PASSPORT\n${SPECIMEN_LINE_1}`)).toBeNull();
  });
});

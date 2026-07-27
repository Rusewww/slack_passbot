import { describe, expect, it } from 'vitest';

import { charValue, computeCheckDigit, verifyCheckDigit } from '../../src/mrz/checkDigit.js';

describe('charValue', () => {
  it('maps the MRZ alphabet per ICAO 9303', () => {
    expect(charValue('<')).toBe(0);
    expect(charValue('0')).toBe(0);
    expect(charValue('9')).toBe(9);
    expect(charValue('A')).toBe(10);
    expect(charValue('Z')).toBe(35);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => charValue('a')).toThrow();
    expect(() => charValue(' ')).toThrow();
  });
});

describe('computeCheckDigit', () => {
  // Worked examples from the specimen passport, verified against ICAO 9303.
  it.each([
    ['XX000000<', 0], // document number
    ['910824', 2], // date of birth
    ['230925', 7], // date of expiry
    ['1234567890<<<<', 7], // personal number
  ])('computes the check digit for %s', (input, expected) => {
    expect(computeCheckDigit(input)).toBe(expected);
  });

  it('applies the repeating 7-3-1 weighting', () => {
    // 1*7 + 1*3 + 1*1 + 1*7 = 18 -> 8
    expect(computeCheckDigit('1111')).toBe(8);
  });
});

describe('verifyCheckDigit', () => {
  it('accepts a matching digit', () => {
    expect(verifyCheckDigit('910824', '2')).toBe(true);
  });

  it('rejects a mismatching digit', () => {
    expect(verifyCheckDigit('910824', '3')).toBe(false);
  });

  it('treats a filler check digit as "not provided"', () => {
    expect(verifyCheckDigit('<<<<<<<<<<<<<<', '<')).toBe(true);
  });

  it('rejects a non-numeric stated digit', () => {
    expect(verifyCheckDigit('910824', 'A')).toBe(false);
  });
});

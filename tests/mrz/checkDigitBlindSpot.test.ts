import { describe, expect, it } from 'vitest';

import {
  computeCheckDigit,
  isInvisibleToCheckDigit,
  verifyCheckDigit,
} from '../../src/mrz/checkDigit.js';
import { chooseNames } from '../../src/mrz/names.js';
import { repairLine2 } from '../../src/mrz/repair.js';

/**
 * A mod-10 checksum cannot detect a substitution that shifts a character's
 * value by a multiple of 10, because every weight (7, 3, 1) times 10 is itself
 * ≡ 0 mod 10. Character values are 0-9 for digits and 10-35 for A-Z, so the
 * pairs `0↔A` … `9↔J` are exactly ten apart — and `6↔G` is among the most
 * common OCR-B confusions there is.
 *
 * These tests pin the limitation down so nobody later mistakes "the check
 * digit verified" for "the field is correct" in this specific class.
 */
describe('the check-digit blind spot', () => {
  it('identifies substitutions of a multiple of ten', () => {
    expect(isInvisibleToCheckDigit('G', '6')).toBe(true);
    expect(isInvisibleToCheckDigit('A', '0')).toBe(true);
    expect(isInvisibleToCheckDigit('J', '9')).toBe(true);
  });

  it('does not flag confusions the check digit can catch', () => {
    // O = 24, 0 = 0: a difference of 24, so the checksum sees it.
    expect(isInvisibleToCheckDigit('O', '0')).toBe(false);
    // I = 18, 1 = 1: a difference of 17.
    expect(isInvisibleToCheckDigit('I', '1')).toBe(false);
    expect(isInvisibleToCheckDigit('G', 'G')).toBe(false);
  });

  it.each([
    ['0', 'A'],
    ['1', 'B'],
    ['2', 'C'],
    ['3', 'D'],
    ['4', 'E'],
    ['5', 'F'],
    ['6', 'G'],
    ['7', 'H'],
    ['8', 'I'],
    ['9', 'J'],
  ])('produces the same check digit for %s and %s at every position', (digit, letter) => {
    for (let position = 0; position < 9; position += 1) {
      const withDigit = 'X'.repeat(position) + digit + 'X'.repeat(8 - position);
      const withLetter = 'X'.repeat(position) + letter + 'X'.repeat(8 - position);
      expect(computeCheckDigit(withDigit)).toBe(computeCheckDigit(withLetter));
    }
  });

  it('accepts a document number misread 6 for G', () => {
    // Both satisfy the same stated check digit, so repair cannot choose
    // between them and consensus across variants is the only remedy.
    expect(verifyCheckDigit('GC000000<', '8')).toBe(true);
    expect(verifyCheckDigit('6C000000<', '8')).toBe(true);
  });

  it('leaves an invisible substitution untouched through a whole line', () => {
    // The consequence in full: a line whose document number is wrong passes
    // every check digit, including the composite, and repair reports it as a
    // clean read needing no corrections.
    const correct = 'GC000000<8UKR9108242F23092571234567890<<<<74';
    const wrong = correct.replace('GC000000', '6C000000');

    for (const line of [correct, wrong]) {
      const repaired = repairLine2(line);
      expect(repaired?.edits).toBe(0);
      expect(repaired?.line2).toBe(line);
    }
  });
});

describe('trailing filler artifacts in given names', () => {
  it('prefers the shorter reading when a stray K is attached', () => {
    // The padding after the name is misread and its first character sticks to
    // the name: MARIANA -> MARIANAK. Both readings appear across variants, and
    // plain majority would pick the wrong one here.
    const variants = [
      'TKACHENKO<<MARIANAK<<<<<<<<<<<<<<<<<<<<<',
      'TKACHENKO<<MARIANAK<<<<<<<<<KKKKKKKKKKKK',
      'TKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<<',
    ];

    expect(chooseNames(variants.map((field) => ({ field, weight: 1 })))).toEqual({
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('does not erode a surname that genuinely ends in K', () => {
    // Ukrainian surnames ending in K are common. The rule applies to given
    // names only, because a surname is followed by `<<` and more name, never
    // by padding — so a final K there is never this artifact.
    const variants = [
      'KOVALCHUK<<OLENA<<<<<<<<<<<<<<<<<<<<<<<<',
      'KOVALCHUK<<OLENA<<<<<<<<<<<<<<<<KKKKKKKK',
      'KOVALCHU<<OLENA<<<<<<<<<<<<<<<<<<<<<<<<<',
    ];

    expect(chooseNames(variants.map((field) => ({ field, weight: 1 })))).toMatchObject({
      primaryIdentifier: 'KOVALCHUK',
      secondaryIdentifier: 'OLENA',
    });
  });

  it('keeps a given name genuinely ending in K when nothing shorter is read', () => {
    const variants = [
      'IVANOV<<MARK<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      'IVANOV<<MARK<<<<<<<<<<<<<<<<<<<<KKKKKKKK',
    ];

    expect(chooseNames(variants.map((field) => ({ field, weight: 1 })))?.secondaryIdentifier).toBe(
      'MARK',
    );
  });

  it('ignores trailing letters that are common name endings', () => {
    // S is also a filler misread, but DENYS is a real name; crediting DENY
    // would corrupt it. The rule deliberately covers K, E and X only.
    const variants = [
      'IVANOV<<DENYS<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      'IVANOV<<DENYS<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      'IVANOV<<DENY<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    ];

    expect(chooseNames(variants.map((field) => ({ field, weight: 1 })))?.secondaryIdentifier).toBe(
      'DENYS',
    );
  });
});

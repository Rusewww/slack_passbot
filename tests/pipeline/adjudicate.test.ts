import { describe, expect, it } from 'vitest';

import { formatPassbotLine } from '../../src/mrz/format.js';
import type { SidecarCandidate } from '../../src/ocr/sidecar.js';
import { adjudicate } from '../../src/pipeline/extract.js';

/**
 * A synthetic passport whose document number contains a `G`, so the `6↔G`
 * confusion applies. Both readings satisfy every check digit including the
 * composite — see checkDigitBlindSpot.test.ts — which means the arithmetic
 * cannot choose between them and only agreement across variants can.
 */
const LINE_1 = 'P<UKRTKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<';
const LINE_2 = 'GC000000<8UKR9108242F23092571234567890<<<<74';
const LINE_2_MISREAD = LINE_2.replace('GC000000', '6C000000');

const EXPECTED = 'P/UKR/GC000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA';

function variant(name: string, ...lines: string[]): SidecarCandidate {
  return { variant: name, text: lines.join('\n'), lines };
}

describe('adjudicate — line 2 by consensus', () => {
  it('outvotes a misread that the check digits cannot detect', () => {
    // The misread variant comes first and validates perfectly. Taking the
    // first valid reading — the old behaviour — returned 6C000000.
    const candidates = [
      variant('located:otsu', LINE_1, LINE_2_MISREAD),
      variant('located:grey', LINE_1, LINE_2),
      variant('located:adaptive', LINE_1, LINE_2),
      variant('bottom:grey', LINE_1, LINE_2),
    ];

    const result = adjudicate(candidates);

    expect(result?.parsed.fields.documentNumber).toBe('GC000000');
    expect(formatPassbotLine(result!.parsed.fields)).toBe(EXPECTED);
  });

  it('reports full validity for the misread when nothing contradicts it', () => {
    // Honest about the limit: with a single variant there is no redundancy,
    // the arithmetic is blind, and the wrong reading is returned as verified.
    const result = adjudicate([variant('located:otsu', LINE_1, LINE_2_MISREAD)]);

    expect(result?.parsed.fields.documentNumber).toBe('6C000000');
    expect(result?.parsed.validation.allValid).toBe(true);
  });

  it('prefers the majority even when the minority appears more often first', () => {
    const candidates = [
      variant('a', LINE_1, LINE_2_MISREAD),
      variant('b', LINE_1, LINE_2_MISREAD),
      variant('c', LINE_1, LINE_2),
      variant('d', LINE_1, LINE_2),
      variant('e', LINE_1, LINE_2),
    ];

    expect(adjudicate(candidates)?.parsed.fields.documentNumber).toBe('GC000000');
  });
});

describe('adjudicate — trailing name artifact', () => {
  it('drops a stray K attached to the given name', () => {
    const candidates = [
      variant('located:otsu', 'P<UKRTKACHENKO<<MARIANAK<<<<<<<<<<<<<<<<<<<<', LINE_2),
      variant('located:grey', 'P<UKRTKACHENKO<<MARIANAK<<<<<<<<<KKKKKKKKKKK', LINE_2),
      variant('bottom:grey', LINE_1, LINE_2),
    ];

    const result = adjudicate(candidates);

    expect(result?.parsed.fields.secondaryIdentifier).toBe('MARIANA');
    expect(formatPassbotLine(result!.parsed.fields)).toBe(EXPECTED);
  });
});

describe('adjudicate — no usable reading', () => {
  it('returns null when the pool holds nothing MRZ-shaped', () => {
    expect(adjudicate([variant('bottom:grey', '14KOBOCT25<4652', 'L')])).toBeNull();
  });
});

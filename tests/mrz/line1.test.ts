import { describe, expect, it } from 'vitest';

import { formatPassbotLine } from '../../src/mrz/format.js';
import { buildLine1, chooseLine1Fields, extractLine1, scoreLine1 } from '../../src/mrz/line1.js';
import { parseTd3 } from '../../src/mrz/td3.js';
import {
  SPECIMEN_EXPECTED_OUTPUT,
  SPECIMEN_LINE_1,
  SPECIMEN_LINE_2,
} from '../fixtures/specimen.js';

/**
 * These variants reproduce the corruption pattern observed on a real
 * photograph, transplanted onto the specimen document. The real MRZ is not
 * committed: it belongs to an actual person, and docs/SECURITY.md forbids
 * putting document data in this repository.
 *
 * The pattern being reproduced, all caused by the stock `eng` Tesseract model
 * having no OCR-B chevron and reading `<` as a letter:
 *
 *   - `P<` read as `PK`, corrupting the document code
 *   - the `<<` name separator read as `<K<`
 *   - the trailing padding read as runs of K/E/S
 *   - candidates of varying length, because padding is over- or under-run
 *   - and the trap: the *worst* candidate is the one that happens to be
 *     exactly 44 characters
 */
const VARIANTS = {
  /** 44 chars: the only exact-length candidate, and the most corrupted. */
  trap: 'PKUKRTKACHENKO<<NARIANA<K<<KKKKKEKEKEEEEEKKE',
  /** 45 chars, name intact. */
  overrun: 'P<UKRTKACHENKO<<MARIANA<<<<<<<<<KKKKKKKKKKKKK',
  /** 42 chars, name intact. */
  underrun: 'P<UKRTKACHENKO<<MARIANA<<<<<<<K<<KRKREKEKE',
  /** Separator read as `<K<`. */
  splitSeparator: 'P<UKRTKACHENKO<K<MARIANA<<<<<<<KK<KKKKKKKKKKK',
  /** A character inserted in the prefix, shifting the issuing state. */
  shifted: 'PXKUKRTKACHENKO<<MARIANA<<<<<<<<<<S<KK<EKKKE',
} as const;

const NATIONALITY = 'UKR';

describe('extractLine1', () => {
  it('reads a clean line 1', () => {
    expect(extractLine1(SPECIMEN_LINE_1)).toEqual({
      documentCode: 'P',
      issuingState: 'UKR',
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('stops the name at the padding run, ignoring trailing noise', () => {
    expect(extractLine1(VARIANTS.overrun)).toMatchObject({
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('drops a single-character component left by a corrupted separator', () => {
    // `TKACHENKO<K<MARIANA`, where the K was a filler rather than an initial.
    expect(extractLine1(VARIANTS.splitSeparator)).toMatchObject({
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('keeps a single-character given name when it is the only one', () => {
    const line = ('P<UKRTKACHENKO<<A' + '<'.repeat(27)).slice(0, 44);
    expect(extractLine1(line)?.secondaryIdentifier).toBe('A');
  });

  it('preserves multiple given names', () => {
    const line = 'P<UKRTKACHENKO<<MARIANA<ANNA'.padEnd(44, '<');
    expect(extractLine1(line)?.secondaryIdentifier).toBe('MARIANA ANNA');
  });

  it('rejects lines with no name separator', () => {
    // Visual-zone text the recogniser picked up by accident.
    expect(extractLine1('14KOBOCT25<4652')).toBeNull();
    expect(extractLine1(SPECIMEN_LINE_2)).toBeNull();
  });
});

describe('scoreLine1', () => {
  it('rates a clean candidate above a corrupted one', () => {
    const clean = extractLine1(SPECIMEN_LINE_1);
    const trap = extractLine1(VARIANTS.trap);

    expect(scoreLine1(SPECIMEN_LINE_1, clean!, NATIONALITY)).toBeGreaterThan(
      scoreLine1(VARIANTS.trap, trap!, NATIONALITY),
    );
  });

  it('penalises a document code whose second character is not filler', () => {
    // `PK` instead of `P<` is the signature of a misread filler.
    const trap = extractLine1(VARIANTS.trap);
    const overrun = extractLine1(VARIANTS.overrun);

    expect(scoreLine1(VARIANTS.overrun, overrun!, NATIONALITY)).toBeGreaterThan(
      scoreLine1(VARIANTS.trap, trap!, NATIONALITY),
    );
  });
});

describe('chooseLine1Fields', () => {
  const pool = Object.values(VARIANTS);

  it('recovers every field by majority across corrupted variants', () => {
    expect(chooseLine1Fields(pool, NATIONALITY)).toEqual({
      documentCode: 'P',
      issuingState: 'UKR',
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('is not captured by the exactly-44-character candidate', () => {
    // The regression: length alone must not decide the winner. The trap
    // variant is the only 44-character line 1 in the pool.
    const chosen = chooseLine1Fields(pool, NATIONALITY);

    expect(chosen?.documentCode).not.toBe('PK');
    expect(chosen?.secondaryIdentifier).not.toContain('NARIANA');
  });

  it('returns null when nothing in the pool looks like a line 1', () => {
    expect(chooseLine1Fields(['4M<XAPKIBCKAO6J1UKR', 'L', ''], NATIONALITY)).toBeNull();
  });

  it('still works when only the corrupted variant is available', () => {
    // With no redundancy there is nothing to outvote it. Documented rather
    // than pretended away: one bad reading in, one bad reading out.
    const chosen = chooseLine1Fields([VARIANTS.trap], NATIONALITY);
    expect(chosen?.documentCode).toBe('PK');
  });
});

describe('buildLine1', () => {
  it('round-trips through the standard parser', () => {
    const fields = chooseLine1Fields(Object.values(VARIANTS), NATIONALITY);
    const line1 = buildLine1(fields!);

    expect(line1).toHaveLength(44);
    expect(parseTd3(line1, SPECIMEN_LINE_2).fields).toMatchObject({
      documentCode: 'P',
      issuingState: 'UKR',
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA',
    });
  });

  it('reconstructs the specimen line exactly', () => {
    expect(buildLine1(extractLine1(SPECIMEN_LINE_1)!)).toBe(SPECIMEN_LINE_1);
  });

  it('produces the correct delivery string end to end', () => {
    const fields = chooseLine1Fields(Object.values(VARIANTS), NATIONALITY);
    const parsed = parseTd3(buildLine1(fields!), SPECIMEN_LINE_2);

    expect(parsed.validation.allValid).toBe(true);
    expect(formatPassbotLine(parsed.fields)).toBe(SPECIMEN_EXPECTED_OUTPUT);
  });
});

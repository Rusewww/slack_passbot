import { describe, expect, it } from 'vitest';

import { matchesRule, repairToIssuerFormat, ruleFor } from '../../src/mrz/issuers.js';
import { extractNames } from '../../src/mrz/names.js';

const UKR_PASSPORT = ruleFor('UKR', 'TD3')!;

describe('issuer document number rules', () => {
  it('knows Ukrainian passports and identity cards', () => {
    expect(ruleFor('UKR', 'TD3')?.description).toContain('two letters');
    expect(ruleFor('UKR', 'TD1')?.description).toContain('nine digits');
  });

  it('has nothing to say about an issuer it does not know', () => {
    // The whole safety property: no rule, no constraint, no corruption.
    expect(ruleFor('DEU', 'TD3')).toBeNull();
    expect(ruleFor('XXX', 'TD1')).toBeNull();
  });

  it('accepts well-formed numbers', () => {
    expect(matchesRule('XX000000<', UKR_PASSPORT)).toBe(true);
    expect(matchesRule('GC000000<', UKR_PASSPORT)).toBe(true);
  });

  it('rejects numbers of the wrong shape', () => {
    expect(matchesRule('6C0000O06', UKR_PASSPORT)).toBe(false);
  });
});

describe('repairToIssuerFormat', () => {
  it('reaches the confusion the check digits are blind to', () => {
    // `6` and `G` differ by exactly 10, so no checksum can separate them.
    // The issuer format can, and does so uniquely.
    expect(repairToIssuerFormat('6C000000<', '8', UKR_PASSPORT)).toEqual(['GC000000<']);
  });

  it('repairs three simultaneous errors including lost padding', () => {
    // G->6, 0->O, and a trailing `<` read as `6`. The last is not reachable by
    // any glyph substitution. Knowing the number is eight characters long and
    // regenerating the padding fixes it.
    expect(repairToIssuerFormat('6C0000O06', '8', UKR_PASSPORT)).toEqual(['GC000000<']);
  });

  it('repairs a triple substitution the check digits cannot see', () => {
    // G->C, M->R and 8->B shift the weighted sum by -28, +15 and +3, which
    // cancel to -10, so `CRB00000<` carries the same check digit as
    // `GM800000<` and validates perfectly. The issuer format is the only thing
    // that can tell them apart, and the confusion table has to be able to walk
    // all three glyphs back for it to help. It resolves uniquely: every other
    // two-letter combination reachable from the misread fails the check digit.
    expect(repairToIssuerFormat('CRB00000<', '6', UKR_PASSPORT)).toEqual(['GM800000<']);
  });

  it('leaves a correct number alone', () => {
    expect(repairToIssuerFormat('XX000000<', '0', UKR_PASSPORT)).toEqual(['XX000000<']);
  });

  it('returns nothing when no reading fits both the format and the check digit', () => {
    // Reported as an anomaly rather than forced to fit; inventing a value that
    // matches the pattern would be fabricating data.
    expect(repairToIssuerFormat('ZZZZZZZZZ', '1', UKR_PASSPORT)).toEqual([]);
  });
});

describe('name plausibility guard', () => {
  it('rejects a name field containing digits', () => {
    // The reading that was delivered as `EVA ERI LEILAKKK6660CKREKKKKRKCK`.
    expect(extractNames('IVAN<OVA<<ERI<LEILAKKK6660CKREKKKKRKCK')).toBeNull();
  });

  it('rejects one letter repeated, which is misread padding', () => {
    // The reading that was delivered as a surname of sixteen K's.
    expect(extractNames('KKKKKKKKKKKKKKKK<<KKKK')).toBeNull();
  });

  it('rejects a component too long to be a name', () => {
    expect(extractNames(`${'A'.repeat(30)}<<MARIANA`)).toBeNull();
  });

  it('rejects an implausible number of given names', () => {
    expect(extractNames('TKACHENKO<<ANNA<BETH<CARA<DORA<ELLA')).toBeNull();
  });

  it('still accepts ordinary names', () => {
    expect(extractNames('IVANOVA<<OLENAA<<<<<<<<<<<<<<<')).toEqual({
      primaryIdentifier: 'IVANOVA',
      secondaryIdentifier: 'OLENAA',
    });
    expect(extractNames('TKACHENKO<<MARIANA<ANNA<<<<<<<')).toEqual({
      primaryIdentifier: 'TKACHENKO',
      secondaryIdentifier: 'MARIANA ANNA',
    });
  });

  it('tolerates a short repeated run, which can be genuine', () => {
    expect(extractNames('AAB<<ANNA<<<<<<<<<<<<<')).not.toBeNull();
  });
});

/**
 * Check digit computation, per ICAO 9303 Part 3, §4.9.
 *
 * Each character maps to a numeric value, gets multiplied by a repeating
 * 7-3-1 weight, and the sum is reduced modulo 10. This is what makes MRZ OCR
 * verifiable rather than merely plausible: we can prove a reading is correct
 * instead of trusting the recogniser.
 *
 * ## The blind spot
 *
 * A mod-10 checksum cannot see a substitution that changes a character's value
 * by a multiple of 10, because every weight (7, 3, 1) times 10 is itself ≡ 0
 * mod 10. Such a substitution is invisible at every position, not just some.
 *
 * Character values run 0-9 for the digits and 10-35 for `A`-`Z`, which leaves
 * the digit/letter pairs `0↔A`, `1↔B` up to `9↔J` exactly ten apart. `6↔G` is
 * in there, and it happens to be one of the most common OCR-B confusions
 * around. A document number misread as `6C000000` instead of `GC000000`
 * satisfies its check digit perfectly, composite included.
 *
 * Nor is the blind spot limited to single characters. Several substitutions
 * whose weighted shifts happen to cancel modulo 10 are just as invisible, and
 * they need not be ±10 pairs individually: `G→C`, `M→R` and `8→B` in the first
 * three positions shift the sum by -28, +15 and +3, which is -10. That exact
 * triple has been seen on a real document, and it passed the composite too.
 *
 * Arithmetic cannot recover these. The defences are redundancy, meaning
 * agreement across independent readings of the same strip, and structure,
 * meaning an issuer's known document-number format. See
 * `isInvisibleToCheckDigit` below, the consensus vote in `pipeline/extract.ts`
 * and the rules in `issuers.ts`.
 */

const WEIGHTS = [7, 3, 1] as const;

/** Filler `<` is 0, digits are themselves, `A`..`Z` are 10..35. */
export function charValue(ch: string): number {
  if (ch === '<') return 0;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // '0'-'9'
  if (code >= 65 && code <= 90) return code - 55; // 'A'-'Z'
  throw new Error(`Character out of MRZ alphabet: ${JSON.stringify(ch)}`);
}

/** Returns the check digit (0-9) for an MRZ substring. */
export function computeCheckDigit(input: string): number {
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += charValue(input[i] as string) * (WEIGHTS[i % 3] as number);
  }
  return sum % 10;
}

/**
 * Verifies a field against its stated check digit.
 *
 * A `<` check digit means "not provided", which is legal for optional fields
 * like the personal number. There is nothing to verify in that case.
 */
export function verifyCheckDigit(input: string, stated: string): boolean {
  if (stated === '<') return true;
  if (stated.length !== 1 || stated < '0' || stated > '9') return false;
  try {
    return computeCheckDigit(input) === Number(stated);
  } catch {
    return false;
  }
}

/** True if every character is inside the MRZ alphabet `A-Z0-9<`. */
export function isMrzAlphabet(input: string): boolean {
  return /^[A-Z0-9<]*$/.test(input);
}

/**
 * Substitutions a check digit can never detect: the two characters differ by a
 * multiple of 10, so they contribute identically modulo 10.
 *
 * Kept as an explicit list because it is easy to assume a verified field is
 * therefore correct. For these pairs it is not, and the only thing standing
 * between them and a wrong answer is cross-variant agreement.
 */
export function isInvisibleToCheckDigit(a: string, b: string): boolean {
  try {
    return a !== b && (charValue(a) - charValue(b)) % 10 === 0;
  } catch {
    return false;
  }
}

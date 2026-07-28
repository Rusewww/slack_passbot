/**
 * ICAO 9303 Part 3, §4.9 — check digit computation.
 *
 * Each character is mapped to a numeric value, multiplied by a repeating
 * 7-3-1 weight, summed, and reduced modulo 10. This is what makes MRZ OCR
 * verifiable rather than merely plausible: we can prove a read is correct
 * instead of trusting the recognizer.
 *
 * ## The blind spot
 *
 * A mod-10 checksum cannot see a substitution that changes a character's value
 * by a multiple of 10, because every weight (7, 3, 1) times 10 is itself ≡ 0
 * mod 10. The substitution is invisible at *every* position, not merely some.
 *
 * Character values run 0-9 for the digits and 10-35 for `A`-`Z`, which puts
 * exactly the digit/letter pairs `0↔A`, `1↔B` … `9↔J` ten apart — and `6↔G`
 * happens to be one of the most common OCR-B confusions there is. A document
 * number misread `6C000000` for `GC000000` satisfies its check digit
 * perfectly, composite included.
 *
 * No amount of arithmetic recovers these. The only defence is redundancy:
 * agreement across independent readings of the same strip. See
 * `CONFUSIONS_INVISIBLE_TO_CHECK_DIGITS` below and the consensus vote in
 * `pipeline/extract.ts`.
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
 * A `<` check digit means "not provided" — legal for optional fields such as
 * the personal number, in which case there is nothing to verify.
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

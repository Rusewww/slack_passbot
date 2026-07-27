/**
 * ICAO 9303 Part 3, §4.9 — check digit computation.
 *
 * Each character is mapped to a numeric value, multiplied by a repeating
 * 7-3-1 weight, summed, and reduced modulo 10. This is what makes MRZ OCR
 * verifiable rather than merely plausible: we can prove a read is correct
 * instead of trusting the recognizer.
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

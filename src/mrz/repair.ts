/**
 * Check-digit-driven correction of OCR confusions.
 *
 * OCR-B is a machine-readable font, but photographs still produce a small,
 * predictable set of glyph confusions (0/O, 1/I, 5/S, 8/B, 2/Z ...). Because
 * every significant TD3 field carries a check digit, we do not have to guess
 * which reading is right. We can enumerate the plausible substitutions and
 * keep only the ones that satisfy the arithmetic. A candidate that passes all
 * five check digits is correct for practical purposes; the odds of a wrong
 * reading passing the composite as well are ~1 in 10^5.
 */

import { computeCheckDigit, verifyCheckDigit } from './checkDigit.js';
import type { MrzValidation } from './fields.js';
import { TD1_LINE_LENGTH, validateTd1 } from './td1.js';
import {
  TD3_LINE_LENGTH,
  compositeInput,
  parseTd3,
  validateLine2,
  type Td3ParseResult,
} from './td3.js';

/** Symmetric confusion pairs observed in OCR-B passport scans. */
const CONFUSION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['0', 'O'],
  ['0', 'D'],
  ['0', 'Q'],
  ['1', 'I'],
  ['1', 'L'],
  ['1', 'T'],
  ['2', 'Z'],
  ['4', 'A'],
  ['5', 'S'],
  ['6', 'G'],
  ['7', 'T'],
  ['8', 'B'],
  ['9', 'G'],
  ['B', 'R'],
  ['C', 'G'],
  ['D', 'O'],
  ['E', 'F'],
  ['M', 'N'],
  // Observed on a real Ukrainian passport photographed at low resolution: the
  // document number came back with `G`, `M` and `8` read as `C`, `R` and `B`.
  // The other two pairs were already here; this one was not, so the issuer
  // format flagged the number but the repair could not reach the right one.
  //
  // That reading is worth remembering for another reason. Its three
  // substitutions shift the weighted sum by -28, +15 and +3, which cancel to
  // -10, so every check digit including the composite accepted the wrong
  // number. Only the issuer format caught it.
  ['M', 'R'],
  ['U', 'V'],
  ['K', '<'],
  ['C', '<'],
];

const CONFUSIONS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [a, b] of CONFUSION_PAIRS) {
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    (map.get(a) as string[]).push(b);
    (map.get(b) as string[]).push(a);
  }
  return map;
})();

export type FieldAlphabet = 'any' | 'digits' | 'alpha';

function allowedByAlphabet(ch: string, alphabet: FieldAlphabet): boolean {
  if (alphabet === 'digits') return ch >= '0' && ch <= '9';
  if (alphabet === 'alpha') return (ch >= 'A' && ch <= 'Z') || ch === '<';
  return true;
}

/** Hard ceiling on enumeration so a garbage read can never burn CPU. */
const MAX_CANDIDATES = 4096;

/**
 * Enumerates variants of `value` reachable by at most `maxEdits` confusion
 * substitutions, nearest-first (0 edits, then 1, then 2).
 */
export function* confusionVariants(
  value: string,
  maxEdits: number,
  alphabet: FieldAlphabet = 'any',
): Generator<string> {
  const positions: Array<{ index: number; options: string[] }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    const options = (CONFUSIONS.get(ch) ?? []).filter((c) => allowedByAlphabet(c, alphabet));
    if (options.length > 0) positions.push({ index: i, options });
  }

  yield value;

  let emitted = 1;
  for (let edits = 1; edits <= maxEdits; edits += 1) {
    for (const combo of combinations(positions.length, edits)) {
      for (const choice of cartesian(combo.map((p) => (positions[p] as (typeof positions)[0]).options))) {
        const chars = value.split('');
        combo.forEach((p, k) => {
          chars[(positions[p] as (typeof positions)[0]).index] = choice[k] as string;
        });
        yield chars.join('');
        emitted += 1;
        if (emitted >= MAX_CANDIDATES) return;
      }
    }
  }
}

function* combinations(n: number, k: number): Generator<number[]> {
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && (idx[i] as number) === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] = (idx[i] as number) + 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = (idx[j - 1] as number) + 1;
  }
}

function* cartesian(lists: string[][]): Generator<string[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head, ...rest] = lists as [string[], ...string[][]];
  for (const value of head) {
    for (const tail of cartesian(rest)) {
      yield [value, ...tail];
    }
  }
}

/** Per-field cap on surviving readings, and on the cross-field search. */
const MAX_FIELD_CANDIDATES = 48;
const MAX_COMBINATIONS = 20_000;

/**
 * Returns readings of a field that satisfy its stated check digit, nearest to
 * the original first. Empty when the field cannot be reconciled.
 *
 * The result is capped: a field with dozens of valid readings is by definition
 * too ambiguous to resolve, and enumerating them all only costs CPU.
 */
export function repairField(
  value: string,
  statedCheck: string,
  options: { maxEdits?: number; alphabet?: FieldAlphabet; limit?: number } = {},
): string[] {
  const { maxEdits = 2, alphabet = 'any', limit = MAX_FIELD_CANDIDATES } = options;
  const out: string[] = [];
  for (const candidate of confusionVariants(value, maxEdits, alphabet)) {
    if (verifyCheckDigit(candidate, statedCheck)) {
      out.push(candidate);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface RepairResult {
  parsed: Td3ParseResult;
  /** Number of character substitutions applied relative to the OCR output. */
  edits: number;
}

export interface Line2Repair {
  line2: string;
  /** Number of character substitutions applied relative to the OCR output. */
  edits: number;
}

function editDistance(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

/**
 * Attempts to turn an imperfect line 2 into one that satisfies every check
 * digit. Fields are repaired independently against their own check digits, and
 * the composite digit then arbitrates between surviving combinations.
 *
 * Line 2 is repaired on its own because it is the only line the check digits
 * cover. Line 1 is neither validated nor corrected here.
 *
 * Returns the fully-valid candidate with the fewest edits, or null.
 */
export function repairLine2(line2: string, maxEdits = 2): Line2Repair | null {
  if (line2.length !== TD3_LINE_LENGTH) return null;

  const docNumbers = repairField(line2.slice(0, 9), line2.slice(9, 10), { maxEdits });
  const birthDates = repairField(line2.slice(13, 19), line2.slice(19, 20), {
    maxEdits,
    alphabet: 'digits',
  });
  const expiryDates = repairField(line2.slice(21, 27), line2.slice(27, 28), {
    maxEdits,
    alphabet: 'digits',
  });

  if (docNumbers.length === 0 || birthDates.length === 0 || expiryDates.length === 0) return null;

  let best: Line2Repair | null = null;
  let tried = 0;

  for (const documentNumber of docNumbers) {
    for (const birthDate of birthDates) {
      for (const expiryDate of expiryDates) {
        // Hard budget: an unreadable image must cost bounded CPU, not a
        // combinatorial explosion across three ambiguous fields.
        if ((tried += 1) > MAX_COMBINATIONS) return best;

        const candidate =
          documentNumber +
          line2.slice(9, 13) +
          birthDate +
          line2.slice(19, 21) +
          expiryDate +
          line2.slice(27, TD3_LINE_LENGTH);

        if (computeCheckDigit(compositeInput(candidate)) !== Number(line2.slice(43, 44))) continue;
        if (!validateLine2(candidate).allValid) continue;

        const edits = editDistance(line2, candidate);
        if (best === null || edits < best.edits) best = { line2: candidate, edits };
        if (edits === 0) return best;
      }
    }
  }

  return best;
}

export interface Td1Repair {
  upper: string;
  middle: string;
  edits: number;
}

export interface BestEffort<T> {
  reading: T;
  edits: number;
  /** Exactly which check digits hold for this reading. */
  validation: MrzValidation;
}

/** How many of the format's check digits a reading satisfies. */
export function countVerified(validation: MrzValidation): number {
  return [
    validation.documentNumber,
    validation.birthDate,
    validation.expiryDate,
    validation.personalNumber,
    validation.composite,
  ].filter(Boolean).length;
}

/**
 * Salvages what can be proven from a line 2 that will not fully validate.
 *
 * `repairLine2` is all-or-nothing: it returns a reading only when every check
 * digit holds. That is the right default, but it discards a great deal of
 * usable information, because each field carries its **own** check digit
 * independently of the composite. A photograph can leave the expiry date
 * unreadable while the document number and date of birth still verify exactly.
 *
 * This repairs each field against its own check digit, ignores the composite,
 * and reports precisely which fields ended up proven. The caller decides what
 * to do with a partial result; nothing here pretends an unverified field is
 * trustworthy.
 */
export function bestEffortLine2(line2: string, maxEdits = 2): BestEffort<string> | null {
  if (line2.length !== TD3_LINE_LENGTH) return null;

  const documentNumber =
    repairField(line2.slice(0, 9), line2.slice(9, 10), { maxEdits })[0] ?? line2.slice(0, 9);
  const birthDate =
    repairField(line2.slice(13, 19), line2.slice(19, 20), { maxEdits, alphabet: 'digits' })[0] ??
    line2.slice(13, 19);
  const expiryDate =
    repairField(line2.slice(21, 27), line2.slice(27, 28), { maxEdits, alphabet: 'digits' })[0] ??
    line2.slice(21, 27);

  const reading =
    documentNumber +
    line2.slice(9, 13) +
    birthDate +
    line2.slice(19, 21) +
    expiryDate +
    line2.slice(27, TD3_LINE_LENGTH);

  return {
    reading,
    edits: editDistance(line2, reading),
    validation: validateLine2(reading),
  };
}

/** The TD1 equivalent of `bestEffortLine2`. */
export function bestEffortTd1Lines(
  upper: string,
  middle: string,
  maxEdits = 2,
): BestEffort<{ upper: string; middle: string }> | null {
  if (upper.length !== TD1_LINE_LENGTH || middle.length !== TD1_LINE_LENGTH) return null;

  const documentNumber =
    repairField(upper.slice(5, 14), upper.slice(14, 15), { maxEdits })[0] ?? upper.slice(5, 14);
  const birthDate =
    repairField(middle.slice(0, 6), middle.slice(6, 7), { maxEdits, alphabet: 'digits' })[0] ??
    middle.slice(0, 6);
  const expiryDate =
    repairField(middle.slice(8, 14), middle.slice(14, 15), { maxEdits, alphabet: 'digits' })[0] ??
    middle.slice(8, 14);

  const upperReading = upper.slice(0, 5) + documentNumber + upper.slice(14);
  const middleReading =
    birthDate + middle.slice(6, 8) + expiryDate + middle.slice(14, TD1_LINE_LENGTH);

  return {
    reading: { upper: upperReading, middle: middleReading },
    edits: editDistance(upper, upperReading) + editDistance(middle, middleReading),
    validation: validateTd1(upperReading, middleReading),
  };
}

/**
 * The TD1 equivalent: repairs the document number on the upper line and the
 * two dates on the middle line. The composite digit, which spans both lines,
 * arbitrates between the surviving combinations.
 */
export function repairTd1Lines(
  upper: string,
  middle: string,
  maxEdits = 2,
): Td1Repair | null {
  if (upper.length !== TD1_LINE_LENGTH || middle.length !== TD1_LINE_LENGTH) return null;

  const docNumbers = repairField(upper.slice(5, 14), upper.slice(14, 15), { maxEdits });
  const birthDates = repairField(middle.slice(0, 6), middle.slice(6, 7), {
    maxEdits,
    alphabet: 'digits',
  });
  const expiryDates = repairField(middle.slice(8, 14), middle.slice(14, 15), {
    maxEdits,
    alphabet: 'digits',
  });

  if (docNumbers.length === 0 || birthDates.length === 0 || expiryDates.length === 0) return null;

  let best: Td1Repair | null = null;
  let tried = 0;

  for (const documentNumber of docNumbers) {
    for (const birthDate of birthDates) {
      for (const expiryDate of expiryDates) {
        if ((tried += 1) > MAX_COMBINATIONS) return best;

        const upperCandidate = upper.slice(0, 5) + documentNumber + upper.slice(14);
        const middleCandidate =
          birthDate + middle.slice(6, 8) + expiryDate + middle.slice(14, TD1_LINE_LENGTH);

        if (!validateTd1(upperCandidate, middleCandidate).allValid) continue;

        const edits =
          editDistance(upper, upperCandidate) + editDistance(middle, middleCandidate);
        if (best === null || edits < best.edits) {
          best = { upper: upperCandidate, middle: middleCandidate, edits };
        }
        if (edits === 0) return best;
      }
    }
  }

  return best;
}

/**
 * Convenience wrapper that pairs a repaired line 2 with a given line 1.
 *
 * Line 1 is passed through untouched and unverified, being outside the reach
 * of every check digit.
 */
export function repairTd3(line1: string, line2: string, maxEdits = 2): RepairResult | null {
  if (line1.length !== TD3_LINE_LENGTH) return null;

  const repaired = repairLine2(line2, maxEdits);
  if (!repaired) return null;

  return { parsed: parseTd3(line1, repaired.line2), edits: repaired.edits };
}

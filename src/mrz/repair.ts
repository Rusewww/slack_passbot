/**
 * Check-digit-driven correction of OCR confusions.
 *
 * OCR-B is a machine-readable font, but photographs still produce a small,
 * predictable set of glyph confusions (0/O, 1/I, 5/S, 8/B, 2/Z ...). Because
 * every significant TD3 field carries a check digit, we do not have to guess
 * which reading is right — we can enumerate the plausible substitutions and
 * keep only the ones that satisfy the arithmetic. A candidate that passes all
 * five check digits is correct for practical purposes; the odds of a wrong
 * reading passing the composite as well are ~1 in 10^5.
 */

import { computeCheckDigit, verifyCheckDigit } from './checkDigit.js';
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
 * cover — line 1 is neither validated nor corrected here.
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

/**
 * Convenience wrapper that pairs a repaired line 2 with a given line 1.
 *
 * Note that line 1 is passed through untouched and unverified — it is outside
 * the reach of every check digit.
 */
export function repairTd3(line1: string, line2: string, maxEdits = 2): RepairResult | null {
  if (line1.length !== TD3_LINE_LENGTH) return null;

  const repaired = repairLine2(line2, maxEdits);
  if (!repaired) return null;

  return { parsed: parseTd3(line1, repaired.line2), edits: repaired.edits };
}

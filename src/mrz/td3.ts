/**
 * ICAO 9303 Part 4 — TD3 (passport) machine readable zone.
 *
 * Two lines of exactly 44 characters. All offsets below are zero-based and
 * fixed by the standard, which is why this parser is a pure function with no
 * heuristics: given 88 correct characters the result is exact.
 *
 *   Line 1: P<UKRTKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<<
 *           ^^ ^^^ ^-------------- names -------------^
 *           |  |
 *           |  issuing state
 *           document code
 *
 *   Line 2: XX000000<0UKR9108242F23092571234567890<<<<70
 *           ^-------^^^^^^-----^^^-----^^-----------^^^^
 */

import { computeCheckDigit, isMrzAlphabet, verifyCheckDigit } from './checkDigit.js';
import type { MrzFields, MrzValidation, Sex as MrzSex } from './fields.js';

export const TD3_LINE_LENGTH = 44;

/** Zero-based [start, end) slices for every TD3 field. */
export const TD3_OFFSETS = {
  line1: {
    documentCode: [0, 2],
    issuingState: [2, 5],
    names: [5, 44],
  },
  line2: {
    documentNumber: [0, 9],
    documentNumberCheck: [9, 10],
    nationality: [10, 13],
    birthDate: [13, 19],
    birthDateCheck: [19, 20],
    sex: [20, 21],
    expiryDate: [21, 27],
    expiryDateCheck: [27, 28],
    personalNumber: [28, 42],
    personalNumberCheck: [42, 43],
    compositeCheck: [43, 44],
  },
} as const;

/** Retained as the TD3-specific spellings of the shared field types. */
export type Sex = MrzSex;
export type Td3Fields = MrzFields;
export type Td3Validation = MrzValidation;

export interface Td3ParseResult {
  fields: MrzFields;
  validation: MrzValidation;
  /** The exact two lines the result was derived from, normalised. */
  lines: [string, string];
}

export class Td3FormatError extends Error {
  override name = 'Td3FormatError';
}

/**
 * Normalises a candidate MRZ line: uppercases, maps common OCR renderings of
 * the filler character, and strips whitespace. Does NOT correct alphabet
 * confusions (0/O, 1/I ...) — that is `repair.ts`, and it must be driven by
 * check digits rather than guesswork.
 */
export function normaliseLine(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«‹≪<]/g, '<')
    .replace(/[\s_\-—–]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * Extracts the two TD3 lines from arbitrary OCR output.
 *
 * Tesseract commonly returns extra lines (edges of the document, stray marks),
 * so we take the last two lines that normalise to 44 MRZ characters.
 */
export function extractTd3Lines(ocrText: string): [string, string] | null {
  const candidates = ocrText
    .split(/\r?\n/)
    .map(normaliseLine)
    .filter((line) => line.length === TD3_LINE_LENGTH);

  if (candidates.length < 2) return null;
  const line2 = candidates[candidates.length - 1] as string;
  const line1 = candidates[candidates.length - 2] as string;
  return [line1, line2];
}

function slice(line: string, [start, end]: readonly [number, number]): string {
  return line.slice(start, end);
}

/** Trims the trailing filler run: `TKACHENKO<<<<` -> `TKACHENKO`. */
function trimFiller(field: string): string {
  return field.replace(/<+$/, '');
}

/** `MARIANA<ANNA` -> `MARIANA ANNA` */
function fillerToSpace(field: string): string {
  return trimFiller(field).replace(/<+/g, ' ').trim();
}

function parseSex(raw: string): Sex {
  if (raw === 'M' || raw === 'F') return raw;
  return 'X';
}

/**
 * The composite check digit covers the document number field (with its check
 * digit), the date of birth field (with its check digit) and the expiry field
 * (with its check digit), plus the optional personal number and its check
 * digit — line 2 positions 1-10, 14-20 and 22-43 in the standard's 1-based
 * numbering.
 */
export function compositeInput(line2: string): string {
  return line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
}

/**
 * Verifies every check digit in a TD3 MRZ.
 *
 * Note what is absent: all five check digits live on line 2. The document
 * code, issuing state and the holder's name — the whole of line 1 — carry no
 * check digit of any kind, so nothing here says anything about them. Line 1
 * has to be judged plausible instead; see `line1.ts`.
 */
export function validateLine2(line2: string): Td3Validation {
  const o2 = TD3_OFFSETS.line2;
  const documentNumberRaw = slice(line2, o2.documentNumber);
  const birthDate = slice(line2, o2.birthDate);
  const expiryDate = slice(line2, o2.expiryDate);
  const personalNumberRaw = slice(line2, o2.personalNumber);

  const validation: Td3Validation = {
    documentNumber: verifyCheckDigit(documentNumberRaw, slice(line2, o2.documentNumberCheck)),
    birthDate: verifyCheckDigit(birthDate, slice(line2, o2.birthDateCheck)),
    expiryDate: verifyCheckDigit(expiryDate, slice(line2, o2.expiryDateCheck)),
    personalNumber: verifyCheckDigit(personalNumberRaw, slice(line2, o2.personalNumberCheck)),
    composite:
      computeCheckDigit(compositeInput(line2)) === Number(slice(line2, o2.compositeCheck)),
    allValid: false,
  };
  validation.allValid =
    validation.documentNumber &&
    validation.birthDate &&
    validation.expiryDate &&
    validation.personalNumber &&
    validation.composite;

  return validation;
}

export function parseTd3(line1: string, line2: string): Td3ParseResult {
  for (const [index, line] of [line1, line2].entries()) {
    if (line.length !== TD3_LINE_LENGTH) {
      throw new Td3FormatError(
        `MRZ line ${index + 1} must be ${TD3_LINE_LENGTH} characters, got ${line.length}`,
      );
    }
    if (!isMrzAlphabet(line)) {
      throw new Td3FormatError(`MRZ line ${index + 1} contains characters outside A-Z0-9<`);
    }
  }

  const o1 = TD3_OFFSETS.line1;
  const o2 = TD3_OFFSETS.line2;

  const names = slice(line1, o1.names);
  const [primaryRaw = '', secondaryRaw = ''] = names.split('<<', 2);

  const documentNumberRaw = slice(line2, o2.documentNumber);
  const birthDate = slice(line2, o2.birthDate);
  const expiryDate = slice(line2, o2.expiryDate);
  const personalNumberRaw = slice(line2, o2.personalNumber);

  // NOTE: ICAO allows document numbers longer than 9 characters, in which case
  // position 10 is `<` and the remainder overflows into the personal number
  // field. Ukrainian passports do not use that form; see docs/ARCHITECTURE.md
  // for the extension point before adding another issuing state.
  const fields: Td3Fields = {
    documentCode: trimFiller(slice(line1, o1.documentCode)),
    issuingState: trimFiller(slice(line1, o1.issuingState)),
    primaryIdentifier: fillerToSpace(primaryRaw),
    secondaryIdentifier: fillerToSpace(secondaryRaw),
    documentNumber: trimFiller(documentNumberRaw),
    nationality: trimFiller(slice(line2, o2.nationality)),
    birthDate,
    sex: parseSex(slice(line2, o2.sex)),
    expiryDate,
    personalNumber: trimFiller(personalNumberRaw),
  };

  return { fields, validation: validateLine2(line2), lines: [line1, line2] };
}

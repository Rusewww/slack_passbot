/**
 * TD1 (identity card) machine readable zone, per ICAO 9303 Part 5.
 *
 * Three lines of exactly 30 characters. Ukrainian ID cards use this format,
 * as do most national identity documents; passports use TD3.
 *
 * Layout, shown with the specimen holder used by the tests:
 *
 *   IDUKRXX000000000000000000000<<
 *   ^^^^^^---------^^------------^
 *   |  |  document  |  optional data
 *   |  |  number    document number check digit
 *   |  issuing state
 *   document code
 *
 *   9108242F2309257UKR<<<<<<<<<<<6
 *   ^-----^^^^-----^^^^^--------^^
 *   birth  | |expiry |  optional  composite check
 *          | |       nationality
 *          | expiry check digit
 *          sex
 *
 *   TKACHENKO<<MARIANA<<<<<<<<<<<<
 *   surname     given names
 *
 * The same asymmetry as TD3 applies, in a different place: the check digits
 * cover the document number, the dates and a composite across lines 1 and 2.
 * The document code, issuing state and the entire third line carry no check
 * digit at all.
 */

import { computeCheckDigit, isMrzAlphabet, verifyCheckDigit } from './checkDigit.js';
import type { MrzFields, MrzValidation, Sex } from './fields.js';
import { extractNames } from './names.js';

export const TD1_LINE_LENGTH = 30;

/** Zero-based [start, end) slices for every TD1 field. */
export const TD1_OFFSETS = {
  upper: {
    documentCode: [0, 2],
    issuingState: [2, 5],
    documentNumber: [5, 14],
    documentNumberCheck: [14, 15],
    optionalData: [15, 30],
  },
  middle: {
    birthDate: [0, 6],
    birthDateCheck: [6, 7],
    sex: [7, 8],
    expiryDate: [8, 14],
    expiryDateCheck: [14, 15],
    nationality: [15, 18],
    optionalData: [18, 29],
    compositeCheck: [29, 30],
  },
} as const;

export class Td1FormatError extends Error {
  override name = 'Td1FormatError';
}

function slice(line: string, [start, end]: readonly [number, number]): string {
  return line.slice(start, end);
}

function trimFiller(field: string): string {
  return field.replace(/<+$/, '');
}

function parseSex(raw: string): Sex {
  if (raw === 'M' || raw === 'F') return raw;
  return 'X';
}

/**
 * The composite check digit spans both of the first two lines: upper line
 * positions 6-30, middle line positions 1-7, 9-15 and 19-29 in the standard's
 * 1-based numbering.
 */
export function compositeInputTd1(upper: string, middle: string): string {
  return upper.slice(5, 30) + middle.slice(0, 7) + middle.slice(8, 15) + middle.slice(18, 29);
}

/**
 * Verifies every check digit in a TD1 MRZ.
 *
 * As with TD3, note the scope: nothing here says anything about the document
 * code, the issuing state, or the name line.
 */
export function validateTd1(upper: string, middle: string): MrzValidation {
  const u = TD1_OFFSETS.upper;
  const m = TD1_OFFSETS.middle;

  const validation: MrzValidation = {
    documentNumber: verifyCheckDigit(
      slice(upper, u.documentNumber),
      slice(upper, u.documentNumberCheck),
    ),
    birthDate: verifyCheckDigit(slice(middle, m.birthDate), slice(middle, m.birthDateCheck)),
    expiryDate: verifyCheckDigit(slice(middle, m.expiryDate), slice(middle, m.expiryDateCheck)),
    // TD1 has no separate personal-number check digit; the optional data is
    // covered by the composite only.
    personalNumber: true,
    composite:
      computeCheckDigit(compositeInputTd1(upper, middle)) ===
      Number(slice(middle, m.compositeCheck)),
    allValid: false,
  };
  validation.allValid =
    validation.documentNumber &&
    validation.birthDate &&
    validation.expiryDate &&
    validation.composite;

  return validation;
}

export interface Td1ParseResult {
  fields: MrzFields;
  validation: MrzValidation;
  lines: [string, string, string];
}

export function parseTd1(upper: string, middle: string, names: string): Td1ParseResult {
  for (const [index, line] of [upper, middle, names].entries()) {
    if (line.length !== TD1_LINE_LENGTH) {
      throw new Td1FormatError(
        `MRZ line ${index + 1} must be ${TD1_LINE_LENGTH} characters, got ${line.length}`,
      );
    }
    if (!isMrzAlphabet(line)) {
      throw new Td1FormatError(`MRZ line ${index + 1} contains characters outside A-Z0-9<`);
    }
  }

  const u = TD1_OFFSETS.upper;
  const m = TD1_OFFSETS.middle;
  const parsedNames = extractNames(names);

  const fields: MrzFields = {
    documentCode: trimFiller(slice(upper, u.documentCode)),
    issuingState: trimFiller(slice(upper, u.issuingState)),
    primaryIdentifier: parsedNames?.primaryIdentifier ?? '',
    secondaryIdentifier: parsedNames?.secondaryIdentifier ?? '',
    documentNumber: trimFiller(slice(upper, u.documentNumber)),
    nationality: trimFiller(slice(middle, m.nationality)),
    birthDate: slice(middle, m.birthDate),
    sex: parseSex(slice(middle, m.sex)),
    expiryDate: slice(middle, m.expiryDate),
    personalNumber: trimFiller(slice(upper, u.optionalData)),
  };

  return { fields, validation: validateTd1(upper, middle), lines: [upper, middle, names] };
}

/**
 * Whether a line could be the TD1 name line.
 *
 * Used to keep the name line out of the upper/middle pairing search, and to
 * gather candidates for the consensus vote.
 */
export function looksLikeNameLine(line: string): boolean {
  return line.length === TD1_LINE_LENGTH && extractNames(line) !== null;
}

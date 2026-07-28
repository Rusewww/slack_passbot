/**
 * Reconstruction of TD3 line 1 from several imperfect OCR readings.
 *
 * Line 1 holds the document code, the issuing state and the holder's name. It
 * carries **no check digit of any kind** — every check digit in ICAO 9303 TD3
 * is computed over line 2. Line 2 can therefore be proven correct; line 1 can
 * only be judged plausible, and the two must not be selected together as a
 * unit. Doing so is how a perfectly verified line 2 can arrive attached to a
 * garbage name.
 *
 * The name half of the problem is solved in `names.ts`, which TD1 shares. What
 * is specific to TD3 line 1 is the five-character prefix in front of the name
 * field, and the structural signals that prefix provides.
 */

import type { MrzFields } from './fields.js';
import { chooseNames, extractNames, fillerRatio, vote, type NameFields } from './names.js';
import { TD3_LINE_LENGTH } from './td3.js';

export type Line1Fields = Pick<
  MrzFields,
  'documentCode' | 'issuingState' | 'primaryIdentifier' | 'secondaryIdentifier'
>;

/** Zero-based offset at which the name field begins. */
const NAME_START = 5;

/** Candidates shorter than this cannot hold a document code, state and a name. */
const MIN_CANDIDATE_LENGTH = 12;
const MAX_CANDIDATE_LENGTH = 60;

/**
 * Reads fields out of one candidate line without judging them. Returns null
 * only when the line cannot be a TD3 line 1 at all.
 */
export function extractLine1(line: string): Line1Fields | null {
  if (line.length < MIN_CANDIDATE_LENGTH || line.length > MAX_CANDIDATE_LENGTH) return null;

  // Line 2 also contains `<<` — its personal-number field is filler-padded —
  // so it has to be excluded explicitly. The issuing state is the cleanest
  // discriminator: three letters on line 1, digits on line 2.
  const issuingState = line.slice(2, 5).replace(/<+$/, '');
  if (!/^[A-Z]+$/.test(issuingState)) return null;
  if (!/^[A-Z]/.test(line)) return null;

  const names = extractNames(line.slice(NAME_START));
  if (!names) return null;

  return {
    documentCode: line.slice(0, 2).replace(/<+$/, ''),
    issuingState,
    ...names,
  };
}

/**
 * How much this candidate's opinion is worth.
 *
 * Every signal here is structural — things that are true of a well-formed line
 * 1 and unlikely to survive a bad read. None of them can prove a candidate
 * correct; they only decide whose vote counts for more.
 */
export function scoreLine1(line: string, fields: Line1Fields, nationality: string): number {
  let score = 1;

  // The second character of the document code is `<` for an ordinary
  // passport. A letter there usually means a filler was misrecognised, which
  // is exactly the error that turns `P<` into `PK`.
  if (line[1] === '<') score += 2;

  // Issuing state and nationality are the same on the overwhelming majority of
  // documents. A bonus rather than a requirement, because they are legitimately
  // allowed to differ.
  if (fields.issuingState === nationality) score += 2;

  // A well-formed line 1 is mostly padding. A candidate with little filler has
  // had its padding read as letters, so its name field is suspect too.
  if (fillerRatio(line) >= 0.3) score += 1;

  return score;
}

/**
 * Chooses TD3 line 1 field-by-field across every candidate reading.
 *
 * `nationality` comes from the already-verified line 2 and is used only to
 * weight candidates.
 */
export function chooseLine1Fields(
  candidateLines: readonly string[],
  nationality: string,
): Line1Fields | null {
  const scored = candidateLines
    .map((line) => {
      const fields = extractLine1(line);
      return fields ? { line, fields, weight: scoreLine1(line, fields, nationality) } : null;
    })
    .filter((entry): entry is { line: string; fields: Line1Fields; weight: number } => entry !== null);

  if (scored.length === 0) return null;

  const names: NameFields | null = chooseNames(
    scored.map(({ line, weight }) => ({ field: line.slice(NAME_START), weight })),
  );
  if (!names) return null;

  return {
    documentCode: vote(scored.map(({ fields, weight }) => ({ value: fields.documentCode, weight }))),
    issuingState: vote(scored.map(({ fields, weight }) => ({ value: fields.issuingState, weight }))),
    ...names,
  };
}

/**
 * Rebuilds a canonical 44-character line 1 from chosen fields, so the result
 * can go back through the standard parser rather than bypassing it.
 */
export function buildLine1(fields: Line1Fields): string {
  const names = fields.secondaryIdentifier
    ? `${fields.primaryIdentifier}<<${fields.secondaryIdentifier.replace(/ /g, '<')}`
    : `${fields.primaryIdentifier}<<`;

  const line = fields.documentCode.padEnd(2, '<') + fields.issuingState.padEnd(3, '<') + names;

  return line.padEnd(TD3_LINE_LENGTH, '<').slice(0, TD3_LINE_LENGTH);
}

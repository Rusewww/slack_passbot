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
 * What replaces proof here is redundancy. The sidecar returns one reading per
 * preprocessing variant, so we get several independent attempts at the same
 * strip. Errors differ between them; the truth tends to repeat. This module
 * extracts fields from every candidate, weights each candidate by how
 * structurally believable it is, and takes a weighted majority per field.
 *
 * The dominant error mode this defends against is the filler character `<`
 * being recognised as a letter — `K`, `E`, `S`, `X` — because the stock `eng`
 * Tesseract model has no OCR-B chevron. A real MRZ line 1 is mostly filler, so
 * that noise lands overwhelmingly in the padding after the name.
 */

import { TD3_LINE_LENGTH } from './td3.js';

export interface Line1Fields {
  documentCode: string;
  issuingState: string;
  /** Surname. */
  primaryIdentifier: string;
  /** Given names, space-separated. */
  secondaryIdentifier: string;
}

/** Zero-based offset at which the name field begins. */
const NAME_START = 5;

/**
 * Within the name field, components are separated by one filler (between given
 * names) or two (between surname and given names). A run of three or more
 * means the padding has begun and everything after it is noise.
 */
const PADDING_RUN = /<{3,}/;

/** Candidates shorter than this cannot hold a document code, state and a name. */
const MIN_CANDIDATE_LENGTH = 12;
const MAX_CANDIDATE_LENGTH = 60;

/**
 * Splits the name field into surname and given names, discarding filler runs.
 *
 * Single-character given names are dropped when longer ones are present: a
 * lone letter among the given names is almost always a misread `<`, as in
 * `SURNAME<X<GIVEN` where the `<<` separator lost its middle. A genuinely
 * single-letter given name survives when it is the only one, so an initial is
 * not silently discarded.
 */
function nameComponents(names: string): { surname: string; given: string[] } | null {
  const match = PADDING_RUN.exec(names);
  const content = match ? names.slice(0, match.index) : names;

  const [surname, ...rest] = content.split(/<+/).filter(Boolean);
  if (!surname) return null;

  const substantial = rest.filter((part) => part.length > 1);
  return { surname, given: substantial.length > 0 ? substantial : rest };
}

/**
 * Reads fields out of one candidate line without judging them. Returns null
 * only when the line cannot be a line 1 at all.
 */
export function extractLine1(line: string): Line1Fields | null {
  if (line.length < MIN_CANDIDATE_LENGTH || line.length > MAX_CANDIDATE_LENGTH) return null;
  // Every TD3 line 1 separates surname from given names with `<<`. Lines
  // without it are visual-zone text the recogniser picked up by accident.
  if (!line.includes('<<')) return null;

  // Line 2 also contains `<<` — its personal-number field is filler-padded —
  // so it has to be excluded explicitly. The issuing state is the cleanest
  // discriminator: three letters on line 1, digits on line 2.
  const issuingState = line.slice(2, 5).replace(/<+$/, '');
  if (!/^[A-Z]+$/.test(issuingState)) return null;
  if (!/^[A-Z]/.test(line)) return null;

  const components = nameComponents(line.slice(NAME_START));
  if (!components || components.surname.length < 2) return null;
  // A name is letters. Digits here mean this is not a name field.
  if (!/^[A-Z]+$/.test(components.surname)) return null;

  return {
    documentCode: line.slice(0, 2).replace(/<+$/, ''),
    issuingState,
    primaryIdentifier: components.surname,
    secondaryIdentifier: components.given.join(' '),
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
  const fillerRatio = (line.match(/</g) ?? []).length / line.length;
  if (fillerRatio >= 0.3) score += 1;

  return score;
}

/** Picks the highest-weighted value for one field. */
function vote(entries: Array<{ value: string; weight: number }>): string {
  const totals = new Map<string, number>();
  for (const { value, weight } of entries) {
    totals.set(value, (totals.get(value) ?? 0) + weight);
  }

  let best = '';
  let bestWeight = -1;
  for (const [value, weight] of totals) {
    if (weight > bestWeight) {
      best = value;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Chooses line 1 field-by-field across every candidate reading.
 *
 * Voting per field rather than picking a single best line matters: in practice
 * no single variant is right about everything, but each field's correct value
 * is usually the most common one across variants.
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
      return fields ? { fields, weight: scoreLine1(line, fields, nationality) } : null;
    })
    .filter((entry): entry is { fields: Line1Fields; weight: number } => entry !== null);

  if (scored.length === 0) return null;

  const pick = (key: keyof Line1Fields): string =>
    vote(scored.map(({ fields, weight }) => ({ value: fields[key], weight })));

  const primaryIdentifier = pick('primaryIdentifier');
  if (!primaryIdentifier) return null;

  return {
    documentCode: pick('documentCode'),
    issuingState: pick('issuingState'),
    primaryIdentifier,
    secondaryIdentifier: pick('secondaryIdentifier'),
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

  const line =
    fields.documentCode.padEnd(2, '<') + fields.issuingState.padEnd(3, '<') + names;

  return line.padEnd(TD3_LINE_LENGTH, '<').slice(0, TD3_LINE_LENGTH);
}

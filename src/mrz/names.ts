/**
 * The name field, and the consensus machinery used to recover it.
 *
 * Both supported formats put the holder's name outside the reach of every
 * check digit — TD3 on line 1, TD1 on line 3. Those characters can never be
 * proven correct, only judged plausible, so they are handled separately from
 * the fields the arithmetic covers.
 *
 * What stands in for proof is redundancy. The OCR sidecar returns one reading
 * per preprocessing variant, giving several independent attempts at the same
 * strip. Errors differ between attempts; the truth tends to repeat. So each
 * field is decided by a weighted majority across variants rather than by
 * trusting whichever single reading happened to look well-formed.
 *
 * The dominant error is the filler `<` being recognised as a letter — `K`,
 * `E`, `S`, `X` — because the stock `eng` Tesseract model has no OCR-B
 * chevron. A name field is mostly filler, so that noise lands overwhelmingly
 * in the padding after the name, where per-field voting discards it.
 */

export interface NameFields {
  /** Surname. */
  primaryIdentifier: string;
  /** Given names, space-separated. */
  secondaryIdentifier: string;
}

/**
 * Within a name field, components are separated by one filler (between given
 * names) or two (between surname and given names). A run of three or more
 * means the padding has begun and everything after it is noise.
 */
const PADDING_RUN = /<{3,}/;

/**
 * Splits a name field into surname and given names, discarding filler runs.
 *
 * Single-character given names are dropped when longer ones are present: a
 * lone letter among the given names is almost always a misread `<`, as in
 * `SURNAME<X<GIVEN` where the `<<` separator lost its middle. A genuinely
 * single-letter given name survives when it is the only one, so an initial is
 * not silently discarded.
 */
export function nameComponents(field: string): { surname: string; given: string[] } | null {
  const match = PADDING_RUN.exec(field);
  const content = match ? field.slice(0, match.index) : field;

  const [surname, ...rest] = content.split(/<+/).filter(Boolean);
  if (!surname) return null;

  const substantial = rest.filter((part) => part.length > 1);
  return { surname, given: substantial.length > 0 ? substantial : rest };
}

/**
 * Plausibility bounds for a name.
 *
 * ICAO gives the whole name field 39 characters on TD3 and 30 on TD1, so a
 * single component longer than this is not a name — it is a run of
 * misrecognised padding. Nor does an MRZ carry five given names; the field is
 * truncated long before that.
 */
const MAX_COMPONENT_LENGTH = 26;
const MAX_GIVEN_NAMES = 4;

/** A name is letters. Nothing else belongs in one. */
const NAME_COMPONENT = /^[A-Z]+$/;

/** Beyond this length, a component of one repeated letter is noise, not a name. */
const MAX_REPEATED_RUN = 3;

/**
 * True for a component that is the same letter over and over — `KKKKKKKK`.
 *
 * This is what misread padding looks like once it has been mistaken for a
 * name, and no real name resembles it. Short repeats are left alone so that
 * nothing legitimate is caught.
 */
function isRepeatedLetter(component: string): boolean {
  return component.length > MAX_REPEATED_RUN && new Set(component).size === 1;
}

/**
 * Reads a name field, or null when it cannot be one.
 *
 * Every component is checked, not only the surname. That distinction caused a
 * real failure twice over: readings of `EVA ERI LEILAKKK6660CKREKKKKRKCK` and
 * `KKKKKKKKKKKKKKKK` were both accepted and delivered as names, because only
 * the surname had ever been tested for being alphabetic.
 *
 * Rejecting here is safe in a way that guessing is not. The name is the one
 * part of an MRZ no check digit protects, so a reading that fails these basic
 * structural tests is the only evidence available that it is wrong — and it is
 * conclusive evidence. Digits do not occur in names.
 */
export function extractNames(field: string): NameFields | null {
  // Every name field separates surname from given names with `<<`. Without it
  // this is visual-zone text the recogniser picked up by accident.
  if (!field.includes('<<')) return null;

  const components = nameComponents(field);
  if (!components) return null;

  const { surname, given } = components;
  if (surname.length < 2) return null;
  if (given.length > MAX_GIVEN_NAMES) return null;

  for (const component of [surname, ...given]) {
    if (!NAME_COMPONENT.test(component)) return null;
    if (component.length > MAX_COMPONENT_LENGTH) return null;
    if (isRepeatedLetter(component)) return null;
  }

  return {
    primaryIdentifier: surname,
    secondaryIdentifier: given.join(' '),
  };
}

/** Proportion of a line that is the filler character. */
export function fillerRatio(line: string): number {
  if (line.length === 0) return 0;
  return (line.match(/</g) ?? []).length / line.length;
}

/**
 * Characters Tesseract most often emits in place of the filler `<`.
 *
 * Deliberately narrow. `S`, `C` and `R` also occur as filler misreads but are
 * common name endings — `DENYS`, `IHOR` — and crediting a shortened reading on
 * their account would corrupt real names. `K` is the dominant artifact by a
 * wide margin.
 */
const FILLER_ARTIFACTS = new Set(['K', 'E', 'X']);

/**
 * Credits a reading whose only difference from another is one trailing filler
 * artifact.
 *
 * When the padding after a name is misread, the first stray character attaches
 * itself to the name: `MARIANA` becomes `MARIANAK`. Both readings then appear
 * across variants, and plain majority can pick the wrong one. The prior that
 * settles it is directional — OCR turns `<` into a letter far more readily
 * than it drops a real letter — so the shorter reading inherits the weight of
 * the longer one it prefixes.
 *
 * Applied to given names only. A surname is followed by `<<` and then more
 * name, not by padding, so a surname ending in `K` — `KOVALCHUK` and the many
 * Ukrainian surnames like it — is never this artifact and must not be eroded
 * by this rule.
 */
function creditTrailingArtifacts(
  entries: ReadonlyArray<{ value: string; weight: number }>,
): Array<{ value: string; weight: number }> {
  const totals = new Map<string, number>();
  for (const { value, weight } of entries) {
    totals.set(value, (totals.get(value) ?? 0) + weight);
  }

  const adjusted = new Map(totals);
  for (const [longer, weight] of totals) {
    const last = longer[longer.length - 1];
    if (!last || !FILLER_ARTIFACTS.has(last)) continue;

    const shorter = longer.slice(0, -1);
    if (totals.has(shorter)) {
      adjusted.set(shorter, (adjusted.get(shorter) ?? 0) + weight);
    }
  }

  return [...adjusted].map(([value, weight]) => ({ value, weight }));
}

/** Picks the highest-weighted value for one field. */
export function vote(entries: ReadonlyArray<{ value: string; weight: number }>): string {
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
 * Chooses the name fields by weighted majority across candidate name fields.
 *
 * Voting per field rather than picking a single best line matters: in practice
 * no single variant is right about everything, but each field's correct value
 * is usually the most common one across variants.
 */
export function chooseNames(
  candidates: ReadonlyArray<{ field: string; weight: number }>,
): NameFields | null {
  const scored = candidates
    .map(({ field, weight }) => {
      const names = extractNames(field);
      return names ? { names, weight } : null;
    })
    .filter((entry): entry is { names: NameFields; weight: number } => entry !== null);

  if (scored.length === 0) return null;

  const primaryIdentifier = vote(
    scored.map(({ names, weight }) => ({ value: names.primaryIdentifier, weight })),
  );
  if (!primaryIdentifier) return null;

  return {
    primaryIdentifier,
    secondaryIdentifier: vote(
      creditTrailingArtifacts(
        scored.map(({ names, weight }) => ({ value: names.secondaryIdentifier, weight })),
      ),
    ),
  };
}

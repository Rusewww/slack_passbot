/**
 * Extraction pipeline.
 *
 * Ordered simplest-first, and every stage is gated on the same acceptance test:
 * all five TD3 check digits must hold. Nothing is delivered on the strength of
 * a recogniser's confidence score alone.
 *
 *   1. Tesseract candidates from the sidecar, parsed as-is   (local, ~0.3-1 s)
 *   2. Check-digit-driven repair of those candidates         (local, sub-ms)
 *   3. Vision model, if explicitly enabled                   (external, ~2-4 s)
 *
 * Stage 1 or 2 answers the large majority of real uploads, so the external
 * path is rarely reached.
 */

import type { Logger } from 'pino';

import type { MrzFields, MrzFormat, MrzValidation } from '../mrz/fields.js';
import { formatPassbotLine } from '../mrz/format.js';
import { buildLine1, chooseLine1Fields } from '../mrz/line1.js';
import { chooseNames } from '../mrz/names.js';
import { repairLine2, repairTd1Lines, repairTd3, type Td1Repair } from '../mrz/repair.js';
import { looksLikeNameLine, parseTd1, TD1_LINE_LENGTH } from '../mrz/td1.js';
import { parseTd3, Td3FormatError, TD3_LINE_LENGTH, type Td3ParseResult } from '../mrz/td3.js';
import { FallbackUnsupported, recogniseWithVision } from '../ocr/fallback.js';
import {
  recognise,
  SidecarRejected,
  SidecarUnavailable,
  type SidecarCandidate,
} from '../ocr/sidecar.js';
import type {
  ExtractionFailureReason,
  ExtractionResult,
  ExtractionSource,
  ImageInput,
} from '../types.js';

export interface PipelineDeps {
  logger: Logger;
  sidecar: { baseUrl: string; timeoutMs: number; maxPixels: number };
  fallback: { enabled: boolean; apiKey?: string | undefined; model: string };
}

function accept(
  parsed: { fields: MrzFields; validation: MrzValidation },
  source: ExtractionSource,
  edits: number,
): ExtractionResult {
  return {
    ok: true,
    fields: parsed.fields,
    validation: parsed.validation,
    source,
    edits,
    formatted: formatPassbotLine(parsed.fields),
  };
}

/** Parses without throwing; a format error is an expected outcome of bad OCR. */
function tryParse(lines: [string, string]): Td3ParseResult | null {
  try {
    return parseTd3(lines[0], lines[1]);
  } catch (error) {
    if (error instanceof Td3FormatError) return null;
    throw error;
  }
}

interface Adjudicated {
  parsed: { fields: MrzFields; validation: MrzValidation };
  format: MrzFormat;
  edits: number;
}

/**
 * Picks the best reading across all preprocessing variants.
 *
 * The two MRZ lines are chosen **independently**, from a pooled set of every
 * line every variant produced. That asymmetry is deliberate and is the point
 * of this function:
 *
 *   - Line 2 carries all five check digits, so a candidate can be *proven*
 *     correct. Exact reads win outright; otherwise the repaired candidate
 *     needing the fewest substitutions wins.
 *   - Line 1 carries no check digit at all, so no candidate can be proven.
 *     It is reconstructed field-by-field by weighted majority across every
 *     variant (see `mrz/line1.ts`).
 *
 * Selecting both lines from whichever single variant happened to parse is what
 * this replaces. A variant can produce a flawless line 2 and a badly corrupted
 * line 1, and the check digits will happily certify the pair — because they
 * never looked at line 1.
 */
function adjudicateTd3(pool: readonly string[]): Adjudicated | null {
  // --- Line 2: provable ---------------------------------------------------
  let line2: { value: string; edits: number } | null = null;
  for (const line of pool) {
    if (line.length !== TD3_LINE_LENGTH) continue;

    const repaired = repairLine2(line);
    if (!repaired) continue;
    if (line2 === null || repaired.edits < line2.edits) {
      line2 = { value: repaired.line2, edits: repaired.edits };
    }
    if (repaired.edits === 0) break;
  }
  if (!line2) return null;

  // --- Line 1: plausible only ---------------------------------------------
  const nationality = line2.value.slice(10, 13).replace(/<+$/, '');
  const line1Fields = chooseLine1Fields(pool, nationality);
  if (!line1Fields) return null;

  const parsed = tryParse([buildLine1(line1Fields), line2.value]);
  if (!parsed?.validation.allValid) return null;

  return { parsed, format: 'TD3', edits: line2.edits };
}

/**
 * TD1 identity cards: three lines of 30.
 *
 * The upper and middle lines are found by trying every ordered pair of
 * 30-character lines and keeping the one the check digits accept. That is
 * cheaper than it sounds — the pool is small — and it avoids having to
 * classify lines by pattern-matching, which is exactly the kind of heuristic
 * that misfires on a bad read. Proof decides the pairing wherever proof is
 * available.
 *
 * The name line is then chosen by consensus, for the same reason as TD3 line
 * 1: it carries no check digit.
 */
function adjudicateTd1(pool: readonly string[]): Adjudicated | null {
  const lines = pool.filter((line) => line.length === TD1_LINE_LENGTH);
  if (lines.length < 2) return null;

  let pair: Td1Repair | null = null;
  for (const upper of lines) {
    for (const middle of lines) {
      if (upper === middle) continue;

      const repaired = repairTd1Lines(upper, middle);
      if (!repaired) continue;
      if (pair === null || repaired.edits < pair.edits) pair = repaired;
      if (repaired.edits === 0) break;
    }
    if (pair?.edits === 0) break;
  }
  if (!pair) return null;

  // The name line must not be one of the two already claimed.
  const nameCandidates = lines.filter(
    (line) => line !== pair.upper && line !== pair.middle && looksLikeNameLine(line),
  );
  const names = chooseNames(nameCandidates.map((field) => ({ field, weight: 1 })));
  if (!names) return null;

  const nameLine = `${names.primaryIdentifier}<<${names.secondaryIdentifier.replace(/ /g, '<')}`
    .padEnd(TD1_LINE_LENGTH, '<')
    .slice(0, TD1_LINE_LENGTH);

  const parsed = parseTd1(pair.upper, pair.middle, nameLine);
  if (!parsed.validation.allValid) return null;

  return { parsed, format: 'TD1', edits: pair.edits };
}

/**
 * Picks the best reading across all preprocessing variants.
 *
 * TD3 is tried first because passports are the common case; TD1 identity cards
 * fall through to the second attempt. A document is only ever one of the two,
 * so the order affects speed and nothing else.
 */
function adjudicate(candidates: SidecarCandidate[]): Adjudicated | null {
  const pool = [...new Set(candidates.flatMap((candidate) => candidate.lines))];
  return adjudicateTd3(pool) ?? adjudicateTd1(pool);
}

/**
 * Explains a failure in terms the user can act on.
 *
 * The distinction that matters: lines of a supported length that would not
 * validate is a photograph problem, and the user should retake it. Lines of
 * some other length is a format problem, and retaking the photograph will
 * never help.
 */
function diagnose(candidates: SidecarCandidate[]): ExtractionFailureReason {
  const lengths = new Set(
    candidates.flatMap((candidate) => candidate.lines).map((line) => line.length),
  );

  if (lengths.has(TD3_LINE_LENGTH) || lengths.has(TD1_LINE_LENGTH)) {
    return 'check_digits_failed';
  }
  // A long run of MRZ-alphabet characters that is neither 44 nor 30 is very
  // likely a format we do not decode — TD2, or a visa — rather than noise.
  if ([...lengths].some((length) => length >= 28)) return 'unsupported_mrz';
  return 'no_mrz_found';
}

export async function extractMrz(image: ImageInput, deps: PipelineDeps): Promise<ExtractionResult> {
  const log = deps.logger.child({ fileId: image.fileId });
  const canFallBack = deps.fallback.enabled && Boolean(deps.fallback.apiKey);

  // --- Stages 1 & 2: deterministic OCR, then check-digit repair -----------
  let deterministicFailure: ExtractionFailureReason = 'no_mrz_found';
  try {
    const result = await recognise(image.bytes, image.mimeType, deps.sidecar);
    deterministicFailure = diagnose(result.candidates);
    log.debug({ variants: result.candidates.length, durationMs: result.durationMs }, 'sidecar done');

    const winner = adjudicate(result.candidates);
    if (winner) {
      log.info({ format: winner.format, edits: winner.edits }, 'MRZ accepted');
      return accept(
        winner.parsed,
        winner.edits === 0 ? 'tesseract' : 'tesseract+repair',
        winner.edits,
      );
    }
  } catch (error) {
    if (error instanceof SidecarRejected) {
      return {
        ok: false,
        reason: error.code === 'too_large' ? 'too_large' : 'unsupported_format',
        detail: error.message,
      };
    }
    if (!(error instanceof SidecarUnavailable)) throw error;

    log.error({ err: error.message }, 'OCR sidecar unavailable');
    if (!canFallBack) {
      return { ok: false, reason: 'ocr_unavailable', detail: error.message };
    }
  }

  // --- Stage 3: vision fallback ------------------------------------------
  if (!canFallBack) {
    return { ok: false, reason: deterministicFailure };
  }

  try {
    const visionLines = await recogniseWithVision(image.bytes, image.mimeType, {
      apiKey: deps.fallback.apiKey as string,
      model: deps.fallback.model,
    });
    if (!visionLines) return { ok: false, reason: 'no_mrz_found' };

    // The model's reading is held to exactly the same standard as Tesseract's,
    // so a hallucinated document number cannot reach the user.
    const parsed = tryParse(visionLines);
    if (parsed?.validation.allValid) {
      log.info({ stage: 'ai-fallback' }, 'MRZ accepted');
      return accept(parsed, 'ai-fallback', 0);
    }

    const repaired = repairTd3(visionLines[0], visionLines[1]);
    if (repaired) {
      log.info({ stage: 'ai-fallback', edits: repaired.edits }, 'MRZ accepted');
      return accept(repaired.parsed, 'ai-fallback', repaired.edits);
    }

    return { ok: false, reason: 'check_digits_failed' };
  } catch (error) {
    if (error instanceof FallbackUnsupported) {
      return { ok: false, reason: 'unsupported_format', detail: error.message };
    }
    log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'vision fallback failed');
    return { ok: false, reason: 'unreadable' };
  }
}

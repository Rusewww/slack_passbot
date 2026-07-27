/**
 * Extraction pipeline.
 *
 * Ordered cheapest-first, and every stage is gated on the same acceptance test:
 * all five TD3 check digits must hold. Nothing is delivered on the strength of
 * a recogniser's confidence score alone.
 *
 *   1. Tesseract candidates from the sidecar, parsed as-is   (free, ~0.3-1 s)
 *   2. Check-digit-driven repair of those candidates         (free, sub-ms)
 *   3. Vision model, if explicitly enabled                   (paid, ~2-4 s)
 *
 * Stage 1 or 2 answers the large majority of real uploads, which is what keeps
 * the running cost of this service close to zero.
 */

import type { Logger } from 'pino';

import { formatPassbotLine } from '../mrz/format.js';
import { repairTd3 } from '../mrz/repair.js';
import { extractTd3Lines, parseTd3, Td3FormatError, type Td3ParseResult } from '../mrz/td3.js';
import { FallbackUnsupported, recogniseWithVision } from '../ocr/fallback.js';
import {
  recognise,
  SidecarRejected,
  SidecarUnavailable,
  type SidecarCandidate,
} from '../ocr/sidecar.js';
import type { ExtractionResult, ExtractionSource, ImageInput } from '../types.js';

export interface PipelineDeps {
  logger: Logger;
  sidecar: { baseUrl: string; timeoutMs: number; maxPixels: number };
  fallback: { enabled: boolean; apiKey?: string | undefined; model: string };
}

function accept(parsed: Td3ParseResult, source: ExtractionSource, edits: number): ExtractionResult {
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
  parsed: Td3ParseResult;
  edits: number;
  variant: string;
}

/**
 * Picks the best reading across all preprocessing variants.
 *
 * Exact reads win outright. Otherwise the repaired candidate needing the
 * fewest substitutions wins — every candidate considered here has already
 * satisfied all five check digits, so the tie-break is about which is most
 * faithful to what the camera saw, not about which is more likely correct.
 */
function adjudicate(candidates: SidecarCandidate[]): Adjudicated | null {
  let best: Adjudicated | null = null;

  for (const candidate of candidates) {
    const lines = extractTd3Lines(candidate.lines.join('\n'));
    if (!lines) continue;

    const parsed = tryParse(lines);
    if (parsed?.validation.allValid) {
      return { parsed, edits: 0, variant: candidate.variant };
    }

    const repaired = repairTd3(lines[0], lines[1]);
    if (repaired && (best === null || repaired.edits < best.edits)) {
      best = { parsed: repaired.parsed, edits: repaired.edits, variant: candidate.variant };
    }
  }

  return best;
}

export async function extractMrz(image: ImageInput, deps: PipelineDeps): Promise<ExtractionResult> {
  const log = deps.logger.child({ fileId: image.fileId });
  const canFallBack = deps.fallback.enabled && Boolean(deps.fallback.apiKey);

  // --- Stages 1 & 2: deterministic OCR, then check-digit repair -----------
  let sawCandidates = false;
  try {
    const result = await recognise(image.bytes, image.mimeType, deps.sidecar);
    sawCandidates = result.candidates.length > 0;
    log.debug({ variants: result.candidates.length, durationMs: result.durationMs }, 'sidecar done');

    const winner = adjudicate(result.candidates);
    if (winner) {
      log.info({ variant: winner.variant, edits: winner.edits }, 'MRZ accepted');
      return accept(winner.parsed, winner.edits === 0 ? 'tesseract' : 'tesseract+repair', winner.edits);
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
    return { ok: false, reason: sawCandidates ? 'check_digits_failed' : 'no_mrz_found' };
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

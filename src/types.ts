import type { Td3Fields, Td3Validation } from './mrz/td3.js';

/** Which stage of the pipeline produced the accepted reading. */
export type ExtractionSource = 'tesseract' | 'tesseract+repair' | 'ai-fallback';

export interface ExtractionSuccess {
  ok: true;
  fields: Td3Fields;
  validation: Td3Validation;
  source: ExtractionSource;
  /** Character substitutions applied by check-digit repair, if any. */
  edits: number;
  /** Formatted delivery string, e.g. `P/UKR/XX000000/...`. */
  formatted: string;
}

export type ExtractionFailureReason =
  | 'no_mrz_found'
  | 'unreadable'
  | 'check_digits_failed'
  | 'unsupported_format'
  | 'too_large'
  | 'ocr_unavailable'
  | 'timeout';

export interface ExtractionFailure {
  ok: false;
  reason: ExtractionFailureReason;
  /** Operator-facing detail. Must never contain document data. */
  detail?: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/** An image accepted for processing, held in memory only. */
export interface ImageInput {
  bytes: Buffer;
  mimeType: string;
  /** Slack file id, used for correlation in logs. Not sensitive. */
  fileId: string;
}

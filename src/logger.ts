/**
 * Structured logging with document data redacted at the transport level.
 *
 * The rule this module enforces: an MRZ string, a decoded field, or an image
 * buffer must never be able to reach a log sink, even by accident — logs
 * outlive the request and are the most common way sensitive data leaks out of
 * an otherwise stateless service.
 */

import pino, { type Logger } from 'pino';

/** Keys whose values are replaced with `[redacted]` wherever they appear. */
const REDACTED_KEYS = [
  'mrz',
  'line1',
  'line2',
  'lines',
  'fields',
  'documentNumber',
  'personalNumber',
  'primaryIdentifier',
  'secondaryIdentifier',
  'birthDate',
  'expiryDate',
  'nationality',
  'sex',
  'text',
  'image',
  'buffer',
  'token',
  'authorization',
  'apiKey',
];

const redactPaths = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export function createLogger(level: string, env: string): Logger {
  return pino({
    level,
    redact: { paths: redactPaths, censor: '[redacted]' },
    base: { service: 'passbot' },
    // Pretty output is a dev-only convenience; production emits JSON lines.
    ...(env === 'development'
      ? { transport: { target: 'pino/file', options: { destination: 1 } } }
      : {}),
  });
}

/**
 * Collapses an MRZ-bearing value to a shape that is safe to log: length and a
 * digest-free structural summary, never content.
 */
export function safeSummary(value: string | undefined): { length: number; present: boolean } {
  return { present: value !== undefined, length: value?.length ?? 0 };
}

/**
 * Input validation for uploaded images.
 *
 * Everything here runs before a single byte reaches the decoder. The threats
 * being closed off are: content-type spoofing (a `.jpg` that is really an
 * archive or SVG), oversized uploads, and decompression bombs. A 2 KB PNG can
 * expand to gigabytes of pixels and take the process down.
 */

import { fileTypeFromBuffer } from 'file-type';

/** Raster formats we are willing to decode. SVG and PDF are deliberately absent:
 *  both are active content and neither is a camera output. */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
]);

export class ImageRejected extends Error {
  override name = 'ImageRejected';
  constructor(
    message: string,
    readonly code: 'too_large' | 'unknown_type' | 'unsupported_type' | 'empty',
  ) {
    super(message);
  }
}

export interface VerifiedImage {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Verifies an in-memory upload.
 *
 * The MIME type is derived from magic bytes, not from the filename or the
 * `Content-Type` Slack reports, since both are attacker controlled.
 *
 * Pixel-count limits are enforced downstream in the OCR sidecar, which is the
 * component that actually decodes the image and therefore the only one that
 * can check dimensions before allocating.
 */
export async function verifyImage(bytes: Buffer, maxBytes: number): Promise<VerifiedImage> {
  if (bytes.length === 0) {
    throw new ImageRejected('Empty file', 'empty');
  }
  if (bytes.length > maxBytes) {
    throw new ImageRejected(
      `File is ${bytes.length} bytes, limit is ${maxBytes}`,
      'too_large',
    );
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (!detected) {
    throw new ImageRejected('Could not determine file type from content', 'unknown_type');
  }
  if (!ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new ImageRejected(`Unsupported file type: ${detected.mime}`, 'unsupported_type');
  }

  return { bytes, mimeType: detected.mime };
}

/**
 * Best-effort scrub of the buffer once processing is done.
 *
 * Node gives no guarantee the memory is not copied by the GC beforehand, so
 * this is defence in depth rather than a hard erasure guarantee. The real
 * control is that the buffer is never persisted anywhere.
 */
export function scrub(bytes: Buffer): void {
  bytes.fill(0);
}

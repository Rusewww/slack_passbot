/**
 * Client for the Python OCR sidecar.
 *
 * The sidecar listens on loopback inside the same container. It is not
 * reachable from outside the network namespace, so the interface carries no
 * authentication — the boundary is the container, not the HTTP layer.
 *
 * The sidecar returns every preprocessing variant it tried. Choosing between
 * them is this side's job, because only this side knows about check digits.
 */

export interface SidecarCandidate {
  /** Which preprocessing produced this reading, e.g. `located:clahe-otsu`. */
  variant: string;
  text: string;
  /** Lines already normalised to the MRZ alphabet, but not length-checked. */
  lines: string[];
}

export interface SidecarResult {
  candidates: SidecarCandidate[];
  durationMs: number;
}

export class SidecarUnavailable extends Error {
  override name = 'SidecarUnavailable';
}

export class SidecarRejected extends Error {
  override name = 'SidecarRejected';
  constructor(
    message: string,
    readonly code: 'too_large' | 'undecodable',
  ) {
    super(message);
  }
}

export interface SidecarOptions {
  baseUrl: string;
  timeoutMs: number;
  maxPixels: number;
}

export async function recognise(
  bytes: Buffer,
  mimeType: string,
  { baseUrl, timeoutMs, maxPixels }: SidecarOptions,
): Promise<SidecarResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL('/v1/recognise', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': mimeType,
        'x-max-pixels': String(maxPixels),
      },
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });

    if (response.status === 413) {
      throw new SidecarRejected('Image exceeds the decoder pixel budget', 'too_large');
    }
    if (response.status === 415) {
      throw new SidecarRejected('Image could not be decoded', 'undecodable');
    }
    if (!response.ok) {
      throw new SidecarUnavailable(`Sidecar returned HTTP ${response.status}`);
    }

    return (await response.json()) as SidecarResult;
  } catch (error) {
    if (error instanceof SidecarRejected || error instanceof SidecarUnavailable) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new SidecarUnavailable(`Sidecar timed out after ${timeoutMs}ms`);
    }
    throw new SidecarUnavailable(
      `Could not reach OCR sidecar: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function healthy(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/health', baseUrl), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

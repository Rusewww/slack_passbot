/**
 * Retrieval of a Slack-hosted file into memory.
 *
 * Two rules govern this module:
 *   1. Only URLs on Slack's own file host are fetched. The URL arrives inside
 *      an event payload, so treating it as trusted would let anyone who can
 *      post in the workspace turn the bot into an SSRF probe.
 *   2. The bytes never touch disk. There is no temp file to leak, to back up,
 *      or to forget to delete.
 */

import { ImageRejected } from '../security/imageGuards.js';

const ALLOWED_FILE_HOSTS = new Set(['files.slack.com']);

export class UntrustedFileUrl extends Error {
  override name = 'UntrustedFileUrl';
}

export function assertSlackFileUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UntrustedFileUrl('File URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new UntrustedFileUrl(`Refusing non-HTTPS file URL (${url.protocol})`);
  }
  if (!ALLOWED_FILE_HOSTS.has(url.hostname)) {
    throw new UntrustedFileUrl(`Refusing file URL on unexpected host: ${url.hostname}`);
  }
  return url;
}

export interface DownloadOptions {
  botToken: string;
  maxBytes: number;
  timeoutMs?: number;
}

/**
 * Downloads a private Slack file, aborting as soon as the size limit is
 * exceeded rather than buffering the whole body first.
 */
export async function downloadSlackFile(
  urlPrivateDownload: string,
  { botToken, maxBytes, timeoutMs = 15_000 }: DownloadOptions,
): Promise<Buffer> {
  const url = assertSlackFileUrl(urlPrivateDownload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller.signal,
      redirect: 'error', // a redirect off files.slack.com would defeat the host check
    });

    if (!response.ok) {
      throw new Error(`Slack file download failed with HTTP ${response.status}`);
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new ImageRejected(`File is ${declared} bytes, limit is ${maxBytes}`, 'too_large');
    }
    if (!response.body) {
      throw new Error('Slack file download returned no body');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await response.body.cancel();
        throw new ImageRejected(`File exceeds ${maxBytes} bytes`, 'too_large');
      }
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

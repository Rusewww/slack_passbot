/**
 * Vision-model fallback for images the deterministic pipeline cannot read.
 *
 * This is the only path on which document data leaves the deployment, so it is
 * off unless explicitly enabled (see `AI_FALLBACK_ENABLED`). Its output is not
 * trusted: the returned lines go through exactly the same check-digit
 * validation as Tesseract output, so a hallucinated passport number is
 * rejected rather than delivered.
 */

import Anthropic from '@anthropic-ai/sdk';

import { extractTd3Lines } from '../mrz/td3.js';

const SYSTEM_PROMPT = [
  'You transcribe the machine readable zone (MRZ) of travel documents.',
  'Return ONLY the MRZ lines, one per output line, verbatim.',
  'Preserve every filler character `<`. Do not pad, trim, translate or explain.',
  'A TD3 passport MRZ is exactly two lines of 44 characters.',
  'If no MRZ is visible, return the single word NONE.',
].join(' ');

/** Slack accepts more image formats than the Anthropic API does. */
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface FallbackOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class FallbackUnsupported extends Error {
  override name = 'FallbackUnsupported';
}

export async function recogniseWithVision(
  bytes: Buffer,
  mimeType: string,
  { apiKey, model, timeoutMs = 30_000 }: FallbackOptions,
): Promise<[string, string] | null> {
  if (!SUPPORTED_MEDIA_TYPES.has(mimeType)) {
    throw new FallbackUnsupported(`Vision fallback does not accept ${mimeType}`);
  }

  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  const message = await client.messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
              data: bytes.toString('base64'),
            },
          },
          { type: 'text', text: 'Transcribe the MRZ.' },
        ],
      },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  if (text.trim() === 'NONE') return null;
  return extractTd3Lines(text);
}

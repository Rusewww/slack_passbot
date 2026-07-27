/**
 * Intake handler: a user shares an image with the bot.
 *
 * The default intake mode is DM-only. That is the single most effective
 * control in this system — it makes it structurally impossible for decoded
 * passport data to land in a shared channel, because the bot never reads from
 * one and never writes to one.
 */

import type { Logger } from 'pino';
import type { WebClient } from '@slack/web-api';

import type { Config } from '../../config.js';
import { extractMrz } from '../../pipeline/extract.js';
import { ImageRejected, scrub, verifyImage } from '../../security/imageGuards.js';
import type { RateLimiter } from '../../security/rateLimit.js';
import { downloadSlackFile, UntrustedFileUrl } from '../download.js';
import { failureBlocks, rateLimitedBlocks, successBlocks } from '../reply.js';

/** The subset of a Slack file object this handler relies on. */
export interface SlackFile {
  id: string;
  mimetype?: string;
  url_private_download?: string;
  size?: number;
}

export interface IntakeContext {
  client: WebClient;
  config: Config;
  logger: Logger;
  rateLimiter: RateLimiter;
  /** Bounded queue so concurrent uploads cannot exhaust memory or CPU. */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface IntakeEvent {
  userId: string;
  channelId: string;
  channelType: string;
  files: SlackFile[];
}

/** Whether the bot is willing to read from where this arrived. */
export function isAllowedLocation(event: IntakeEvent, config: Config): boolean {
  if (event.channelType === 'im') return true;
  if (config.INTAKE_MODE === 'allowlist') {
    return config.ALLOWED_CHANNEL_IDS.includes(event.channelId);
  }
  return false;
}

export async function handleImageUpload(
  event: IntakeEvent,
  ctx: IntakeContext,
): Promise<void> {
  const { config, rateLimiter } = ctx;
  const log = ctx.logger.child({ userId: event.userId, channelType: event.channelType });

  if (!isAllowedLocation(event, config)) {
    log.info('ignoring upload from a non-permitted location');
    return;
  }

  if (!rateLimiter.tryConsume(event.userId)) {
    log.warn('user rate limited');
    await postPrivate(ctx, event, rateLimitedBlocks(), 'Rate limited');
    return;
  }

  for (const file of event.files) {
    await processOne(file, event, ctx, log);
  }
}

async function processOne(
  file: SlackFile,
  event: IntakeEvent,
  ctx: IntakeContext,
  log: Logger,
): Promise<void> {
  const { config } = ctx;
  const fileLog = log.child({ fileId: file.id });

  if (!file.url_private_download) {
    fileLog.info('file has no downloadable URL, skipping');
    return;
  }

  let bytes: Buffer | undefined;
  try {
    await ctx.enqueue(async () => {
      bytes = await downloadSlackFile(file.url_private_download as string, {
        botToken: config.SLACK_BOT_TOKEN,
        maxBytes: config.MAX_IMAGE_BYTES,
      });

      const verified = await verifyImage(bytes, config.MAX_IMAGE_BYTES);

      const started = Date.now();
      const result = await extractMrz(
        { bytes: verified.bytes, mimeType: verified.mimeType, fileId: file.id },
        {
          logger: fileLog,
          sidecar: {
            baseUrl: config.OCR_SIDECAR_URL,
            timeoutMs: config.OCR_TIMEOUT_MS,
            maxPixels: config.MAX_IMAGE_PIXELS,
          },
          fallback: {
            enabled: config.AI_FALLBACK_ENABLED,
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.ANTHROPIC_MODEL,
          },
        },
      );

      // Outcome only. The decoded values are never logged.
      fileLog.info(
        {
          ok: result.ok,
          durationMs: Date.now() - started,
          ...(result.ok ? { source: result.source, edits: result.edits } : { reason: result.reason }),
        },
        'extraction finished',
      );

      await postPrivate(
        ctx,
        event,
        result.ok ? successBlocks(result) : failureBlocks(result.reason),
        result.ok ? 'MRZ decoded' : 'Could not decode MRZ',
      );
    });
  } catch (error) {
    await reportError(error, ctx, event, fileLog);
  } finally {
    if (bytes) scrub(bytes);
  }
}

async function reportError(
  error: unknown,
  ctx: IntakeContext,
  event: IntakeEvent,
  log: Logger,
): Promise<void> {
  if (error instanceof ImageRejected) {
    log.info({ code: error.code }, 'upload rejected');
    await postPrivate(
      ctx,
      event,
      failureBlocks(error.code === 'too_large' ? 'too_large' : 'unsupported_format'),
      'Upload rejected',
    );
    return;
  }

  if (error instanceof UntrustedFileUrl) {
    // Worth alerting on: a well-formed Slack event should never produce this.
    log.error({ err: error.message }, 'refused untrusted file URL');
    return;
  }

  log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    'unhandled failure while processing upload',
  );
  await postPrivate(ctx, event, failureBlocks('unreadable'), 'Processing failed');
}

/**
 * Replies privately. In a DM that is an ordinary message; in an allow-listed
 * channel it is ephemeral, visible only to the uploader.
 */
async function postPrivate(
  ctx: IntakeContext,
  event: IntakeEvent,
  blocks: ReturnType<typeof successBlocks>,
  fallbackText: string,
): Promise<void> {
  if (event.channelType === 'im') {
    await ctx.client.chat.postMessage({
      channel: event.channelId,
      blocks,
      text: fallbackText,
    });
    return;
  }

  await ctx.client.chat.postEphemeral({
    channel: event.channelId,
    user: event.userId,
    blocks,
    text: fallbackText,
  });
}

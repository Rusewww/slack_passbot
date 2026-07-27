/**
 * Bolt application, wired for Socket Mode.
 *
 * Socket Mode is a security decision as much as a convenience one: the service
 * opens an outbound WebSocket to Slack and exposes no inbound port at all.
 * There is no public URL to discover, no request-signature verification to get
 * wrong, and nothing for an untargeted scanner to find.
 */

import { App, LogLevel } from '@slack/bolt';
import PQueue from 'p-queue';
import type { Logger } from 'pino';

import type { Config } from '../config.js';
import { RateLimiter } from '../security/rateLimit.js';
import { handleImageUpload, type IntakeEvent, type SlackFile } from './handlers/imageUpload.js';
import { HELP_TEXT } from './reply.js';

/** Shape of the `message` events we care about, after narrowing. */
interface MessageEventLike {
  user?: string;
  channel?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
  text?: string;
}

const IMAGE_MIME_PREFIX = 'image/';

export function createApp(config: Config, logger: Logger): App {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  const rateLimiter = new RateLimiter(config.RATE_LIMIT_PER_USER_PER_MINUTE);
  const sweep = setInterval(() => rateLimiter.sweep(), 60_000);
  sweep.unref();

  const queue = new PQueue({ concurrency: config.MAX_CONCURRENT_JOBS });
  const enqueue = <T>(task: () => Promise<T>): Promise<T> =>
    queue.add(task, { throwOnTimeout: true }) as Promise<T>;

  app.event('message', async ({ event, client }) => {
    const message = event as MessageEventLike;

    // Ignore anything the bot itself or another integration produced.
    if (message.bot_id || message.subtype === 'bot_message') return;
    if (!message.user || !message.channel) return;

    const files = (message.files ?? []).filter((file) =>
      (file.mimetype ?? '').startsWith(IMAGE_MIME_PREFIX),
    );

    if (files.length === 0) {
      // A plain DM with no image: answer with usage guidance.
      if (message.channel_type === 'im' && message.text) {
        await client.chat.postMessage({ channel: message.channel, text: HELP_TEXT });
      }
      return;
    }

    const intake: IntakeEvent = {
      userId: message.user,
      channelId: message.channel,
      channelType: message.channel_type ?? 'unknown',
      files,
    };

    await handleImageUpload(intake, { client, config, logger, rateLimiter, enqueue });
  });

  app.error(async (error) => {
    logger.error({ err: error.message }, 'unhandled Bolt error');
  });

  return app;
}

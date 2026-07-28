/**
 * Entrypoint. Boots the Slack connection after confirming the OCR sidecar is
 * up, so the bot is never online-but-broken from a user's point of view.
 */

import { buildInfo } from './buildInfo.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { healthy } from './ocr/sidecar.js';
import { createApp } from './slack/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV);

  // First line in the log, deliberately: when behaviour does not match the
  // source, this is the fact that settles it.
  logger.info(buildInfo(), 'build');

  if (!(await healthy(config.OCR_SIDECAR_URL))) {
    logger.warn(
      { sidecar: config.OCR_SIDECAR_URL },
      'OCR sidecar is not responding yet — starting anyway, uploads will fail until it is up',
    );
  }

  const app = createApp(config, logger);
  await app.start();

  logger.info(
    {
      intakeMode: config.INTAKE_MODE,
      aiFallback: config.AI_FALLBACK_ENABLED,
      concurrency: config.MAX_CONCURRENT_JOBS,
    },
    'passbot connected to Slack',
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void app.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration and startup failures must be visible, but the message is
  // built from field names only — never from secret values.
  process.stderr.write(
    `passbot failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});

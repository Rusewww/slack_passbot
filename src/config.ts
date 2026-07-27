/**
 * Environment configuration. Validated once at boot so a misconfigured deploy
 * fails immediately and loudly rather than at the moment someone uploads a
 * passport.
 */

import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'Expected a bot token (xoxb-…)'),
    SLACK_APP_TOKEN: z.string().startsWith('xapp-', 'Expected an app-level token (xapp-…)'),

    OCR_SIDECAR_URL: z.url().default('http://127.0.0.1:8000'),
    OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

    AI_FALLBACK_ENABLED: booleanish.default(false),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    INTAKE_MODE: z.enum(['dm_only', 'allowlist']).default('dm_only'),
    ALLOWED_CHANNEL_IDS: csv,

    MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
    RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().positive().default(10),
    MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  })
  .refine((env) => !env.AI_FALLBACK_ENABLED || Boolean(env.ANTHROPIC_API_KEY), {
    message: 'AI_FALLBACK_ENABLED=true requires ANTHROPIC_API_KEY',
    path: ['ANTHROPIC_API_KEY'],
  })
  .refine((env) => env.INTAKE_MODE !== 'allowlist' || env.ALLOWED_CHANNEL_IDS.length > 0, {
    message: 'INTAKE_MODE=allowlist requires at least one channel in ALLOWED_CHANNEL_IDS',
    path: ['ALLOWED_CHANNEL_IDS'],
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    // Print field names and messages only — never the offending values, which
    // are secrets.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

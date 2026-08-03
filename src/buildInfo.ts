/**
 * Identifies the build that is actually running.
 *
 * Fixes were once made, committed and tested against over several rounds
 * while the process actually running was a stale `dist/` from an earlier
 * build. Every report came back "unchanged", and the obvious conclusion,
 * that the fixes did not work, was wrong. The bot could not say which code
 * it was, so nobody could tell.
 *
 * The commit is reported at startup and alongside every decoded result, so a
 * stale binary announces itself instead of quietly misleading the next
 * investigation.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Short commit hash, or `unknown` when it cannot be determined. */
  commit: string;
  /** When the running module was written to disk, i.e. the build time. */
  builtAt: string;
  /** `dist` when running compiled output, `src` under tsx. */
  running: 'dist' | 'src';
}

/**
 * Reads the checked-out commit without shelling out to git, which is not
 * present in the runtime image. Falls back to `BUILD_COMMIT`, which the
 * Dockerfile bakes in at image build time.
 */
function gitHead(): string | null {
  try {
    const head = readFileSync('.git/HEAD', 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    return readFileSync(`.git/${head.slice(5)}`, 'utf8').trim();
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;

  const path = fileURLToPath(import.meta.url);
  const commit = process.env.BUILD_COMMIT ?? gitHead() ?? 'unknown';

  let builtAt = 'unknown';
  try {
    builtAt = statSync(path).mtime.toISOString();
  } catch {
    // Leave it unknown; this must never be a reason not to start.
  }

  cached = {
    commit: commit === 'unknown' ? commit : commit.slice(0, 12),
    builtAt,
    running: path.includes('dist') ? 'dist' : 'src',
  };
  return cached;
}

/** Compact form for a message footer, e.g. `f7a3335ab1cd (dist)`. */
export function buildLabel(): string {
  const info = buildInfo();
  return `${info.commit} (${info.running})`;
}

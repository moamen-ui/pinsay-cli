import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readStamp } from './skill-stamp.js';
import { skillFilesFor } from './skill-paths.js';
import { compareSemver } from '../checks.js';
import { BUILD_CLI_VERSION } from '../build-constants.js';
import { yellow } from '../ui/style.js';
import type { MetaResponse } from '../checks.js';
import type { PinSayConfig } from '../config.js';

export type NotifyUpdateOptions = {
  meta?: MetaResponse | null;
  config?: PinSayConfig | null;
  cwd?: string;
  silent?: boolean;
};

export type UpdateNotificationResult = {
  cliUpdateAvailable: boolean;
  skillsUpdateAvailable: boolean;
};

/**
 * Checks if the CLI version or the local repository's skills are behind the server,
 * and prints a non-blocking notification to stderr so piped stdout/JSON output is never corrupted.
 */
export async function checkAndNotifyUpdates(
  options: NotifyUpdateOptions,
): Promise<UpdateNotificationResult> {
  const result: UpdateNotificationResult = {
    cliUpdateAvailable: false,
    skillsUpdateAvailable: false,
  };

  if (options.silent || !options.meta) return result;
  const meta = options.meta;

  // 1. Check CLI version update
  if (meta.latestCliVersion && compareSemver(BUILD_CLI_VERSION, meta.latestCliVersion) < 0) {
    result.cliUpdateAvailable = true;
    console.error(
      `${yellow(`💡 Update available for pinsay-cli: ${BUILD_CLI_VERSION} → ${meta.latestCliVersion}`)}\n` +
      `${yellow("   Run 'npx -y pinsay@latest' to update.")}\n`,
    );
  }

  // 2. Check local skills update
  if (meta.skillVersion && options.config && options.cwd) {
    try {
      const files = skillFilesFor(options.config);
      let hasStale = false;
      for (const rel of files) {
        const abs = join(options.cwd, rel);
        try {
          await fs.access(abs);
          const installed = await readStamp(abs);
          if (installed && installed !== meta.skillVersion) {
            hasStale = true;
            break;
          }
        } catch {
          // File does not exist or unreadable
        }
      }

      if (hasStale) {
        result.skillsUpdateAvailable = true;
        console.error(
          `${yellow('💡 Local AI skills are out of date with the server.')}\n` +
          `${yellow("   Run 'npx pinsay-cli update' to refresh your prompt skills.")}\n`,
        );
      }
    } catch {
      // Best-effort check; never fail the caller
    }
  }

  return result;
}

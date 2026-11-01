import { ArgumentError } from '@jackwener/opencli/errors';

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 600;

export const SUPPORTED_QUALITIES = ['best', '1080p', '720p', '540p', '480p', '360p'];

export const DOWNLOAD_COLUMNS = [
  'status',
  'id',
  'title',
  'author',
  'quality',
  'codec',
  'path',
  'bytes',
  'source',
];

export const STRATEGY_NOTE =
  'PAGE_FETCH, internal-unstable. Non-public API fetched in read-only page context; downloaded via streaming Node HTTP to CLI execution host.';

/**
 * Normalize and validate CLI kwargs for `douyin-ext download`.
 */
export function normalizeDownloadArgs(kwargs = {}) {
  const target = String(kwargs.target ?? '').trim();
  if (!target) {
    throw new ArgumentError('Missing required <target> argument (Douyin video ID, official URL, or v.douyin.com short share link)');
  }

  const rawQuality = String(kwargs.quality ?? 'best').trim().toLowerCase();
  if (!rawQuality) {
    throw new ArgumentError('Quality cannot be empty');
  }
  // Allow 'best' or any standard resolution pattern like 1080p, 720p, etc.
  if (rawQuality !== 'best' && !/^\d+p$/i.test(rawQuality) && !SUPPORTED_QUALITIES.includes(rawQuality)) {
    throw new ArgumentError(`Invalid quality "${rawQuality}". Supported choices: ${SUPPORTED_QUALITIES.join(', ')}`);
  }

  const rawTimeout = kwargs.timeout != null ? Number(kwargs.timeout) : DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(rawTimeout) || rawTimeout < MIN_TIMEOUT_SECONDS || rawTimeout > MAX_TIMEOUT_SECONDS) {
    throw new ArgumentError(
      `Timeout must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds (received ${kwargs.timeout})`
    );
  }
  const timeoutSeconds = Math.floor(rawTimeout);

  const output = String(kwargs.output ?? '.').trim() || '.';

  return {
    target,
    quality: rawQuality,
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1000,
    output,
  };
}

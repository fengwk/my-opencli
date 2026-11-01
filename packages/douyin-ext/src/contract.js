import { ArgumentError } from '@jackwener/opencli/errors';

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 600;

export const SUPPORTED_QUALITIES = [
  'best',
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '540p',
  '480p',
  '360p',
];

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

const NUMERIC_ID_RE = /^\d{16,20}$/;
const SHORT_CODE_PATH_RE = /^\/[a-zA-Z0-9_-]+\/?$/;
const VIDEO_PATH_RE = /^\/(?:share\/)?video\/(\d{16,20})\/?$/;
const TRUSTED_DOMAINS = new Set([
  'douyin.com',
  'www.douyin.com',
  'v.douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
]);

/**
 * Perform offline, static structural validation of target format without network calls.
 * Rejects invalid protocols, ports, user credentials, malformed paths, or non-matching IDs.
 */
export function validateTargetFormat(target) {
  const text = String(target ?? '').trim();
  if (!text) {
    throw new ArgumentError('Missing required <target> argument');
  }

  // 1. Fully anchored numeric ID
  if (NUMERIC_ID_RE.test(text)) {
    return text;
  }

  // 2. Reject arbitrary numbers that exceed 20 digits or fall below 16 digits
  if (/^\d+$/.test(text)) {
    throw new ArgumentError(`Invalid video ID length: "${text}" (must be 16-20 digits)`);
  }

  // 3. Must be a valid HTTPS URL on trusted Douyin hosts
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ArgumentError(`Invalid target URL or video ID: "${text}"`);
  }

  if (url.protocol !== 'https:') {
    throw new ArgumentError(`Only HTTPS Douyin URLs are supported: "${url.protocol}"`);
  }
  if (url.port) {
    throw new ArgumentError(`Custom ports are not allowed: "${url.port}"`);
  }
  if (url.username || url.password) {
    throw new ArgumentError('User credentials in URLs are not allowed');
  }
  if (!TRUSTED_DOMAINS.has(url.hostname)) {
    throw new ArgumentError(`Untrusted Douyin domain "${url.hostname}"`);
  }

  if (url.hostname === 'v.douyin.com') {
    if (!SHORT_CODE_PATH_RE.test(url.pathname)) {
      throw new ArgumentError(`Invalid v.douyin.com short link format: "${url.pathname}"`);
    }
    return text;
  }

  // Path or modal_id extraction with full anchoring
  const pathMatch = url.pathname.match(VIDEO_PATH_RE);
  if (pathMatch && pathMatch[1]) {
    return text;
  }

  const modalId = url.searchParams.get('modal_id');
  if (modalId && NUMERIC_ID_RE.test(modalId)) {
    return text;
  }

  throw new ArgumentError(`No valid video ID found in URL: "${text}"`);
}

/**
 * Normalize and strictly validate CLI kwargs for `douyin-ext download`.
 */
export function normalizeDownloadArgs(kwargs = {}) {
  const rawTarget = String(kwargs.target ?? '').trim();
  validateTargetFormat(rawTarget);

  const rawQuality = String(kwargs.quality ?? 'best').trim().toLowerCase();
  if (!rawQuality) {
    throw new ArgumentError('Quality cannot be empty');
  }
  if (rawQuality !== 'best' && !/^\d+p$/i.test(rawQuality) && !SUPPORTED_QUALITIES.includes(rawQuality)) {
    throw new ArgumentError(
      `Invalid quality "${rawQuality}". Supported choices: ${SUPPORTED_QUALITIES.join(', ')}`
    );
  }

  const rawTimeout = kwargs.timeout != null ? Number(kwargs.timeout) : DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(rawTimeout) || rawTimeout < MIN_TIMEOUT_SECONDS || rawTimeout > MAX_TIMEOUT_SECONDS) {
    throw new ArgumentError(
      `Timeout must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds (received ${kwargs.timeout})`
    );
  }

  const output = String(kwargs.output ?? '.').trim() || '.';

  return {
    target: rawTarget,
    quality: rawQuality,
    timeoutSeconds: rawTimeout,
    timeoutMs: rawTimeout * 1000,
    output,
  };
}

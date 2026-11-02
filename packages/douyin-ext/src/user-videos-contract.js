import { ArgumentError } from '@jackwener/opencli/errors';

export const DEFAULT_USER_VIDEOS_COUNT = 20;
export const MIN_USER_VIDEOS_COUNT = 1;
export const MAX_USER_VIDEOS_COUNT = 20;

export const DEFAULT_COMMENT_LIMIT = 0;
export const MIN_COMMENT_LIMIT = 0;
export const MAX_COMMENT_LIMIT = 10;

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 600;

export const USER_VIDEOS_COLUMNS = [
  'sec_uid',
  'cursor',
  'next_cursor',
  'has_more',
  'items',
];

export const SEC_UID_PATTERN = /^MS4wLjABAAAA[A-Za-z0-9_-]{8,}$/;
const TRUSTED_USER_HOSTS = new Set(['douyin.com', 'www.douyin.com']);
const USER_PATH_PATTERN = /^\/user\/([A-Za-z0-9_-]+)\/?$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;

/**
 * Perform offline, static structural validation of target format.
 * Accepts only:
 *   1. Direct sec_uid matching ^MS4wLjABAAAA[A-Za-z0-9_-]{8,}$
 *   2. Official HTTPS Douyin user URL on douyin.com or www.douyin.com (/user/<sec_uid>)
 * Rejects non-HTTPS, custom ports, user credentials, or other hosts.
 */
export function validateUserVideosTarget(target) {
  const text = String(target ?? '').trim();
  if (!text) {
    throw new ArgumentError('Missing required <target> argument');
  }

  // 1. Direct sec_uid match
  if (SEC_UID_PATTERN.test(text)) {
    return text;
  }

  // 2. URL parsing & structural validation
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ArgumentError(
      `Invalid target: "${text}". Expected a Douyin user URL (https://www.douyin.com/user/<sec_uid>) or direct sec_uid.`
    );
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
  if (!TRUSTED_USER_HOSTS.has(url.hostname)) {
    throw new ArgumentError(`Untrusted Douyin domain "${url.hostname}"`);
  }

  const match = url.pathname.match(USER_PATH_PATTERN);
  if (!match || !match[1]) {
    throw new ArgumentError(
      `URL path must point to a Douyin user page (/user/<sec_uid>): "${url.pathname}"`
    );
  }

  const candidate = match[1];
  if (!SEC_UID_PATTERN.test(candidate)) {
    throw new ArgumentError(
      `Invalid sec_uid format in user URL: "${candidate}". Must start with MS4wLjABAAAA.`
    );
  }

  return candidate;
}

/**
 * Validate and normalize cursor.
 * The cursor is an exact digits-string, not a numeric page number.
 * It is never rounded, truncated, or cast to floating point.
 */
export function validateCursor(cursor) {
  if (cursor == null) {
    return '0';
  }
  const text = String(cursor).trim();
  if (!DIGITS_ONLY_PATTERN.test(text)) {
    throw new ArgumentError(
      `Invalid cursor: "${text}". Cursor must be a non-empty string of digits (default "0").`
    );
  }
  return text;
}

/**
 * Normalize and strictly validate CLI kwargs for `douyin-ext user-videos`.
 */
export function normalizeUserVideosArgs(kwargs = {}) {
  const rawTarget = String(kwargs.target ?? '').trim();
  const secUid = validateUserVideosTarget(rawTarget);

  const rawCursor = kwargs.cursor != null ? kwargs.cursor : '0';
  const cursor = validateCursor(rawCursor);

  const rawCount = kwargs.count != null ? Number(kwargs.count) : DEFAULT_USER_VIDEOS_COUNT;
  if (
    !Number.isInteger(rawCount) ||
    rawCount < MIN_USER_VIDEOS_COUNT ||
    rawCount > MAX_USER_VIDEOS_COUNT
  ) {
    throw new ArgumentError(
      `Count must be an integer between ${MIN_USER_VIDEOS_COUNT} and ${MAX_USER_VIDEOS_COUNT} (received ${kwargs.count})`
    );
  }

  const rawCommentLimit =
    kwargs['comment-limit'] != null
      ? kwargs['comment-limit']
      : kwargs.commentLimit != null
        ? kwargs.commentLimit
        : DEFAULT_COMMENT_LIMIT;
  const commentLimit = Number(rawCommentLimit);
  if (
    !Number.isInteger(commentLimit) ||
    commentLimit < MIN_COMMENT_LIMIT ||
    commentLimit > MAX_COMMENT_LIMIT
  ) {
    throw new ArgumentError(
      `Comment limit must be an integer between ${MIN_COMMENT_LIMIT} and ${MAX_COMMENT_LIMIT} (received ${rawCommentLimit})`
    );
  }

  const rawTimeout =
    kwargs.timeout != null ? Number(kwargs.timeout) : DEFAULT_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(rawTimeout) ||
    rawTimeout < MIN_TIMEOUT_SECONDS ||
    rawTimeout > MAX_TIMEOUT_SECONDS
  ) {
    throw new ArgumentError(
      `Timeout must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds (received ${kwargs.timeout})`
    );
  }

  return {
    secUid,
    cursor,
    count: rawCount,
    commentLimit,
    timeoutSeconds: rawTimeout,
    timeoutMs: rawTimeout * 1000,
  };
}

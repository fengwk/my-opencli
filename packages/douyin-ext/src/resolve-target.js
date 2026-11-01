import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

export const VIDEO_ID_RE = /^\d{16,20}$/;
const VIDEO_PATH_RE = /^\/(?:share\/)?video\/(\d{16,20})\/?$/;

export const TRUSTED_INPUT_HOSTS = new Set([
  'douyin.com',
  'www.douyin.com',
  'v.douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
]);

/**
 * Validate that a URL string is an official HTTPS Douyin URL without custom ports or user credentials.
 */
export function validateTrustedUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    throw new ArgumentError('Expected a valid Douyin video ID or URL');
  }

  if (url.protocol !== 'https:') {
    throw new ArgumentError(`Only HTTPS Douyin URLs are supported: "${url.protocol}"`);
  }
  if (url.port) {
    throw new ArgumentError(`URLs with custom ports are not allowed: "${url.port}"`);
  }
  if (url.username || url.password) {
    throw new ArgumentError('URLs with user credentials are not allowed');
  }
  if (!TRUSTED_INPUT_HOSTS.has(url.hostname)) {
    throw new ArgumentError(`Untrusted Douyin domain "${url.hostname}"`);
  }

  return url;
}

/**
 * Extract a video ID directly from a string or trusted URL with fully anchored matching.
 */
export function extractVideoId(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';

  if (VIDEO_ID_RE.test(text)) {
    return text;
  }
  if (/^\d+$/.test(text)) {
    return '';
  }

  let url;
  try {
    url = validateTrustedUrl(text);
  } catch {
    return '';
  }

  if (url.hostname === 'v.douyin.com') {
    return '';
  }

  const pathMatch = url.pathname.match(VIDEO_PATH_RE);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1];
  }

  const modalId = url.searchParams.get('modal_id');
  if (modalId && VIDEO_ID_RE.test(modalId)) {
    return modalId;
  }

  return '';
}

/**
 * Resolve target input to a verified video ID.
 * Follows short share links up to maxHops with per-hop security validation.
 */
export async function resolveTargetToId(
  input,
  { fetchFn = fetch, maxHops = 6, timeoutSignal } = {}
) {
  const text = String(input ?? '').trim();
  if (!text) {
    throw new ArgumentError('Expected a Douyin video ID, URL, or short share link');
  }

  if (VIDEO_ID_RE.test(text)) {
    return { id: text, sourceUrl: '' };
  }

  let directId = extractVideoId(text);
  if (directId) {
    return { id: directId, sourceUrl: text };
  }

  let currentUrl = validateTrustedUrl(text);
  if (currentUrl.hostname !== 'v.douyin.com') {
    throw new ArgumentError(`No valid video ID in Douyin URL`);
  }

  const visited = new Set();
  for (let hop = 0; hop < maxHops; hop++) {
    if (visited.has(currentUrl.href)) {
      throw new CommandExecutionError('Redirect loop detected in Douyin short link');
    }
    visited.add(currentUrl.href);

    let res;
    try {
      res = await fetchFn(currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: timeoutSignal ?? AbortSignal.timeout(10000),
      });
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      throw new CommandExecutionError(
        `Failed to resolve Douyin short link: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (![301, 302, 303, 307, 308].includes(res.status)) {
      throw new CommandExecutionError(`Douyin short link did not redirect (HTTP ${res.status})`);
    }

    const location = res.headers.get('location');
    if (!location) {
      throw new CommandExecutionError('Douyin short link redirect missing Location header');
    }

    currentUrl = validateTrustedUrl(location, currentUrl);

    const resolvedId = extractVideoId(currentUrl.href);
    if (resolvedId) {
      return { id: resolvedId, sourceUrl: currentUrl.href };
    }
  }

  throw new CommandExecutionError(`Douyin short link exceeded maximum redirects (${maxHops})`);
}

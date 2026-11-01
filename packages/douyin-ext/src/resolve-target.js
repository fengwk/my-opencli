import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

export const VIDEO_ID_RE = /^\d{16,20}$/;

export const TRUSTED_INPUT_HOSTS = new Set([
  'douyin.com',
  'www.douyin.com',
  'v.douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
]);

/**
 * Validate that a URL string is a safe, HTTPS, credential-free Douyin domain.
 * Throws ArgumentError on failure.
 */
export function validateTrustedUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    throw new ArgumentError(`Invalid Douyin URL or video ID: "${input}"`);
  }

  if (url.protocol !== 'https:') {
    throw new ArgumentError(`Only HTTPS Douyin URLs are supported (got "${url.protocol}")`);
  }

  if (url.port) {
    throw new ArgumentError(`URLs with custom ports are not allowed: "${url.port}"`);
  }

  if (url.username || url.password) {
    throw new ArgumentError('URLs with user credentials are not allowed');
  }

  if (!TRUSTED_INPUT_HOSTS.has(url.hostname)) {
    throw new ArgumentError(
      `Untrusted Douyin domain "${url.hostname}". Allowed domains: ${Array.from(TRUSTED_INPUT_HOSTS).join(', ')}`
    );
  }

  return url;
}

/**
 * Attempt to extract a video ID directly from a string or URL pathname/search.
 * Returns empty string if not found.
 */
export function extractVideoId(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';

  if (VIDEO_ID_RE.test(text)) {
    return text;
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

  // /video/<id> or /share/video/<id>
  const pathMatch = url.pathname.match(/\/(?:share\/)?video\/(\d{16,20})\/?/);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1];
  }

  // modal_id=<id> query parameter
  const modalId = url.searchParams.get('modal_id');
  if (modalId && VIDEO_ID_RE.test(modalId)) {
    return modalId;
  }

  return '';
}

/**
 * Resolve target input (numeric ID, full video URL, or v.douyin.com short link)
 * to a verified video ID.
 *
 * Performs safety checks on every redirect hop with an upper bound.
 * Throws ArgumentError for format / domain / security violations prior to navigation.
 */
export async function resolveTargetToId(input, { fetchFn = fetch, maxHops = 6 } = {}) {
  const text = String(input ?? '').trim();
  if (!text) {
    throw new ArgumentError('Expected a Douyin video ID, URL, or short share link');
  }

  // Case 1: Direct numeric ID
  if (VIDEO_ID_RE.test(text)) {
    return { id: text, sourceUrl: '' };
  }

  // Case 2: Direct official URL
  let directId = extractVideoId(text);
  if (directId) {
    return { id: directId, sourceUrl: text };
  }

  // Case 3: Must be a trusted Douyin URL (e.g. v.douyin.com short link)
  let currentUrl = validateTrustedUrl(text);
  if (currentUrl.hostname !== 'v.douyin.com') {
    throw new ArgumentError(`No video ID found in Douyin URL: "${text}"`);
  }

  // Follow short share link redirects safely
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
        signal: AbortSignal.timeout(10000),
      });
      await res.body?.cancel();
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

    // Every redirect hop is strictly validated against the trusted domains/protocol
    currentUrl = validateTrustedUrl(location, currentUrl);

    const resolvedId = extractVideoId(currentUrl.href);
    if (resolvedId) {
      return { id: resolvedId, sourceUrl: currentUrl.href };
    }
  }

  throw new CommandExecutionError(`Douyin short link exceeded maximum of ${maxHops} redirect hops without resolving to a video ID`);
}

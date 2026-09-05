export const GEMINI_DOMAIN = 'gemini.google.com';
export const GEMINI_APP_URL = 'https://gemini.google.com/app';

const APP_ID_RE = /^[A-Za-z0-9_-]{8,}$/;
const PROTOCOL_CID_RE = /^c_[A-Za-z0-9_-]{8,}$/;

/**
 * Accept conversation URL, `/app/<id>`, bare URL id, or protocol `c_<id>`.
 * Returns the URL id used by gemini.google.com/app/<id>.
 */
export function parseGeminiSessionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (PROTOCOL_CID_RE.test(raw)) return raw.slice(2);

  try {
    const url = new URL(raw, GEMINI_APP_URL);
    const host = url.hostname;
    if (host === GEMINI_DOMAIN || host.endsWith(`.${GEMINI_DOMAIN}`)) {
      const m = url.pathname.match(/^\/app\/([A-Za-z0-9_-]+)/);
      if (m && APP_ID_RE.test(m[1])) return m[1];
      if (url.pathname.replace(/\/+$/, '') === '/app') return '';
    }
  } catch {
    // not a URL
  }

  const stripped = raw.replace(/^\/app\//, '').replace(/\/.*$/, '');
  if (PROTOCOL_CID_RE.test(stripped)) return stripped.slice(2);
  if (APP_ID_RE.test(stripped)) return stripped;
  return '';
}

export function protocolConversationIdToSession(value) {
  const raw = String(value || '').trim();
  if (PROTOCOL_CID_RE.test(raw)) return raw.slice(2);
  if (APP_ID_RE.test(raw)) return raw;
  return '';
}

export function sessionToProtocolConversationId(sessionId) {
  const id = parseGeminiSessionId(sessionId);
  return id ? `c_${id}` : '';
}

export function geminiConversationUrl(sessionId) {
  const id = parseGeminiSessionId(sessionId);
  return id ? `${GEMINI_APP_URL}/${id}` : GEMINI_APP_URL;
}

export function parseGeminiUrlSessionId(url) {
  return parseGeminiSessionId(url);
}

export function isGeminiAppUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname;
    if (host !== GEMINI_DOMAIN && !host.endsWith(`.${GEMINI_DOMAIN}`)) return false;
    return parsed.pathname === '/app' || parsed.pathname.startsWith('/app/') || parsed.pathname === '/';
  } catch {
    return false;
  }
}

export function isGoogleAccountsUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname;
    return host === 'accounts.google.com' || host.endsWith('.accounts.google.com');
  } catch {
    return /accounts\.google\.com/i.test(String(url || ''));
  }
}

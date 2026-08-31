import { ArgumentError } from '@jackwener/opencli/errors';
import { SCRAPE_FORMATS } from './pipeline.js';

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 180;

export function normalizeScrapeArgs(kwargs = {}) {
  const url = String(kwargs.url ?? '').trim();
  if (!isSupportedHttpUrl(url)) {
    throw new ArgumentError(
      'url must be a fully-qualified http/https URL',
      'Example: opencli utils scrape https://example.com --as markdown',
    );
  }

  const as = String(kwargs.as ?? 'markdown').trim().toLowerCase();
  if (!SCRAPE_FORMATS.includes(as)) {
    throw new ArgumentError(
      `unsupported --as: ${kwargs.as}`,
      `Allowed: ${SCRAPE_FORMATS.join(', ')}`,
    );
  }

  const timeoutSeconds = normalizeTimeoutSeconds(kwargs.timeout);
  return {
    url,
    as,
    onlyMainContent: boolish(kwargs['only-main-content'] ?? kwargs.onlyMainContent),
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1000,
    waitForMs: normalizeWaitForMs(kwargs['wait-for'] ?? kwargs.waitFor),
  };
}

export function isSupportedHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(String(value).trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
  } catch {
    return false;
  }
}

function normalizeWaitForMs(raw) {
  if (raw == null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ArgumentError(
      'wait-for must be a non-negative integer in milliseconds',
      'Example: opencli utils scrape https://example.com --wait-for 2000',
    );
  }
  return parsed;
}

function normalizeTimeoutSeconds(raw) {
  const parsed = Number(raw ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_SECONDS) {
    throw new ArgumentError(
      `timeout must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`,
      `Example: opencli utils scrape https://example.com --timeout ${DEFAULT_TIMEOUT_SECONDS}`,
    );
  }
  return parsed;
}

export function boolish(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  throw new ArgumentError(
    `only-main-content must be a boolean. Received: "${String(value)}"`,
    'Use --only-main-content true or --only-main-content false',
  );
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { isSupportedHttpUrl } from './contract.js';
import {
  COLLECT_DOCUMENT_JS,
  TEXT_LENGTH_JS,
  mergeFrameDocuments,
} from './frame-collect.js';
import {
  guessExtension,
  hasMediaLikeFileExtension,
  isDirectMediaResponse,
  isHtmlDocumentBytes,
  resolveSuggestedFileName,
} from './media-utils.js';
import {
  INLINE_TEXT_MAX_CHARS,
  buildLinksResult,
  buildTextResult,
  buildTruncatedNotice,
  formatScrapeText,
} from './pipeline.js';

const STABILITY_CHECK_INTERVAL_MS = 500;
const STABILITY_THRESHOLD = 3;
const STABILITY_LENGTH_CHANGE_THRESHOLD = 0.1;
const STABILITY_MAX_WAIT_MS = 15_000;
const NETWORK_IDLE_QUIET_MS = 1000;
const NETWORK_IDLE_POLL_MS = 500;
const DIRECT_MEDIA_PROBE_TIMEOUT_MS = 3000;
const MEDIA_PROBE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_REDIRECTS = 5;
const ARTIFACT_DIR_NAME = 'opencli-scrape';

export async function scrapeWithPage(page, args) {
  const deadline = new ScrapeDeadline(args.timeoutMs, args.timeoutSeconds);
  const networkCaptureStarted = await maybeStartNetworkCapture(page);

  if (hasMediaLikeFileExtension(args.url)) {
    const media = await tryProbeDirectMedia(page, args.url, deadline, { browserFirst: false });
    if (media) return toMediaResult(media);
  }

  const navigation = await navigate(page, args.url, deadline);
  if (navigation.media) {
    return toMediaResult(navigation.media);
  }

  if (hasMediaLikeFileExtension(args.url)) {
    const media = await tryProbeDirectMedia(page, args.url, deadline);
    if (media) return toMediaResult(media);
  }

  const settled = await waitForContentStable(page, deadline, networkCaptureStarted);
  if (!settled) {
    if (args.waitForMs > 0) {
      await sleepMs(page, Math.min(args.waitForMs, deadline.remainingMs()));
      deadline.throwIfExpired();
    } else if (networkCaptureStarted) {
      await waitForNetworkIdleBestEffort(page, deadline.remainingMs());
      deadline.throwIfExpired();
    }
  }

  if (args.as === 'screenshot' || args.as === 'fullscreenshot') {
    const meta = await collectSnapshot(page, { required: false, deadline });
    const file = await saveScreenshot(page, args.as === 'fullscreenshot', deadline);
    return toResult({
      title: meta.title || '',
      url: meta.url || args.url,
      as: args.as,
      content: 'Screenshot saved',
      files: [file],
    });
  }

  const snapshot = await collectSnapshot(page, { required: true, deadline });
  const title = snapshot.title || '';
  const url = snapshot.url || args.url;
  if (!isSupportedHttpUrl(url) || (Number(snapshot.textLength) || 0) === 0) {
    const media = await tryProbeDirectMedia(page, args.url, deadline, { browserFirst: false });
    if (media) return toMediaResult(media);
  }
  if (!isSupportedHttpUrl(url)) {
    throw new CommandExecutionError(
      `Navigation did not reach an http(s) page (current URL: ${url || 'unknown'})`,
      `Requested URL: ${args.url}`,
    );
  }
  const frameDocuments = await collectAllFrameDocuments(page, snapshot, deadline);

  if (args.as === 'links') {
    const links = buildLinksResult({
      url,
      html: snapshot.html || '',
      frameDocuments,
      onlyMainContent: args.onlyMainContent,
    });
    deadline.throwIfExpired();
    return toResult({ title, url, as: 'links', links, persistText: true, deadline });
  }

  const content = buildTextResult({
    title,
    url,
    html: snapshot.html || '',
    frameDocuments,
    onlyMainContent: args.onlyMainContent,
  });
  deadline.throwIfExpired();
  return toResult({ title, url, as: 'markdown', content, persistText: true, deadline });
}

async function toResult({
  title,
  url,
  as,
  content = '',
  links = [],
  files = [],
  persistText = false,
  deadline = null,
}) {
  deadline?.throwIfExpired();
  const payload = formatScrapeText({ title, url, content, links, files: [] });
  deadline?.throwIfExpired();
  let allFiles = [...files];
  let savedContentFile = null;
  try {
    if (persistText && payload) {
      savedContentFile = await saveBinary('content-', '.md', Buffer.from(payload, 'utf8'));
      allFiles = [savedContentFile, ...allFiles];
      deadline?.throwIfExpired();
    }
    const chars = payload.length;
    const truncated = persistText && chars > INLINE_TEXT_MAX_CHARS;
    const result = {
      title,
      url,
      as,
      chars,
      truncated,
      content: truncated ? '' : content,
      links: truncated ? [] : links,
      files: allFiles,
      text: truncated
        ? buildTruncatedNotice({ title, url, chars, files: allFiles })
        : persistText
          ? formatScrapeText({ title, url, content, links, files: allFiles })
          : payload,
    };
    deadline?.throwIfExpired();
    return result;
  } catch (error) {
    if (savedContentFile) await deleteFileBestEffort(savedContentFile);
    throw error;
  }
}

function toMediaResult(media) {
  return toResult({
    title: media.fileName || '',
    url: media.url || '',
    as: 'media',
    content: 'Media file saved',
    files: media.files,
  });
}

async function navigate(page, url, deadline) {
  const previousUrl = await readCurrentUrlBestEffort(page, deadline);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    deadline.throwIfExpired();
    try {
      await page.goto(url, {
        waitUntil: 'load',
        settleMs: Math.max(1, Math.min(1000, deadline.remainingMs())),
      });
      deadline.throwIfExpired();
      return {};
    } catch (error) {
      deadline.throwIfExpired();
      lastError = error;
      if (isLikelyDownloadNavigationError(error)) {
        const media = await tryProbeDirectMedia(page, url, deadline);
        if (media) return { media };
      }
      if (await hasUsablePageContentAfterNavigation(page, previousUrl, deadline)) {
        return {};
      }
      if (attempt === 1 && isRetryableNavigationError(error)) {
        continue;
      }
      throw error;
    }
  }
  if (lastError) throw lastError;
  return {};
}

async function readCurrentUrlBestEffort(page, deadline) {
  deadline.throwIfExpired();
  try {
    const value = await page.evaluate('window.location.href');
    deadline.throwIfExpired();
    return typeof value === 'string' ? value : '';
  } catch {
    deadline.throwIfExpired();
    return '';
  }
}

async function hasUsablePageContentAfterNavigation(page, previousUrl, deadline) {
  const snapshot = await collectSnapshot(page, { required: false, deadline });
  const currentUrl = snapshot.url || '';
  if (!isSupportedHttpUrl(currentUrl) || currentUrl === previousUrl) return false;
  return (Number(snapshot.textLength) || 0) > 0
    || /<(?:img\b[^>]*\bsrc\s*=|video\b|audio\b|canvas\b|svg\b)/i.test(snapshot.html || '');
}

async function waitForContentStable(page, deadline, networkCaptureStarted) {
  const maxWaitMs = Math.min(deadline.remainingMs(), STABILITY_MAX_WAIT_MS);
  if (maxWaitMs <= 0) {
    deadline.throwIfExpired();
    return false;
  }
  const localDeadlineAt = Date.now() + maxWaitMs;

  if (networkCaptureStarted) {
    await waitForNetworkIdleBestEffort(
      page,
      Math.min(maxWaitMs, Math.max(STABILITY_CHECK_INTERVAL_MS * STABILITY_THRESHOLD, 1500)),
    );
    deadline.throwIfExpired();
  }

  let stableRounds = 0;
  let unstableRounds = 0;
  let anchorTextLength = await calculateTotalTextLength(page, deadline);

  while (Date.now() < localDeadlineAt) {
    deadline.throwIfExpired();
    const remaining = Math.min(STABILITY_CHECK_INTERVAL_MS, localDeadlineAt - Date.now(), deadline.remainingMs());
    if (remaining <= 0) break;
    await sleepMs(page, remaining);
    deadline.throwIfExpired();

    const currentTextLength = await calculateTotalTextLength(page, deadline);
    if (isLengthStable(anchorTextLength, currentTextLength, STABILITY_LENGTH_CHANGE_THRESHOLD)) {
      stableRounds += 1;
      unstableRounds = 0;
      anchorTextLength = currentTextLength;
      if (stableRounds >= STABILITY_THRESHOLD) {
        return true;
      }
    } else {
      stableRounds = 0;
      unstableRounds += 1;
      if (unstableRounds >= STABILITY_THRESHOLD) {
        anchorTextLength = currentTextLength;
        unstableRounds = 0;
      }
    }
  }
  return false;
}

async function maybeStartNetworkCapture(page) {
  if (!page.startNetworkCapture) return false;
  try {
    return await page.startNetworkCapture('');
  } catch {
    return false;
  }
}

async function waitForNetworkIdleBestEffort(page, timeoutMs) {
  if (!page.readNetworkCapture) return;
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  let quietSince = Date.now();
  while (Date.now() < deadlineAt) {
    let entries = [];
    try {
      const raw = await page.readNetworkCapture();
      entries = Array.isArray(raw) ? raw : [];
    } catch {
      return;
    }
    if (entries.length > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= NETWORK_IDLE_QUIET_MS) return;
    const remaining = Math.min(NETWORK_IDLE_POLL_MS, deadlineAt - Date.now());
    if (remaining <= 0) return;
    await sleepMs(page, remaining);
  }
}

async function calculateTotalTextLength(page, deadline) {
  let total = 0;
  try {
    total += Number(await page.evaluate(TEXT_LENGTH_JS)) || 0;
  } catch {
    // ignore
  }
  deadline?.throwIfExpired();
  if (!page.frames || !page.evaluateInFrame) return total;
  let frames = [];
  try {
    frames = await page.frames();
  } catch {
    deadline?.throwIfExpired();
    return total;
  }
  for (const frame of frames || []) {
    deadline?.throwIfExpired();
    try {
      const length = Number(await page.evaluateInFrame(TEXT_LENGTH_JS, frame.index));
      total += Number.isFinite(length) ? length : 0;
    } catch {
      // cross-origin frame may still fail
    }
  }
  deadline?.throwIfExpired();
  return total;
}

async function collectSnapshot(page, { required, deadline }) {
  deadline?.throwIfExpired();
  try {
    const snapshot = await page.evaluate(COLLECT_DOCUMENT_JS);
    deadline?.throwIfExpired();
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && typeof snapshot.html === 'string') {
      return {
        html: snapshot.html,
        title: typeof snapshot.title === 'string' ? snapshot.title : '',
        url: typeof snapshot.url === 'string' ? snapshot.url : '',
        textLength: Number(snapshot.textLength) || 0,
        frames: Array.isArray(snapshot.frames) ? snapshot.frames : [],
        inaccessible: Array.isArray(snapshot.inaccessible) ? snapshot.inaccessible : [],
      };
    }
  } catch (error) {
    deadline?.throwIfExpired();
    if (required) {
      const wrapped = new CommandExecutionError(
        'Failed to collect the rendered page content',
        'The page or Browser Bridge became unavailable during extraction.',
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return emptySnapshot();
  }
  if (required) {
    throw new CommandExecutionError(
      'Failed to collect the rendered page content',
      'The browser returned an invalid document snapshot.',
    );
  }
  return emptySnapshot();
}

function emptySnapshot() {
  return { html: '', title: '', url: '', textLength: 0, frames: [], inaccessible: [] };
}

async function collectAllFrameDocuments(page, mainSnapshot, deadline) {
  const crossOriginSnapshots = [];
  if (page.frames && page.evaluateInFrame) {
    let crossOrigin = [];
    try {
      crossOrigin = await page.frames();
    } catch {
      crossOrigin = [];
    }
    for (const frame of crossOrigin || []) {
      deadline?.throwIfExpired();
      let snapshot = null;
      try {
        snapshot = await page.evaluateInFrame(COLLECT_DOCUMENT_JS, frame.index);
      } catch {
        continue;
      }
      if (!snapshot || typeof snapshot !== 'object') continue;
      crossOriginSnapshots.push({
        ...snapshot,
        id: `xo-${frame.index ?? crossOriginSnapshots.length}`,
        url: snapshot.url || frame.url || '',
        order: 1000 + (frame.index ?? crossOriginSnapshots.length),
      });
    }
  }
  deadline?.throwIfExpired();
  return mergeFrameDocuments(mainSnapshot, crossOriginSnapshots);
}

async function tryProbeDirectMedia(page, url, deadline, { browserFirst = true } = {}) {
  deadline.throwIfExpired();
  const probeDeadlineAt = Date.now() + Math.min(deadline.remainingMs(), DIRECT_MEDIA_PROBE_TIMEOUT_MS);
  let probed = null;
  if (browserFirst && typeof page.evaluate === 'function') {
    const probeJs = buildMediaProbeJs(url, Math.max(1, probeDeadlineAt - Date.now()), MEDIA_PROBE_MAX_BYTES);
    try {
      probed = await page.evaluate(probeJs);
    } catch {
      probed = null;
    }
  }
  deadline.throwIfExpired();

  if (!probed || probed.error) {
    probed = await probeDirectMediaWithBrowserCookies(page, url, probeDeadlineAt);
    deadline.throwIfExpired();
  }
  if (!probed) return null;

  const mime = String(probed.mime || 'application/octet-stream');
  const contentDisposition = String(probed.contentDisposition || '');
  const responseUrl = String(probed.url || url);
  if (isHtmlLikeMime(mime)) return null;
  const mediaLikeResponse = isDirectMediaResponse(mime, contentDisposition, responseUrl)
    || isDirectMediaResponse(mime, contentDisposition, url);
  if (!mediaLikeResponse) return null;
  if (probed.tooLarge) {
    throw new CommandExecutionError(
      `Direct media exceeds the ${formatBytes(MEDIA_PROBE_MAX_BYTES)} transfer limit`,
      'Download the URL directly in Chrome, or use a dedicated downloader for larger files.',
    );
  }

  let bytes;
  if (Buffer.isBuffer(probed.bytes)) {
    bytes = probed.bytes;
  } else {
    if (!probed.base64) return null;
    try {
      bytes = Buffer.from(probed.base64, 'base64');
    } catch {
      return null;
    }
  }
  if (!bytes.length) return null;
  if (isHtmlDocumentBytes(bytes)) {
    throw new CommandExecutionError(
      'Direct media URL returned an HTML document',
      'The URL may require a different login session or may point to an error page.',
    );
  }
  const fileName = resolveSuggestedFileName(contentDisposition, responseUrl)
    || resolveSuggestedFileName('', url);
  const extension = guessExtension(mime, fileName);
  const file = await saveBinary('media-', extension, bytes);
  try {
    deadline.throwIfExpired();
    return { fileName, url, files: [file] };
  } catch (error) {
    await deleteFileBestEffort(file);
    throw error;
  }
}

function buildMediaProbeJs(url, timeoutMs, maxBytes) {
  const urlLooksLikeMedia = hasMediaLikeFileExtension(url);
  return `(async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ${Number(timeoutMs) || 3000}) : null;
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        redirect: 'follow',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return { error: 'status ' + res.status };
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentDisposition = res.headers.get('content-disposition') || '';
      const contentLength = Number(res.headers.get('content-length') || 0);
      const htmlDocument = mime === 'text/html' || mime === 'application/xhtml+xml';
      const binaryDocument = mime === 'application/zip'
        || mime === 'application/x-zip-compressed'
        || mime === 'application/gzip'
        || mime === 'application/x-gzip'
        || mime === 'application/x-tar'
        || mime === 'application/x-7z-compressed'
        || mime === 'application/vnd.rar'
        || mime === 'application/x-rar-compressed'
        || mime === 'application/msword'
        || mime.startsWith('application/vnd.ms-')
        || mime.startsWith('application/vnd.openxmlformats-officedocument.');
      const directByHeader = !htmlDocument && (
        /attachment/i.test(contentDisposition)
          || /filename\\*?=/i.test(contentDisposition)
          || /^(image|video|audio)\\//.test(mime)
          || mime === 'application/pdf'
          || binaryDocument
          || mime === 'application/octet-stream'
          || ${urlLooksLikeMedia}
      );
      if (!directByHeader) {
        if (res.body) await res.body.cancel().catch(() => {});
        return { mime, contentDisposition, url: res.url };
      }
      if (Number.isFinite(contentLength) && contentLength > ${maxBytes}) {
        if (res.body) await res.body.cancel().catch(() => {});
        return { tooLarge: true, contentLength, mime, contentDisposition, url: res.url };
      }
      let chunks = [];
      let total = 0;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const value = next.value || new Uint8Array(0);
          total += value.byteLength;
          if (total > ${maxBytes}) {
            await reader.cancel().catch(() => {});
            return { tooLarge: true, contentLength: total, mime, contentDisposition, url: res.url };
          }
          chunks.push(value);
        }
      } else {
        const value = new Uint8Array(await res.arrayBuffer());
        total = value.byteLength;
        if (total > ${maxBytes}) {
          return { tooLarge: true, contentLength: total, mime, contentDisposition, url: res.url };
        }
        chunks = [value];
      }
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const value of chunks) {
        buf.set(value, offset);
        offset += value.byteLength;
      }
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
      }
      return { mime, contentDisposition, status: res.status, url: res.url, base64: btoa(binary) };
    } catch (error) {
      return { error: String(error && error.message || error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  })()`;
}

async function probeDirectMediaWithBrowserCookies(page, url, probeDeadlineAt) {
  const timeoutMs = probeDeadlineAt - Date.now();
  if (timeoutMs <= 0 || typeof fetch !== 'function' || typeof page.getCookies !== 'function') return null;

  let userAgent = '';
  try {
    userAgent = String(await page.evaluate('navigator.userAgent') || '');
  } catch {
    // Browser fetch already failed; user-agent is optional for the fallback.
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(1, probeDeadlineAt - Date.now()))
    : null;
  try {
    const fetched = await fetchWithBrowserCookies({
      page,
      url,
      userAgent,
      controller,
      probeDeadlineAt,
    });
    if (!fetched) return null;
    const { response, responseUrl } = fetched;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const contentDisposition = response.headers.get('content-disposition') || '';
    if (
      !isDirectMediaResponse(mime, contentDisposition, responseUrl)
      && !isDirectMediaResponse(mime, contentDisposition, url)
    ) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readFetchResponseBytes(response, MEDIA_PROBE_MAX_BYTES);
    return {
      ...body,
      mime,
      contentDisposition,
      url: responseUrl,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithBrowserCookies({ page, url, userAgent, controller, probeDeadlineAt }) {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_MEDIA_REDIRECTS; redirectCount += 1) {
    if (Date.now() >= probeDeadlineAt) return null;
    let cookies = [];
    try {
      cookies = await page.getCookies({ url: currentUrl });
    } catch {
      return null;
    }
    const cookieHeader = (cookies || [])
      .filter((cookie) => cookie && cookie.name)
      .sort((left, right) => String(right.path || '').length - String(left.path || '').length)
      .map((cookie) => `${cookie.name}=${cookie.value ?? ''}`)
      .join('; ');
    const headers = {};
    if (cookieHeader) headers.cookie = cookieHeader;
    if (userAgent) headers['user-agent'] = userAgent;

    const response = await fetch(currentUrl, {
      headers,
      redirect: 'manual',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, responseUrl: response.url || currentUrl };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirectCount >= MAX_MEDIA_REDIRECTS) return null;
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      return null;
    }
    if (!isSupportedHttpUrl(nextUrl)) return null;
    currentUrl = nextUrl;
  }
  return null;
}

async function readFetchResponseBytes(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true, contentLength };
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > maxBytes
      ? { tooLarge: true, contentLength: bytes.length }
      : { bytes };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value || new Uint8Array(0));
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true, contentLength: total };
    }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks, total) };
}

function formatBytes(bytes) {
  return `${Math.trunc(bytes / (1024 * 1024))} MiB`;
}

function isHtmlLikeMime(mime) {
  const normalized = String(mime || '').trim().toLowerCase();
  return normalized === 'text/html' || normalized === 'application/xhtml+xml';
}

function isLengthStable(previousLength, currentLength, threshold) {
  if (previousLength === 0 && currentLength === 0) return true;
  if (previousLength <= 0 || currentLength <= 0) return false;
  const lengthChangeRatio = Math.abs(currentLength - previousLength) / previousLength;
  return lengthChangeRatio <= threshold;
}

function isRetryableNavigationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('net::err_network_changed')
    || message.includes('net::err_connection_closed')
    || message.includes('net::err_connection_reset')
    || message.includes('net::err_empty_response')
    || message.includes('net::err_http2_protocol_error');
}

function isLikelyDownloadNavigationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('download is starting') || message.includes('net::err_aborted');
}

async function sleepMs(page, ms) {
  const normalizedMs = Math.max(0, Number(ms) || 0);
  if (typeof page.sleep === 'function') {
    await page.sleep(normalizedMs / 1000);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, normalizedMs));
}

async function saveScreenshot(page, fullPage, deadline) {
  deadline.throwIfExpired();
  const file = await saveBinary(fullPage ? 'fullscreenshot-' : 'screenshot-', '.png', Buffer.alloc(0), false);
  try {
    await page.screenshot({ fullPage, path: file, format: 'png' });
    deadline.throwIfExpired();
    return file;
  } catch (error) {
    await deleteFileBestEffort(file);
    throw error;
  }
}

async function saveBinary(prefix, extension, bytes, write = true) {
  const dir = await ensureArtifactDir();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const file = path.join(dir, `${prefix}${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`);
    try {
      await fs.writeFile(file, write ? bytes : Buffer.alloc(0), {
        flag: 'wx',
        mode: 0o600,
      });
      return file;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      await deleteFileBestEffort(file);
      throw error;
    }
  }
  throw new CommandExecutionError('Failed to allocate a unique scrape artifact path');
}

async function ensureArtifactDir() {
  const dir = path.join(os.tmpdir(), ARTIFACT_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CommandExecutionError(
      `Unsafe scrape artifact path: ${dir}`,
      'Remove the path and retry; it must be a real directory, not a symlink.',
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CommandExecutionError(
      `Unsafe scrape artifact owner: ${dir}`,
      'Remove the directory or change it to the current user before retrying.',
    );
  }
  if (process.platform !== 'win32') {
    await fs.chmod(dir, 0o700);
  }
  return dir;
}

async function deleteFileBestEffort(file) {
  try {
    await fs.rm(file, { force: true });
  } catch {
    // Artifact cleanup is best-effort and must not mask the original error.
  }
}

class ScrapeDeadline {
  constructor(timeoutMs, timeoutSeconds) {
    this.timeoutSeconds = timeoutSeconds;
    this.deadlineAt = Date.now() + Math.max(1, timeoutMs);
  }

  remainingMs() {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  throwIfExpired() {
    if (Date.now() >= this.deadlineAt) {
      throw new TimeoutError('utils scrape', this.timeoutSeconds);
    }
  }
}

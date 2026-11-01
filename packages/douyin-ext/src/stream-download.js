import fs from 'node:fs';
import path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { isTrustedCdnUrl } from './video-selector.js';

export const MIN_VALID_VIDEO_BYTES = 1024;

/**
 * Sanitize URL for output and logging by omitting query parameters that may
 * contain sensitive authentication tokens or signatures.
 */
export function sanitizeUrlForLog(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return '';
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/**
 * Verify if the first bytes match a standard MP4 container header (ftyp box).
 */
export function isValidMp4Header(buffer) {
  if (!buffer || buffer.length < 8) return false;

  // Standard MP4: 4 bytes length + 'ftyp' (0x66, 0x74, 0x79, 0x70)
  const isFtypAt4 =
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70;
  if (isFtypAt4) return true;

  // Direct ftyp at 0
  const isFtypAt0 =
    buffer[0] === 0x66 &&
    buffer[1] === 0x74 &&
    buffer[2] === 0x79 &&
    buffer[3] === 0x70;
  if (isFtypAt0) return true;

  // Search first 64 bytes for ftyp or moov markers
  const sliceStr = buffer.slice(0, Math.min(buffer.length, 64)).toString('binary');
  return sliceStr.includes('ftyp') || sliceStr.includes('moov');
}

/**
 * Clean illegal characters for file systems across Windows/Linux/macOS.
 */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 80);
}

/**
 * Generate a non-colliding file path to ensure existing files are never overwritten.
 */
export function findNonCollidingPath(outputDir, baseName, ext = '.mp4') {
  let targetPath = path.join(outputDir, `${baseName}${ext}`);
  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(outputDir, `${baseName} (${counter})${ext}`);
    counter += 1;
  }
  return targetPath;
}

/**
 * Follow redirects step-by-step with SSRF validation on every hop.
 */
async function fetchStreamWithHops(initialUrl, { userAgent, timeoutSignal, fetchFn = fetch, maxHops = 6 }) {
  let currentUrl = initialUrl;
  const visited = new Set();

  for (let hop = 0; hop < maxHops; hop++) {
    if (!isTrustedCdnUrl(currentUrl)) {
      throw new CommandExecutionError(
        `Untrusted CDN URL encountered during download: ${sanitizeUrlForLog(currentUrl)}`
      );
    }

    if (visited.has(currentUrl)) {
      throw new CommandExecutionError('Redirect loop detected during video stream download');
    }
    visited.add(currentUrl);

    let res;
    try {
      res = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: timeoutSignal,
        headers: {
          Referer: 'https://www.douyin.com/',
          'User-Agent': userAgent,
          // Explicitly omit cookies/tokens to prevent credential leakage to CDNs
        },
      });
    } catch (err) {
      throw new CommandExecutionError(
        `Network error downloading video stream from ${sanitizeUrlForLog(currentUrl)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) {
        throw new CommandExecutionError('Redirect response missing Location header');
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        throw new CommandExecutionError('Invalid redirect Location in video stream download');
      }

      if (!isTrustedCdnUrl(nextUrl)) {
        throw new CommandExecutionError(
          `Redirected to untrusted domain during video download: ${sanitizeUrlForLog(nextUrl)}`
        );
      }
      currentUrl = nextUrl;
      continue;
    }

    if (res.status === 206) {
      await res.body?.cancel();
      throw new CommandExecutionError(
        'Server returned HTTP 206 (Partial Content); partial video downloads are rejected'
      );
    }

    if (res.status !== 200) {
      await res.body?.cancel();
      throw new CommandExecutionError(
        `Failed to download video stream, server returned HTTP ${res.status}`
      );
    }

    // Verify MIME content-type
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      await res.body?.cancel();
      throw new CommandExecutionError(
        `Unexpected content-type "${contentType}", expected binary video stream`
      );
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new CommandExecutionError(`Exceeded maximum redirects (${maxHops}) downloading video stream`);
}

/**
 * Stream download a video variant to the target output directory on the CLI execution host.
 */
export async function downloadVideoToFile({
  id,
  title = '',
  author = '',
  variant,
  outputDir = '.',
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  timeoutMs = 60000,
  fetchFn = fetch,
}) {
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  let lastError = null;
  const candidateUrls = variant.urls ?? [];

  for (const candidateUrl of candidateUrls) {
    const tmpFileName = `.tmp_douyin_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
    const tmpFilePath = path.join(resolvedOutputDir, tmpFileName);

    let writeStream = null;
    try {
      const { response: res, finalUrl } = await fetchStreamWithHops(candidateUrl, {
        userAgent,
        timeoutSignal,
        fetchFn,
      });

      if (!res.body) {
        throw new CommandExecutionError('Response body is empty or unavailable');
      }

      writeStream = fs.createWriteStream(tmpFilePath);

      let writtenBytes = 0;
      let headerChecked = false;
      const reader = res.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!headerChecked && value && value.length > 0) {
          const headerBuffer = Buffer.from(value.buffer, value.byteOffset, Math.min(value.length, 64));
          if (!isValidMp4Header(headerBuffer)) {
            await reader.cancel();
            throw new CommandExecutionError(
              'Downloaded stream does not contain a valid MP4 header (possible HTML error page or corrupted stream)'
            );
          }
          headerChecked = true;
        }

        writtenBytes += value.length;
        if (!writeStream.write(value)) {
          await new Promise((resolve, reject) => {
            writeStream.once('drain', resolve);
            writeStream.once('error', reject);
          });
        }
      }

      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });

      // Verification A: Size check
      if (writtenBytes < MIN_VALID_VIDEO_BYTES) {
        throw new CommandExecutionError(
          `Downloaded file size is suspiciously small (${writtenBytes} bytes), likely incomplete or corrupted`
        );
      }

      // Verification B: Content-Length check if available
      const rawContentLength = res.headers.get('content-length');
      if (rawContentLength) {
        const expectedLength = parseInt(rawContentLength, 10);
        if (Number.isFinite(expectedLength) && expectedLength > 0 && writtenBytes !== expectedLength) {
          throw new CommandExecutionError(
            `Downloaded size mismatch: expected ${expectedLength} bytes from header, received ${writtenBytes} bytes`
          );
        }
      }

      // Safe non-overwriting rename
      const cleanTitle = sanitizeFilename(title);
      const baseName = cleanTitle ? `${cleanTitle}_${id}` : String(id);
      const finalTargetPath = findNonCollidingPath(resolvedOutputDir, baseName, '.mp4');

      fs.renameSync(tmpFilePath, finalTargetPath);

      return {
        status: 'ok',
        id,
        title: title || '',
        author: author || '',
        quality: variant.quality,
        codec: variant.codec,
        path: finalTargetPath,
        bytes: writtenBytes,
        source: sanitizeUrlForLog(finalUrl),
      };
    } catch (err) {
      if (writeStream) {
        writeStream.destroy();
      }
      fs.rmSync(tmpFilePath, { force: true });
      lastError = err;
      // If aborted by overall timeout, break immediately
      if (timeoutSignal.aborted) {
        throw new CommandExecutionError(
          `Video download timed out after ${Math.round(timeoutMs / 1000)} seconds`
        );
      }
    }
  }

  throw lastError || new CommandExecutionError('All candidate video stream URLs failed to download');
}

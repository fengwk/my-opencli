import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { isTrustedCdnUrl } from './video-selector.js';

export const MIN_VALID_VIDEO_BYTES = 1024;
const MAX_FILENAME_BYTES = 255;

/**
 * Validate standard MP4 ftyp container header:
 * - Must accumulate at least 16 bytes
 * - Big-endian 32-bit box size between 12 and 1024
 * - Offset 4..8 must be ASCII 'ftyp'
 * - Offset 8..12 must be a printable ASCII major brand, not HTML/JSON
 */
export function validateMp4HeaderBuffer(buffer) {
  if (!buffer || buffer.length < 16) {
    return false;
  }

  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < 12 || boxSize > 1024) {
    return false;
  }

  const tag = buffer.toString('ascii', 4, 8);
  if (tag !== 'ftyp') {
    return false;
  }

  const majorBrand = buffer.toString('ascii', 8, 12);
  // Major brand must be printable ASCII and cannot be HTML/JSON markers
  if (!/^[ -~]{4}$/.test(majorBrand) || /^(<!DO|<htm|{"st)/i.test(majorBrand)) {
    return false;
  }

  return true;
}

/**
 * Create a Transform stream that accumulates at least 16 bytes to strictly validate the MP4 header
 * before streaming data through without full buffering.
 */
function createMp4HeaderValidator() {
  let accumulated = Buffer.alloc(0);
  let verified = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      if (verified) {
        return callback(null, chunk);
      }

      accumulated = Buffer.concat([accumulated, chunk]);
      if (accumulated.length < 16) {
        return callback();
      }

      if (!validateMp4HeaderBuffer(accumulated)) {
        return callback(
          new CommandExecutionError(
            'Downloaded stream does not contain a valid MP4 header (ftyp box invalid or missing)'
          )
        );
      }

      verified = true;
      const pass = accumulated;
      accumulated = Buffer.alloc(0);
      callback(null, pass);
    },
    flush(callback) {
      if (!verified) {
        return callback(
          new CommandExecutionError(
            'Stream ended before sufficient data for MP4 header verification'
          )
        );
      }
      callback();
    },
  });
}

/**
 * Sanitize filename strictly:
 * - Strips NUL and control characters (0x00-0x1F, 0x7F)
 * - Strips path separators and illegal filesystem characters
 * - Strips leading/trailing dots and whitespace
 * - Keeps at most 80 whole Unicode code points; the final byte budget is enforced at placement
 */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/\0/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\.\s]+|[\.\s]+$/g, '')
    .trim();
  return Array.from(cleaned).slice(0, 80).join('');
}

function truncateUtf8(text, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/**
 * Atomically create a destination file using hardlink + unlink loop.
 * Guarantees zero overwrite even under concurrent execution on POSIX filesystems.
 * Truncates only the title/base name, reserving bytes for an intact ID, counter and extension.
 */
export async function atomicNoOverwriteLink(tmpFilePath, outputDir, baseName, ext = '.mp4', idSuffix = '') {
  let counter = 0;
  while (true) {
    const suffix = `${idSuffix}${counter === 0 ? '' : ` (${counter})`}${ext}`;
    const titleBudget = MAX_FILENAME_BYTES - Buffer.byteLength(suffix, 'utf8');
    if (titleBudget < 0) {
      throw new CommandExecutionError('Video filename suffix exceeds the 255-byte filename limit');
    }
    const candidateName = `${truncateUtf8(baseName, titleBudget)}${suffix}`;
    const candidatePath = path.join(outputDir, candidateName);

    try {
      await fs.promises.link(tmpFilePath, candidatePath);
      await fs.promises.unlink(tmpFilePath).catch(() => {});
      return candidatePath;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        counter += 1;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Follow redirects with SSRF check on every hop.
 */
async function fetchStreamWithHops(initialUrl, { userAgent, timeoutSignal, fetchFn = fetch, maxHops = 6 }) {
  let currentUrl = initialUrl;
  const visited = new Set();

  for (let hop = 0; hop < maxHops; hop++) {
    if (!isTrustedCdnUrl(currentUrl)) {
      throw new CommandExecutionError('Encountered untrusted CDN URL in download sequence');
    }

    if (visited.has(currentUrl)) {
      throw new CommandExecutionError('Redirect loop detected during video stream download');
    }
    visited.add(currentUrl);

    const headers = { Referer: 'https://www.douyin.com/' };
    if (userAgent && typeof userAgent === 'string') {
      headers['User-Agent'] = userAgent;
    }

    let res;
    try {
      res = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: timeoutSignal,
        headers,
      });
    } catch (err) {
      throw new CommandExecutionError(
        `Network error during stream download: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
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
        throw new CommandExecutionError('Redirected to untrusted domain during video download');
      }
      currentUrl = nextUrl;
      continue;
    }

    if (res.status === 206) {
      await res.body?.cancel().catch(() => {});
      throw new CommandExecutionError(
        'Server returned HTTP 206 (Partial Content); partial video downloads are rejected'
      );
    }

    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new CommandExecutionError(`Failed to download video stream, server returned HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      await res.body?.cancel().catch(() => {});
      throw new CommandExecutionError(`Unexpected content-type "${contentType}", expected binary video stream`);
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
  userAgent,
  timeoutMs = 60000,
  fetchFn = fetch,
}) {
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let lastError = null;

  for (const candidateUrl of variant.urls ?? []) {
    let taskDir = null;
    let res = null;
    try {
      taskDir = await fs.promises.mkdtemp(path.join(resolvedOutputDir, `.douyin-tmp-${id}-`));
      const partFilePath = path.join(taskDir, 'video.part');

      const hopResult = await fetchStreamWithHops(candidateUrl, {
        userAgent,
        timeoutSignal,
        fetchFn,
      });
      res = hopResult.response;
      const finalUrl = hopResult.finalUrl;

      if (!res.body) {
        throw new CommandExecutionError('Response body is empty or unavailable');
      }

      // Exclusive open write stream inside owned task directory
      const writeStream = fs.createWriteStream(partFilePath, { flags: 'wx' });
      const validator = createMp4HeaderValidator();

      let writtenBytes = 0;
      const byteCounter = new Transform({
        transform(chunk, encoding, callback) {
          writtenBytes += chunk.length;
          callback(null, chunk);
        },
      });

      // Unified stream pipeline with automatic error/abort handling
      await pipeline(
        Readable.fromWeb(res.body),
        validator,
        byteCounter,
        writeStream,
        { signal: timeoutSignal }
      );

      // Verify file size thresholds
      if (writtenBytes < MIN_VALID_VIDEO_BYTES) {
        throw new CommandExecutionError(
          `Downloaded file size is suspiciously small (${writtenBytes} bytes)`
        );
      }

      // Verify Content-Length if available
      const rawLength = res.headers.get('content-length');
      if (rawLength) {
        const expectedLength = parseInt(rawLength, 10);
        if (Number.isFinite(expectedLength) && expectedLength > 0 && writtenBytes !== expectedLength) {
          throw new CommandExecutionError(
            `Downloaded size mismatch: expected ${expectedLength} bytes, received ${writtenBytes} bytes`
          );
        }
      }

      // Atomic, non-overwriting rename via hardlink from owned task directory
      const cleanTitle = sanitizeFilename(title);
      const baseName = cleanTitle || String(id);
      const idSuffix = cleanTitle ? `_${id}` : '';
      const finalTargetPath = await atomicNoOverwriteLink(partFilePath, resolvedOutputDir, baseName, '.mp4', idSuffix);

      return {
        status: 'ok',
        id,
        title: title || '',
        author: author || '',
        quality: variant.quality,
        codec: variant.codec,
        path: finalTargetPath,
        bytes: writtenBytes,
        source: new URL(finalUrl).hostname,
      };
    } catch (err) {
      if (res?.body) {
        await res.body.cancel().catch(() => {});
      }
      lastError = err;
      if (timeoutSignal.aborted) {
        throw new CommandExecutionError(
          `Video download timed out after ${Math.round(timeoutMs / 1000)} seconds`
        );
      }
    } finally {
      if (taskDir) {
        await fs.promises.rm(taskDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  throw lastError || new CommandExecutionError('All candidate video stream URLs failed to download');
}

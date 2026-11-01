import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import {
  downloadVideoToFile,
  findNonCollidingPath,
  isValidMp4Header,
  sanitizeUrlForLog,
} from '../src/stream-download.js';

function createDummyMp4Buffer(size = 2048) {
  const buf = Buffer.alloc(size);
  // Box size: 32 bytes (big endian)
  buf.writeUInt32BE(32, 0);
  // 'ftyp'
  buf.write('ftyp', 4, 'ascii');
  // 'isom'
  buf.write('isom', 8, 'ascii');
  return buf;
}

function createReadableStreamFromBuffer(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

describe('douyin-ext stream-download (streaming, headers, cleanup, safety)', () => {
  const testDir = path.resolve('.tmp-test-douyin-download');
  const validCdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/valid.mp4?token=secret123&sign=xyz';

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Test intent: Verify MP4 magic header detection accurately distinguishes valid ftyp boxes
  // from HTML or corrupt payloads.
  it('correctly verifies MP4 magic header and rejects non-MP4 payload', () => {
    const valid = createDummyMp4Buffer(128);
    expect(isValidMp4Header(valid)).toBe(true);

    const html = Buffer.from('<!DOCTYPE html><html><body>Error</body></html>');
    expect(isValidMp4Header(html)).toBe(false);

    const short = Buffer.from([0, 0, 0]);
    expect(isValidMp4Header(short)).toBe(false);
  });

  // Test intent: Ensure URL sanitization strips query parameters containing sensitive tokens or signatures.
  it('sanitizes URL query parameters to avoid exposing signatures in logs/output', () => {
    const sanitized = sanitizeUrlForLog(
      'https://v26-web.douyinvod.com/video/test.mp4?auth_key=abc&sign=xyz&token=123'
    );
    expect(sanitized).toBe('https://v26-web.douyinvod.com/video/test.mp4');
    expect(sanitized).not.toContain('auth_key');
    expect(sanitized).not.toContain('sign');
  });

  // Test intent: Verify successful download streams to file, validates header,
  // returns structured result with real path/bytes, and strips sensitive tokens from source.
  it('successfully downloads video stream and returns structured result', async () => {
    const dummyBuffer = createDummyMp4Buffer(4096);
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': String(dummyBuffer.length),
      }),
      body: createReadableStreamFromBuffer(dummyBuffer),
    });

    const result = await downloadVideoToFile({
      id: '7701962254330128228',
      title: 'Awesome Douyin Video',
      author: 'CreatorNickname',
      variant: {
        quality: '1080p',
        codec: 'h264',
        urls: [validCdnUrl],
      },
      outputDir: testDir,
      fetchFn: mockFetch,
    });

    expect(result.status).toBe('ok');
    expect(result.id).toBe('7701962254330128228');
    expect(result.quality).toBe('1080p');
    expect(result.codec).toBe('h264');
    expect(result.bytes).toBe(dummyBuffer.length);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.statSync(result.path).size).toBe(dummyBuffer.length);
    // Source should not contain token or sign query params
    expect(result.source).toBe('https://v26-web.douyinvod.com/video/tos-cn-v/valid.mp4');
  });

  // Test intent: Ensure existing files are never overwritten; a new non-colliding filename is created.
  it('preserves existing files and writes to a non-colliding filename without overwriting', async () => {
    const existingFile = path.join(testDir, 'MyVideo_7701962254330128228.mp4');
    fs.writeFileSync(existingFile, 'original content');

    const dummyBuffer = createDummyMp4Buffer(2048);
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': String(dummyBuffer.length),
      }),
      body: createReadableStreamFromBuffer(dummyBuffer),
    });

    const result = await downloadVideoToFile({
      id: '7701962254330128228',
      title: 'MyVideo',
      variant: {
        quality: '720p',
        codec: 'h264',
        urls: [validCdnUrl],
      },
      outputDir: testDir,
      fetchFn: mockFetch,
    });

    expect(result.path).not.toBe(existingFile);
    expect(result.path).toContain('MyVideo_7701962254330128228 (1).mp4');
    // Ensure original file remained unchanged
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('original content');
  });

  // Test intent: Reject HTTP 206 Partial Content downloads to prevent saving incomplete files.
  it('rejects HTTP 206 Partial Content and cleans up temporary file', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 206,
      headers: new Headers(),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'PartialVideo',
        variant: {
          quality: '1080p',
          codec: 'h264',
          urls: [validCdnUrl],
        },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/206/);

    // Verify no temporary files remain
    const files = fs.readdirSync(testDir);
    expect(files.filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });

  // Test intent: Reject non-MP4 payload (e.g. HTML error page returned with 200) and clean up.
  it('detects non-MP4 content during stream read and cleans up temporary file', async () => {
    const htmlPayload = Buffer.from('<!DOCTYPE html><html><body>Access Denied</body></html>');
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'text/html',
      }),
      body: createReadableStreamFromBuffer(htmlPayload),
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'HtmlErrorVideo',
        variant: {
          quality: '1080p',
          codec: 'h264',
          urls: [validCdnUrl],
        },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(CommandExecutionError);

    // Verify temp file cleanup
    const files = fs.readdirSync(testDir);
    expect(files.filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });

  // Test intent: Reject redirect to an untrusted domain during download (SSRF prevention).
  it('rejects redirect to untrusted domain during video download', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: 'https://evil-untrusted-cdn.com/exploit.mp4',
      }),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'UntrustedRedirect',
        variant: {
          quality: '1080p',
          codec: 'h264',
          urls: [validCdnUrl],
        },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/untrusted domain/i);

    const files = fs.readdirSync(testDir);
    expect(files.filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });

  // Test intent: Detect truncated download when received size does not match Content-Length header.
  it('detects Content-Length mismatch and cleans up temporary file', async () => {
    const dummyBuffer = createDummyMp4Buffer(2048);
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': '999999', // Declared much larger than actual received
      }),
      body: createReadableStreamFromBuffer(dummyBuffer),
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'TruncatedVideo',
        variant: {
          quality: '1080p',
          codec: 'h264',
          urls: [validCdnUrl],
        },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/size mismatch/i);

    const files = fs.readdirSync(testDir);
    expect(files.filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });
});

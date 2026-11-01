import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import {
  atomicNoOverwriteLink,
  downloadVideoToFile,
  sanitizeFilename,
  validateMp4HeaderBuffer,
} from '../src/stream-download.js';

function createDummyMp4Buffer(size = 2048) {
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(32, 0); // box size 32
  buf.write('ftyp', 4, 'ascii');
  buf.write('isom', 8, 'ascii'); // major brand
  buf.writeUInt32BE(512, 12); // minor version
  return buf;
}

function createChunkedStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });
}

describe('douyin-ext stream-download (chunked header, error cleanup, atomic no-overwrite, risk checks)', () => {
  let testDir;
  const validCdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/valid.mp4?token=secret123&sign=xyz';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stream-test-'));
  });

  afterEach(() => {
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('strictly validates ftyp box and rejects HTML disguise containing ftyp or moov keywords', () => {
    const valid = createDummyMp4Buffer(32);
    expect(validateMp4HeaderBuffer(valid)).toBe(true);

    const htmlDisguise = Buffer.from('<!DOCTYPE html><html><body>Video with ftyp and moov</body></html>');
    expect(validateMp4HeaderBuffer(htmlDisguise)).toBe(false);

    const shortBuf = Buffer.from([0, 0, 0, 16, 0x66, 0x74]); // less than 16 bytes
    expect(validateMp4HeaderBuffer(shortBuf)).toBe(false);
  });

  it('correctly verifies MP4 header when bytes arrive split across small chunks', async () => {
    const fullBuffer = createDummyMp4Buffer(2048);
    const chunk1 = fullBuffer.subarray(0, 4);
    const chunk2 = fullBuffer.subarray(4, 16);
    const chunk3 = fullBuffer.subarray(16);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': String(fullBuffer.length),
      }),
      body: createChunkedStream([chunk1, chunk2, chunk3]),
    });

    const result = await downloadVideoToFile({
      id: '7701962254330128228',
      title: 'SplitChunkVideo',
      variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
      outputDir: testDir,
      fetchFn: mockFetch,
    });

    expect(result.status).toBe('ok');
    expect(result.bytes).toBe(fullBuffer.length);
    expect(result.source).toBe('v26-web.douyinvod.com');
  });

  it('atomically finds next non-colliding filename via hardlink loop without overwriting', async () => {
    const baseName = 'ExistingVideo_123';
    const existingFile = path.join(testDir, `${baseName}.mp4`);
    fs.writeFileSync(existingFile, 'original content');

    const tmpFile = path.join(testDir, 'source.part');
    fs.writeFileSync(tmpFile, 'new content');

    const finalPath = await atomicNoOverwriteLink(tmpFile, testDir, baseName, '.mp4');
    expect(finalPath).toBe(path.join(testDir, `${baseName} (1).mp4`));
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('original content');
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('new content');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('sanitizes illegal filename characters, control bytes, and boundary dots', () => {
    expect(sanitizeFilename('Bad\0Title\x07Name:Test/123...')).toBe('BadTitleName_Test_123');
    expect(sanitizeFilename('...')).toBe('');
  });

  // Risk check: Hanging response body aborted by AbortSignal and temp dir cleaned up
  it('cleans up owned task directory when stream body stalls and times out', async () => {
    const hangingStream = new ReadableStream({
      start() {
        // Deliberately stalls without pushing data or closing
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: hangingStream,
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'StalledVideo',
        variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
        outputDir: testDir,
        timeoutMs: 30, // 30ms timeout
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/timed out/i);

    const entries = fs.readdirSync(testDir);
    expect(entries.filter((e) => e.startsWith('.douyin-tmp-'))).toHaveLength(0);
  });

  // Risk check: Untrusted redirect target must not be followed
  it('rejects untrusted redirect destination and does not follow it', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: 'https://attacker.example.com/exploit.mp4',
      }),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'UntrustedRedirect',
        variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/untrusted/i);

    // Only one hop should have been executed; untrusted target never fetched
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const entries = fs.readdirSync(testDir);
    expect(entries.filter((e) => e.startsWith('.douyin-tmp-'))).toHaveLength(0);
  });

  // Risk check: Content-Length mismatch rejected and cleaned up
  it('detects Content-Length mismatch and cleans up task directory', async () => {
    const dummyBuffer = createDummyMp4Buffer(2048);
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': '999999', // Declared much larger than actual received
      }),
      body: createChunkedStream([dummyBuffer]),
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'TruncatedVideo',
        variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/size mismatch/i);

    const entries = fs.readdirSync(testDir);
    expect(entries.filter((e) => e.startsWith('.douyin-tmp-'))).toHaveLength(0);
  });

  it('rejects HTTP 206 Partial Content and cleans up', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 206,
      headers: new Headers(),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'PartialVideo',
        variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/206/);

    const entries = fs.readdirSync(testDir);
    expect(entries.filter((e) => e.startsWith('.douyin-tmp-'))).toHaveLength(0);
  });
});

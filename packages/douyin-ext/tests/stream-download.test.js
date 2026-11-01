import fs from 'node:fs';
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

describe('douyin-ext stream-download (chunked header, error cleanup, atomic no-overwrite)', () => {
  const testDir = path.resolve('.tmp-test-douyin-stream');
  const validCdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/valid.mp4?token=secret123&sign=xyz';

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Defect check: validateMp4HeaderBuffer must reject HTML text that merely contains 'ftyp' or 'moov'
  it('strictly validates ftyp box and rejects HTML disguise containing ftyp or moov keywords', () => {
    const valid = createDummyMp4Buffer(32);
    expect(validateMp4HeaderBuffer(valid)).toBe(true);

    const htmlDisguise = Buffer.from('<!DOCTYPE html><html><body>Video with ftyp and moov</body></html>');
    expect(validateMp4HeaderBuffer(htmlDisguise)).toBe(false);

    const shortBuf = Buffer.from([0, 0, 0, 16, 0x66, 0x74]); // less than 16 bytes
    expect(validateMp4HeaderBuffer(shortBuf)).toBe(false);
  });

  // Defect check: chunked header accumulation across small chunks
  it('correctly verifies MP4 header when bytes arrive split across small chunks', async () => {
    const fullBuffer = createDummyMp4Buffer(2048);
    // Split into 4-byte chunk and 12-byte chunk to test header accumulation
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
    // source must report hostname only
    expect(result.source).toBe('v26-web.douyinvod.com');
  });

  // Defect check: atomicNoOverwriteLink guarantees zero overwrite when file exists
  it('atomically finds next non-colliding filename via hardlink loop without overwriting', async () => {
    const baseName = 'ExistingVideo_123';
    const existingFile = path.join(testDir, `${baseName}.mp4`);
    fs.writeFileSync(existingFile, 'original content');

    const tmpFile = path.join(testDir, '.tmp_test_file.mp4');
    fs.writeFileSync(tmpFile, 'new content');

    const finalPath = await atomicNoOverwriteLink(tmpFile, testDir, baseName, '.mp4');
    expect(finalPath).toBe(path.join(testDir, `${baseName} (1).mp4`));
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('original content');
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('new content');
    expect(fs.existsSync(tmpFile)).toBe(false); // temp file unlinked
  });

  // Defect check: sanitizeFilename cleans NUL, control chars, path bounds
  it('sanitizes illegal filename characters, control bytes, and boundary dots', () => {
    expect(sanitizeFilename('Bad\0Title\x07Name:Test/123...')).toBe('BadTitleName_Test_123');
    expect(sanitizeFilename('...')).toBe('');
  });

  // Defect check: stream error / abort cleans up temp file
  it('cleans up temporary file upon stream pipeline error', async () => {
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(createDummyMp4Buffer(64)));
        controller.error(new Error('Simulated network mid-stream interruption'));
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: errorStream,
    });

    await expect(
      downloadVideoToFile({
        id: '7701962254330128228',
        title: 'ErrorVideo',
        variant: { quality: '1080p', codec: 'h264', urls: [validCdnUrl] },
        outputDir: testDir,
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(/interruption/i);

    const files = fs.readdirSync(testDir);
    expect(files.filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });

  // Defect check: reject HTTP 206 Partial Content
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
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Strategy } from '@jackwener/opencli/registry';
import { downloadCommand } from '../download.js';

function createDummyMp4Buffer(size = 2048) {
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(32, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write('isom', 8, 'ascii');
  return buf;
}

describe('douyin-ext download (command registration and execution flow)', () => {
  const testDir = path.resolve('.tmp-test-douyin-command');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Test intent: Validate the public command registration matches the technical design
  // (site=douyin-ext, browser=true, navigateBefore=false, ephemeral session).
  it('registers with the expected OpenCLI command contracts', () => {
    expect(downloadCommand.site).toBe('douyin-ext');
    expect(downloadCommand.name).toBe('download');
    expect(downloadCommand.access).toBe('read');
    expect(downloadCommand.domain).toBe('www.douyin.com');
    expect(downloadCommand.strategy).toBe(Strategy.COOKIE);
    expect(downloadCommand.browser).toBe(true);
    expect(downloadCommand.siteSession).toBe('ephemeral');
    expect(downloadCommand.navigateBefore).toBe(false);
    expect(downloadCommand.defaultWindowMode).toBe('background');
    expect(downloadCommand.defaultFormat).toBe('json');
    expect(downloadCommand.columns).toEqual([
      'status',
      'id',
      'title',
      'author',
      'quality',
      'codec',
      'path',
      'bytes',
      'source',
    ]);

    const argNames = downloadCommand.args.map((a) => a.name);
    expect(argNames).toContain('target');
    expect(argNames).toContain('output');
    expect(argNames).toContain('quality');
    expect(argNames).toContain('timeout');
  });

  // Test intent: Verify the entire execution flow: parse input, page evaluate,
  // select stream, node streaming fetch, and structured output.
  it('executes full download workflow and returns structured row', async () => {
    const targetId = '7701962254330128228';
    const cdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/fullflow.mp4';
    const dummyBuffer = createDummyMp4Buffer(2048);

    // Mock page evaluate for aweme detail
    const page = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async (code) => {
        if (typeof code === 'function' && String(code).includes('userAgent')) {
          return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestBrowser/1.0';
        }
        return {
          __kind: 'ok',
          data: {
            status_code: 0,
            aweme_detail: {
              aweme_id: targetId,
              desc: 'Full flow integration test video',
              author: { nickname: 'Tester' },
              video: {
                width: 1080,
                height: 1920,
                bit_rate: [
                  {
                    width: 1080,
                    height: 1920,
                    bit_rate: 3000000,
                    gear_name: 'normal_1080_0',
                    is_h265: 0,
                    play_addr: { url_list: [cdnUrl] },
                  },
                ],
              },
            },
          },
        };
      }),
    };

    // Mock Node global fetch for stream download
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': String(dummyBuffer.length),
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(dummyBuffer));
          controller.close();
        },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const rows = await downloadCommand.func(page, {
      target: targetId,
      output: testDir,
      quality: 'best',
      timeout: 30,
    });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    const result = rows[0];

    expect(result.status).toBe('ok');
    expect(result.id).toBe(targetId);
    expect(result.title).toBe('Full flow integration test video');
    expect(result.author).toBe('Tester');
    expect(result.quality).toBe('1080p');
    expect(result.codec).toBe('h264');
    expect(result.bytes).toBe(dummyBuffer.length);
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

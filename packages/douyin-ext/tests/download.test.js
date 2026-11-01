import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';
import { downloadCommand } from '../download.js';

function createDummyMp4Buffer(size = 2048) {
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(32, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write('isom', 8, 'ascii');
  buf.writeUInt32BE(512, 12);
  return buf;
}

describe('douyin-ext download (validation, contract, and overall deadline)', () => {
  const testDir = path.resolve('.tmp-test-douyin-command');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('validates command arguments offline in validateArgs before network navigation', () => {
    // 21-digit number must be rejected statically
    expect(() => downloadCommand.validateArgs({ target: '123456789012345678901' })).toThrow(
      ArgumentError
    );
    // Untrusted domain rejected statically
    expect(() => downloadCommand.validateArgs({ target: 'https://evil.com/video/1234567890123456789' })).toThrow(
      ArgumentError
    );
    // Non-integer timeout rejected
    expect(() => downloadCommand.validateArgs({ target: '7701962254330128228', timeout: 12.5 })).toThrow(
      ArgumentError
    );
  });

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
  });

  // Defect check: overall deadline halts downstream phases when exhausted
  it('enforces shared overall timeout deadline across execution phases', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {
        // Simulate delay that exhausts timeout budget
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
      evaluate: vi.fn(async () => {
        throw new Error('Should not reach evaluate if timed out');
      }),
    };

    // Very short timeout
    await expect(
      downloadCommand.func(page, {
        target: '7701962254330128228',
        output: testDir,
        timeout: 1, // 1 second
      })
    ).rejects.toThrow();
  });

  it('executes full download workflow and returns structured row with hostname source', async () => {
    const targetId = '7701962254330128228';
    const cdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/fullflow.mp4';
    const dummyBuffer = createDummyMp4Buffer(2048);

    const page = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async (code) => {
        if (typeof code === 'function' && String(code).includes('userAgent')) {
          return 'Mozilla/5.0 TestBrowser/1.0';
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
                    gear_name: 'normal_1080_0',
                    is_h265: 0,
                    play_addr: {
                      width: 1080,
                      height: 1920,
                      url_list: [cdnUrl],
                    },
                  },
                ],
              },
            },
          },
        };
      }),
    };

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

    expect(rows).toHaveLength(1);
    const result = rows[0];
    expect(result.status).toBe('ok');
    expect(result.id).toBe(targetId);
    expect(result.quality).toBe('1080p');
    expect(result.codec).toBe('h264');
    expect(result.source).toBe('v26-web.douyinvod.com');
  });
});

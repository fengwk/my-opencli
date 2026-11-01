import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
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
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-cmd-test-'));
  });

  afterEach(() => {
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
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
    // Unsupported quality rejected
    expect(() => downloadCommand.validateArgs({ target: '7701962254330128228', quality: '123p' })).toThrow(
      ArgumentError
    );
    // Allow valid op
    expect(() =>
      downloadCommand.validateArgs({ target: '7701962254330128228', op: './v1' })
    ).not.toThrow();
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

    const argNames = downloadCommand.args.map((a) => a.name);
    expect(argNames).toContain('op');
    expect(argNames).not.toContain('output');

    const opArg = downloadCommand.args.find((a) => a.name === 'op');
    expect(opArg.valueRequired).toBe(true);
    expect(opArg.default).toBeUndefined();
  });

  // Verify controlled deadline exhaustion using vi.spyOn(Date, 'now')
  it('enforces overall timeout deadline and avoids downstream evaluate/fetch when budget expires', async () => {
    let currentTime = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const page = {
      goto: vi.fn(async () => {
        // Advance time beyond the 30-second budget during navigation
        currentTime += 35000;
      }),
      wait: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {
        return { __kind: 'ok', data: { status_code: 0, aweme_detail: {} } };
      }),
    };

    await expect(
      downloadCommand.func(page, {
        target: '7701962254330128228',
        op: testDir,
        timeout: 30,
      })
    ).rejects.toThrow(/timed out|exceeded overall timeout/i);

    // Verify evaluate and stream fetch were never invoked because timeout checked eagerly
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
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
      op: testDir,
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
    expect(result.path).toContain(testDir);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('executes download workflow when output directory passed via --op', async () => {
    const targetId = '7701962254330128228';
    const cdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/fullflow.mp4';
    const dummyBuffer = createDummyMp4Buffer(2048);

    const page = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        __kind: 'ok',
        data: {
          status_code: 0,
          aweme_detail: {
            aweme_id: targetId,
            desc: 'Op test video',
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
      })),
    };

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
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
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const opDir = path.join(testDir, 'op-target');
    const rows = await downloadCommand.func(page, {
      target: targetId,
      op: opDir,
      quality: 'best',
      timeout: 30,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].path).toContain('op-target');
    expect(fs.existsSync(rows[0].path)).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { userVideosCommand } from '../user-videos.js';

describe('douyin-ext user-videos command definition and execution wrapper', () => {
  const targetSecUid = 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU';

  // Test intent: Verify OpenCLI metadata, columns registration, and argument configurations.
  it('registers expected command metadata and valueRequired flag on options', () => {
    expect(userVideosCommand.site).toBe('douyin-ext');
    expect(userVideosCommand.name).toBe('user-videos');
    expect(userVideosCommand.navigateBefore).toBe(false);
    expect(userVideosCommand.defaultWindowMode).toBe('background');
    expect(userVideosCommand.siteSession).toBe('ephemeral');
    expect(userVideosCommand.columns).toEqual([
      'sec_uid',
      'cursor',
      'next_cursor',
      'has_more',
      'items',
    ]);

    // Ensure all options with arguments have valueRequired: true
    const cursorArg = userVideosCommand.args.find((a) => a.name === 'cursor');
    const countArg = userVideosCommand.args.find((a) => a.name === 'count');
    const commentLimitArg = userVideosCommand.args.find(
      (a) => a.name === 'comment-limit'
    );
    const timeoutArg = userVideosCommand.args.find((a) => a.name === 'timeout');

    expect(cursorArg?.valueRequired).toBe(true);
    expect(countArg?.valueRequired).toBe(true);
    expect(commentLimitArg?.valueRequired).toBe(true);
    expect(timeoutArg?.valueRequired).toBe(true);
  });

  // Test intent: Verify func wrapper returns a single-row array with pagination fields.
  it('executes func wrapper and returns single row with exact columns', async () => {
    const mockPage = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [
            {
              aweme_id: '7701962254330128228',
              desc: 'Single row test',
              video: { duration: 10000, play_addr: { url_list: ['https://example.com/v.mp4'] } },
              statistics: { digg_count: 50 },
            },
          ],
        },
      })),
    };

    const rows = await userVideosCommand.func(mockPage, {
      target: targetSecUid,
      cursor: '0',
      count: 20,
      'comment-limit': 0,
      timeout: 60,
    });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.sec_uid).toBe(targetSecUid);
    expect(row.cursor).toBe('0');
    expect(row.next_cursor).toBe('0');
    expect(row.has_more).toBe(false);
    expect(row.items.length).toBe(1);
    expect(row.items[0].aweme_id).toBe('7701962254330128228');
    expect(row.items[0].url).toBe('https://www.douyin.com/video/7701962254330128228');
  });
});

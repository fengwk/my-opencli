import { describe, expect, it, vi } from 'vitest';
import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@jackwener/opencli/errors';
import { fetchAwemeDetailFromPage } from '../src/page-fetch.js';

function mockBrowserPage(evaluateResult) {
  return {
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async () => evaluateResult),
  };
}

describe('douyin-ext page-fetch (in-page read-only detail fetch)', () => {
  const targetId = '7701962254330128228';

  // Test intent: Verify successful detail fetch when aweme_id strictly matches
  // and valid video metadata is returned.
  it('returns aweme_detail when aweme_id matches and video data is present', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 0,
        aweme_detail: {
          aweme_id: targetId,
          desc: 'Test video',
          video: {
            width: 1080,
            height: 1920,
            bit_rate: [],
          },
        },
      },
    });

    const detail = await fetchAwemeDetailFromPage(page, targetId);
    expect(detail.aweme_id).toBe(targetId);
    expect(page.goto).toHaveBeenCalledWith(`https://www.douyin.com/video/${targetId}`);
  });

  // Test intent: Reject response when aweme_id does not strictly match the requested ID,
  // preventing accidental mismatched downloads.
  it('throws CommandExecutionError when aweme_id does not match the requested ID', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 0,
        aweme_detail: {
          aweme_id: '9999999999999999999',
          desc: 'Wrong video',
          video: { width: 720, height: 1280 },
        },
      },
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      CommandExecutionError
    );
  });

  // Test intent: Verify typed EmptyResultError with login/removal guidance when aweme_detail is null/empty.
  it('throws EmptyResultError when detail payload is empty or video is deleted/restricted', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 0,
        aweme_detail: null,
      },
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      EmptyResultError
    );
  });

  // Test intent: Verify error handling when page returns non-JSON (e.g. anti-bot/login HTML wall).
  it('throws CommandExecutionError when detail API returns non-JSON', async () => {
    const page = mockBrowserPage({
      __kind: 'non_json',
      status: 200,
      snippet: '<html><body>Verification required</body></html>',
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      CommandExecutionError
    );
  });

  // Test intent: Enforce "only videos, no image collections (图集)" contract.
  it('rejects image collections (图集) with CommandExecutionError', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 0,
        aweme_detail: {
          aweme_id: targetId,
          desc: 'Image gallery post',
          images: [{ url_list: ['https://example.com/1.jpg'] }],
          video: { width: 0, height: 0 },
        },
      },
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      /image collection/i
    );
  });

  // Test intent: Ensure authentication-required response triggers AuthRequiredError.
  it('throws AuthRequiredError when API returns login/auth failure status code', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 401,
        status_msg: 'Login required to view this content',
      },
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      AuthRequiredError
    );
  });

  // Test intent: Reject when video object is completely missing from aweme_detail.
  it('throws CommandExecutionError when video metadata is missing', async () => {
    const page = mockBrowserPage({
      __kind: 'ok',
      data: {
        status_code: 0,
        aweme_detail: {
          aweme_id: targetId,
          desc: 'No video object',
        },
      },
    });

    await expect(fetchAwemeDetailFromPage(page, targetId)).rejects.toThrow(
      /video.*metadata.*missing|no video stream metadata found/i
    );
  });
});

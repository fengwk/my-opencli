import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import {
  buildPageFetchScript,
  extractVideoItem,
  fetchUserVideosPage,
} from '../src/user-videos-fetch.js';

function createMockPage(evaluations = []) {
  let callCount = 0;
  return {
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      const resp = evaluations[callCount] ?? evaluations[evaluations.length - 1];
      callCount += 1;
      if (typeof resp === 'function') {
        return resp();
      }
      return resp;
    }),
  };
}

describe('douyin-ext user-videos fetch (in-page PAGE_FETCH pagination primitive)', () => {
  const targetSecUid = 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU';

  // Test intent: Verify two-page cursor pagination progression with realistic live-evidence response structure.
  // Page 1 receives cursor "0" and returns 18 items with max_cursor "1789453816000".
  // Page 2 passes cursor "1789453816000" and receives 15 distinct items with next cursor "1784127963000".
  it('correctly passes cursor across two pages and extracts unique items without dropping rows', async () => {
    const page1Items = Array.from({ length: 18 }, (_, i) => ({
      aweme_id: `77019622543301282${String(i).padStart(2, '0')}`,
      desc: `Video ${i + 1}`,
      video: {
        duration: 15000,
        play_addr: { url_list: [`https://v26-web.douyinvod.com/video_${i}.mp4`] },
      },
      statistics: { digg_count: 100 + i },
      images: i === 0 ? [{ url_list: ['https://example.com/img.jpg'] }] : null,
    }));

    const page2Items = Array.from({ length: 15 }, (_, i) => ({
      aweme_id: `78019622543301282${String(i).padStart(2, '0')}`,
      desc: `Second page video ${i + 1}`,
      video: {
        duration: 20000,
        play_addr: { url_list: [`https://v26-web.douyinvod.com/video_p2_${i}.mp4`] },
      },
      statistics: { digg_count: 200 + i },
    }));

    const page = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 1,
          max_cursor: '1789453816000',
          aweme_list: page1Items,
        },
      },
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 1,
          max_cursor: '1784127963000',
          aweme_list: page2Items,
        },
      },
    ]);

    // Fetch page 1
    const p1 = await fetchUserVideosPage(page, {
      secUid: targetSecUid,
      cursor: '0',
      count: 20,
      commentLimit: 0,
    });
    expect(p1.sec_uid).toBe(targetSecUid);
    expect(p1.cursor).toBe('0');
    expect(p1.next_cursor).toBe('1789453816000');
    expect(p1.has_more).toBe(true);
    expect(p1.items.length).toBe(18);
    // Image collection flagged without dropping
    expect(p1.items[0].is_image).toBe(true);
    expect(p1.items[1].is_image).toBe(false);
    expect(p1.items[0].url).toBe(`https://www.douyin.com/video/${p1.items[0].aweme_id}`);

    // Fetch page 2 using p1's next_cursor
    const p2 = await fetchUserVideosPage(page, {
      secUid: targetSecUid,
      cursor: p1.next_cursor,
      count: 20,
      commentLimit: 0,
    });
    expect(p2.sec_uid).toBe(targetSecUid);
    expect(p2.cursor).toBe('1789453816000');
    expect(p2.next_cursor).toBe('1784127963000');
    expect(p2.has_more).toBe(true);
    expect(p2.items.length).toBe(15);

    // Verify all returned IDs across both pages are disjoint
    const p1Ids = new Set(p1.items.map((it) => it.aweme_id));
    const p2Ids = new Set(p2.items.map((it) => it.aweme_id));
    for (const id of p2Ids) {
      expect(p1Ids.has(id)).toBe(false);
    }
  });

  // Test intent: Support empty intermediate pages (has_more=true with advancing cursor)
  // and final empty pages (has_more=false) without throwing errors.
  it('handles empty final page and empty intermediate page with advancing cursor', async () => {
    // Case 1: Intermediate empty page with has_more=true and advanced cursor
    const intermediatePage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 1,
          max_cursor: '1785000000000',
          aweme_list: [],
        },
      },
    ]);
    const intermediateResult = await fetchUserVideosPage(intermediatePage, {
      secUid: targetSecUid,
      cursor: '1780000000000',
      count: 20,
      commentLimit: 0,
    });
    expect(intermediateResult.has_more).toBe(true);
    expect(intermediateResult.next_cursor).toBe('1785000000000');
    expect(intermediateResult.items).toEqual([]);

    // Case 2: Final terminal empty page with has_more=false
    const terminalPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [],
        },
      },
    ]);
    const terminalResult = await fetchUserVideosPage(terminalPage, {
      secUid: targetSecUid,
      cursor: '1785000000000',
      count: 20,
      commentLimit: 0,
    });
    expect(terminalResult.has_more).toBe(false);
    expect(terminalResult.next_cursor).toBe('0');
    expect(terminalResult.items).toEqual([]);
  });

  // Test intent: Guard against infinite cursor loops when has_more=true but cursor did not advance.
  it('throws typed CommandExecutionError when cursor loop is detected (has_more=true and next_cursor == input cursor)', async () => {
    const page = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 1,
          max_cursor: '1789453816000',
          aweme_list: [],
        },
      },
    ]);

    await expect(
      fetchUserVideosPage(page, {
        secUid: targetSecUid,
        cursor: '1789453816000', // same as max_cursor
        count: 20,
        commentLimit: 0,
      })
    ).rejects.toThrow(CommandExecutionError);
  });

  // Test intent: Disallow unsafe numeric types exceeding MAX_SAFE_INTEGER and malformed ID formats.
  it('rejects unsafe numbers exceeding MAX_SAFE_INTEGER and malformed aweme_id formats', async () => {
    // Unsafe numeric ID (> MAX_SAFE_INTEGER)
    const unsafePage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [
            {
              aweme_id: 99999999999999999, // > Number.MAX_SAFE_INTEGER
              desc: 'Unsafe numeric ID',
            },
          ],
        },
      },
    ]);
    await expect(
      fetchUserVideosPage(unsafePage, {
        secUid: targetSecUid,
        cursor: '0',
      })
    ).rejects.toThrow(CommandExecutionError);

    // Malformed ID string (not 16-20 digits)
    const malformedPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [
            {
              aweme_id: '12345',
              desc: 'Too short',
            },
          ],
        },
      },
    ]);
    await expect(
      fetchUserVideosPage(malformedPage, {
        secUid: targetSecUid,
        cursor: '0',
      })
    ).rejects.toThrow(CommandExecutionError);
  });

  // Test intent: Reject API responses with missing or invalid has_more or max_cursor.
  it('throws CommandExecutionError when has_more or max_cursor is missing or malformed', async () => {
    // Missing max_cursor
    const noCursorPage = createMockPage([
      {
        __kind: 'ok',
        data: { status_code: 0, has_more: 0, aweme_list: [] },
      },
    ]);
    await expect(
      fetchUserVideosPage(noCursorPage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(CommandExecutionError);

    // Invalid has_more format
    const badHasMorePage = createMockPage([
      {
        __kind: 'ok',
        data: { status_code: 0, has_more: 'unknown', max_cursor: '0', aweme_list: [] },
      },
    ]);
    await expect(
      fetchUserVideosPage(badHasMorePage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(CommandExecutionError);
  });

  // Test intent: Verify typed AuthRequiredError for permission errors and verification challenges (never treating risk control as empty page).
  it('throws AuthRequiredError when API returns auth/permission/captcha status code or message', async () => {
    const authPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 2004,
          status_msg: '访问频繁，请进行验证码验证',
        },
      },
    ]);
    await expect(
      fetchUserVideosPage(authPage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(AuthRequiredError);
  });

  // Test intent: Verify typed error when API returns non-JSON or empty response body.
  it('throws CommandExecutionError on non-JSON and EmptyResultError on empty response', async () => {
    const nonJsonPage = createMockPage([
      {
        __kind: 'non_json',
        status: 200,
      },
    ]);
    await expect(
      fetchUserVideosPage(nonJsonPage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(CommandExecutionError);

    const emptyPage = createMockPage([
      {
        __kind: 'empty',
        status: 200,
      },
    ]);
    await expect(
      fetchUserVideosPage(emptyPage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(EmptyResultError);
  });

  // Test intent: Verify commentLimit=0 skips comment fetching while commentLimit>0 sequentially fetches comments.
  it('skips comment fetching when commentLimit=0 and fetches sequentially when commentLimit>0', async () => {
    const testItems = [
      {
        aweme_id: '7701962254330128201',
        desc: 'Video 1',
        video: { duration: 10000 },
        statistics: { digg_count: 10 },
      },
      {
        aweme_id: '7701962254330128202',
        desc: 'Video 2',
        video: { duration: 12000 },
        statistics: { digg_count: 20 },
      },
    ];

    // Case 1: commentLimit=0 -> only 1 evaluate call (post API)
    const zeroCommentPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: testItems,
        },
      },
    ]);
    const zeroResult = await fetchUserVideosPage(zeroCommentPage, {
      secUid: targetSecUid,
      cursor: '0',
      commentLimit: 0,
    });
    expect(zeroResult.items[0].top_comments).toEqual([]);
    expect(zeroResult.items[1].top_comments).toEqual([]);
    expect(zeroCommentPage.evaluate).toHaveBeenCalledTimes(1);

    // Case 2: commentLimit=2 -> 1 post API call + 2 sequential comment API calls
    const activeCommentPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: testItems,
        },
      },
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          comments: [
            { text: 'Great video', digg_count: 5, user: { nickname: 'UserA' } },
            { text: 'Nice!', digg_count: 2, user: { nickname: 'UserB' } },
          ],
        },
      },
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          comments: [
            { text: 'Awesome', digg_count: 8, user: { nickname: 'UserC' } },
          ],
        },
      },
    ]);
    const activeResult = await fetchUserVideosPage(activeCommentPage, {
      secUid: targetSecUid,
      cursor: '0',
      commentLimit: 2,
    });
    expect(activeCommentPage.evaluate).toHaveBeenCalledTimes(3);
    expect(activeResult.items[0].top_comments.length).toBe(2);
    expect(activeResult.items[0].top_comments[0].text).toBe('Great video');
    expect(activeResult.items[1].top_comments.length).toBe(1);
    expect(activeResult.items[1].top_comments[0].text).toBe('Awesome');
  });

  // Test intent: Verify deadline timeout handling before navigation and on browser fetch abort.
  it('throws TimeoutError when deadline is exceeded before navigation or fetch aborts', async () => {
    const page = createMockPage();
    // Timeout before navigation
    await expect(
      fetchUserVideosPage(page, {
        secUid: targetSecUid,
        cursor: '0',
        timeoutMs: -1,
      })
    ).rejects.toThrow(TimeoutError);

    // Timeout via browser fetch abort signal
    const abortPage = createMockPage([
      {
        __kind: 'abort',
      },
    ]);
    await expect(
      fetchUserVideosPage(abortPage, {
        secUid: targetSecUid,
        cursor: '0',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(TimeoutError);
  });

  // Test intent: Verify HTTP 401 with empty response body throws AuthRequiredError,
  // ensuring unauthorized responses are never masked as empty results.
  it('throws AuthRequiredError on HTTP 401 even when body is completely empty', async () => {
    const authEmptyPage = createMockPage([
      {
        __kind: 'http_error',
        status: 401,
        msg: 'HTTP 401',
      },
    ]);
    await expect(
      fetchUserVideosPage(authEmptyPage, { secUid: targetSecUid, cursor: '0' })
    ).rejects.toThrow(AuthRequiredError);
  });

  // Test intent: Ensure comments API returning HTTP 200 with empty body throws EmptyResultError rather than 0 comments.
  it('throws EmptyResultError when comments API returns empty body, rejecting silent 0 comments', async () => {
    const emptyCommentPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [
            {
              aweme_id: '7701962254330128201',
              desc: 'Video 1',
              video: { duration: 10000 },
            },
          ],
        },
      },
      {
        __kind: 'empty',
        status: 200,
      },
    ]);
    await expect(
      fetchUserVideosPage(emptyCommentPage, {
        secUid: targetSecUid,
        cursor: '0',
        commentLimit: 1,
      })
    ).rejects.toThrow(EmptyResultError);
  });

  // Test intent: Reject corrupted comments response where comments field is not an array.
  it('throws CommandExecutionError when comments payload contains non-array comments field', async () => {
    const corruptCommentPage = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: [
            {
              aweme_id: '7701962254330128201',
              desc: 'Video 1',
              video: { duration: 10000 },
            },
          ],
        },
      },
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          comments: 'invalid_non_array',
        },
      },
    ]);
    await expect(
      fetchUserVideosPage(corruptCommentPage, {
        secUid: targetSecUid,
        cursor: '0',
        commentLimit: 1,
      })
    ).rejects.toThrow(CommandExecutionError);
  });

  // Test intent: Execute actual generated in-page fetch script inside a Node VM sandbox
  // to verify real browser runtime behavior (URL search params, HTTP 401 empty body handling, and abort handling).
  it('executes in-page fetch script inside VM to verify posts/comments parameters, HTTP 401 empty body, and abort', async () => {
    // 1. Verify posts query construction and HTTP 401 empty body evaluation
    const postsScript = buildPageFetchScript({
      path: '/aweme/v1/web/aweme/post/',
      query: { aid: '6383', sec_user_id: targetSecUid, max_cursor: '0', count: '20' },
      timeoutMs: 5000,
    });

    let capturedUrl = '';
    let capturedOptions = null;
    const vmSandbox401 = {
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn(async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: false,
          status: 401,
          text: async () => '', // empty body
        };
      }),
    };

    const res401 = await vm.runInNewContext(postsScript, vmSandbox401);
    expect(capturedUrl).toContain('/aweme/v1/web/aweme/post/?');
    expect(capturedUrl).toContain(`sec_user_id=${targetSecUid}`);
    expect(capturedUrl).toContain('max_cursor=0');
    expect(capturedOptions?.credentials).toBe('include');
    expect(res401).toEqual({
      __kind: 'http_error',
      status: 401,
      msg: 'HTTP 401',
    });

    // 2. Verify comments query construction and HTTP 200 JSON parsing
    const commentsScript = buildPageFetchScript({
      path: '/aweme/v1/web/comment/list/',
      query: { aid: '6383', aweme_id: '7701962254330128201', count: '5', cursor: '0' },
      timeoutMs: 5000,
    });

    let capturedCommentUrl = '';
    const vmSandbox200 = {
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn(async (url) => {
        capturedCommentUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status_code: 0, comments: [] }),
        };
      }),
    };

    const res200 = await vm.runInNewContext(commentsScript, vmSandbox200);
    expect(capturedCommentUrl).toContain('/aweme/v1/web/comment/list/?');
    expect(capturedCommentUrl).toContain('aweme_id=7701962254330128201');
    expect(res200).toEqual({
      __kind: 'ok',
      data: { status_code: 0, comments: [] },
    });

    // 3. Verify abort handling produces __kind: 'abort'
    const abortScript = buildPageFetchScript({
      path: '/aweme/v1/web/aweme/post/',
      query: { aid: '6383' },
      timeoutMs: 50,
    });

    const vmSandboxAbort = {
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn(async (_url, options) => {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    };

    const resAbort = await vm.runInNewContext(abortScript, vmSandboxAbort);
    expect(resAbort.__kind).toBe('abort');
  });
});

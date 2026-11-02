import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from './page-fetch.js';

export function isAuthLikeMessage(code, msg) {
  const text = String(msg ?? '');
  return (
    code === 401 ||
    code === 403 ||
    /login|cookie|auth|captcha|verify|forbidden|permission|risk|risk_control|登录|登陆|权限|验证|验证码|风控/i.test(
      text
    )
  );
}

/**
 * Build the in-page fetch script string for execution inside browser evaluate.
 * Preserves AbortController timeout and evaluates HTTP status before body handling.
 */
export function buildPageFetchScript({ path, query, timeoutMs }) {
  const fetchTimeout = Math.max(1, Math.floor(timeoutMs));
  return `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${fetchTimeout});
      try {
        const queryParams = new URLSearchParams(${JSON.stringify(query)});
        const url = 'https://www.douyin.com' + ${JSON.stringify(path)} + '?' + queryParams.toString();
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = 'HTTP ' + res.status;
          try {
            const errJson = JSON.parse(text);
            msg = errJson?.status_msg || errJson?.message || msg;
          } catch {}
          return { __kind: 'http_error', status: res.status, msg };
        }
        if (!text.trim()) {
          return { __kind: 'empty', status: res.status };
        }
        try {
          const json = JSON.parse(text);
          return { __kind: 'ok', data: json };
        } catch {
          return { __kind: 'non_json', status: res.status };
        }
      } catch (err) {
        const isAbort = err && (err.name === 'AbortError' || String(err).includes('AbortError'));
        return {
          __kind: isAbort ? 'abort' : 'fetch_error',
          message: String(err && err.message || err)
        };
      } finally {
        clearTimeout(timer);
      }
    })()
  `;
}

/**
 * Private helper to execute an in-page fetch and return parsed JSON data.
 * Validates HTTP status first, handles auth, empty, non-json, and status_code errors.
 */
async function fetchPageJson(page, { path, query, timeoutMs, context }) {
  if (timeoutMs <= 0) {
    throw new TimeoutError(`Douyin ${context} request timed out before calling API`);
  }

  const js = buildPageFetchScript({ path, query, timeoutMs });
  let evalRaw;
  try {
    evalRaw = await page.evaluate(js);
  } catch (err) {
    throw new CommandExecutionError(
      `In-page evaluate failed for ${context}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = unwrapEvaluateResult(evalRaw);
  if (!result || typeof result !== 'object') {
    throw new CommandExecutionError(`Malformed in-page evaluate response for ${context}`);
  }

  if (result.__kind === 'abort') {
    throw new TimeoutError(`Douyin ${context} request timed out (fetch aborted in browser)`);
  }

  if (result.__kind === 'fetch_error') {
    throw new CommandExecutionError(
      `In-page fetch request failed for ${context}: ${result.message}`
    );
  }

  if (result.__kind === 'http_error') {
    if (
      result.status === 401 ||
      result.status === 403 ||
      isAuthLikeMessage(result.status, result.msg)
    ) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin ${context} request requires authentication (HTTP ${result.status}): ${result.msg}`
      );
    }
    throw new CommandExecutionError(
      `Douyin ${context} API returned HTTP ${result.status}: ${result.msg}`
    );
  }

  if (result.__kind === 'empty') {
    throw new EmptyResultError(
      'douyin-ext',
      `Douyin ${context} endpoint returned empty body (HTTP ${result.status}). The page may require login, verification, or is restricted.`
    );
  }

  if (result.__kind === 'non_json') {
    throw new CommandExecutionError(
      `Douyin ${context} API returned non-JSON response (HTTP ${result.status}). The page may require login, verification, or is restricted.`
    );
  }

  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new CommandExecutionError(`Douyin ${context} returned invalid JSON`);
  }

  if ('status_code' in data && data.status_code !== 0) {
    const code = data.status_code;
    const msg = data.status_msg || data.message || 'unknown error';
    if (isAuthLikeMessage(code, msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin API authentication/permission error (${code}) on ${context}: ${msg}. Please check login state or verify in browser.`
      );
    }
    throw new CommandExecutionError(
      `Douyin API returned status_code ${code} on ${context}: ${msg}. Please check login status or verify in browser.`
    );
  }

  return data;
}

/**
 * Validate and extract aweme item fields safely without losing numeric precision.
 * Requires 16-20 digit string IDs, disallows unsafe number-to-string casts.
 */
export function extractVideoItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new CommandExecutionError('Invalid video item in API response: expected object');
  }

  const rawId = rawItem.aweme_id;
  let id;
  if (typeof rawId === 'number') {
    if (!Number.isSafeInteger(rawId) || rawId <= 0) {
      throw new CommandExecutionError(
        `Unsafe numeric aweme_id encountered in video item: ${rawId}. Cannot safely convert to string.`
      );
    }
    id = String(rawId);
  } else if (typeof rawId === 'string') {
    id = rawId.trim();
  } else {
    throw new CommandExecutionError('Missing or malformed aweme_id in video item');
  }

  if (!/^\d{16,20}$/.test(id)) {
    throw new CommandExecutionError(
      `Invalid aweme_id format: "${id}". Expected a 16-20 digit identifier.`
    );
  }

  const title = String(rawItem.desc || rawItem.title || '').trim();
  const duration =
    typeof rawItem.video?.duration === 'number'
      ? Math.round(rawItem.video.duration / 1000)
      : 0;
  const diggCount = Number(rawItem.statistics?.digg_count ?? 0);
  const playUrl = rawItem.video?.play_addr?.url_list?.[0] ?? '';
  const isImage = Boolean(
    rawItem.images && Array.isArray(rawItem.images) && rawItem.images.length > 0
  );
  const url = `https://www.douyin.com/video/${id}`;

  return {
    aweme_id: id,
    title,
    duration,
    digg_count: diggCount,
    play_url: playUrl,
    top_comments: [],
    url,
    is_image: isImage,
  };
}

/**
 * Fetch top comments for a single aweme in page context within remaining timeout budget.
 */
async function fetchAwemeCommentsFromPage(page, awemeId, count, remainingTimeoutMs) {
  const data = await fetchPageJson(page, {
    path: '/aweme/v1/web/comment/list/',
    query: {
      aid: '6383',
      aweme_id: awemeId,
      count: String(count),
      cursor: '0',
    },
    timeoutMs: remainingTimeoutMs,
    context: `comments of video ${awemeId}`,
  });

  if (data.comments != null && !Array.isArray(data.comments)) {
    throw new CommandExecutionError(
      `Invalid comments type in API response for video ${awemeId}: expected array`
    );
  }

  const comments = Array.isArray(data.comments) ? data.comments : [];
  return comments.slice(0, count).map((c) => ({
    text: String(c.text ?? ''),
    digg_count: Number(c.digg_count ?? 0),
    nickname: String(c.user?.nickname ?? ''),
  }));
}

/**
 * Fetch a single page of user videos via in-page PAGE_FETCH.
 * Strictly read-only, does not mutate DOM or click elements.
 */
export async function fetchUserVideosPage(
  page,
  {
    secUid,
    cursor = '0',
    count = 20,
    commentLimit = 0,
    timeoutMs = 60000,
    waitTime = 2.0,
  } = {}
) {
  const overallDeadline = Date.now() + timeoutMs;
  const getRemainingMs = () => overallDeadline - Date.now();

  if (getRemainingMs() <= 0) {
    throw new TimeoutError('Douyin user-videos request timed out before navigation');
  }

  const userPageUrl = `https://www.douyin.com/user/${secUid}`;
  try {
    await page.goto(userPageUrl);
  } catch (err) {
    throw new CommandExecutionError(
      `Failed to navigate to Douyin user page: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const remAfterGoto = getRemainingMs();
  if (remAfterGoto <= 0) {
    throw new TimeoutError('Douyin user-videos request timed out after page navigation');
  }

  // Bound wait by remaining budget
  const actualWaitTime = Math.min(waitTime, Math.max(0, remAfterGoto / 1000));
  if (actualWaitTime > 0) {
    if (typeof page.wait === 'function') {
      await page.wait({ time: actualWaitTime });
    } else if (typeof page.sleep === 'function') {
      await page.sleep(actualWaitTime);
    }
  }

  const remAfterWait = getRemainingMs();
  if (remAfterWait <= 0) {
    throw new TimeoutError('Douyin user-videos request timed out waiting for page stability');
  }

  const data = await fetchPageJson(page, {
    path: '/aweme/v1/web/aweme/post/',
    query: {
      aid: '6383',
      sec_user_id: secUid,
      max_cursor: cursor,
      count: String(count),
    },
    timeoutMs: remAfterWait,
    context: `user videos (${secUid})`,
  });

  // Validate next_cursor (from max_cursor)
  if (data.max_cursor == null) {
    throw new CommandExecutionError(
      `Missing max_cursor in Douyin post API response for user ${secUid}`
    );
  }

  let nextCursor;
  if (typeof data.max_cursor === 'number') {
    if (!Number.isSafeInteger(data.max_cursor) || data.max_cursor < 0) {
      throw new CommandExecutionError(
        `Unsafe or negative numeric max_cursor encountered: ${data.max_cursor}. Cannot safely convert to string.`
      );
    }
    nextCursor = String(data.max_cursor);
  } else if (typeof data.max_cursor === 'string') {
    nextCursor = data.max_cursor.trim();
    if (!/^\d+$/.test(nextCursor)) {
      throw new CommandExecutionError(
        `Invalid non-numeric max_cursor returned by API: "${data.max_cursor}"`
      );
    }
  } else {
    throw new CommandExecutionError(
      `Malformed max_cursor type: expected string or safe integer, received ${typeof data.max_cursor}`
    );
  }

  // Validate has_more
  if (data.has_more == null) {
    throw new CommandExecutionError(
      `Missing has_more in Douyin post API response for user ${secUid}`
    );
  }

  let hasMore;
  if (data.has_more === 1 || data.has_more === true) {
    hasMore = true;
  } else if (data.has_more === 0 || data.has_more === false) {
    hasMore = false;
  } else {
    throw new CommandExecutionError(
      `Invalid has_more shape returned by API: ${JSON.stringify(data.has_more)}. Expected 0, 1, false, or true.`
    );
  }

  // Cursor loop check: has_more=true but next_cursor equals input cursor must throw typed error
  if (hasMore && nextCursor === cursor) {
    throw new CommandExecutionError(
      `Cursor loop detected for user ${secUid}: has_more is true but next_cursor equals input cursor "${cursor}". Halting to prevent infinite loop.`
    );
  }

  // Validate aweme_list
  const rawList = data.aweme_list;
  if (rawList != null && !Array.isArray(rawList)) {
    throw new CommandExecutionError(
      `Invalid aweme_list type in API response for user ${secUid}: expected array but received ${typeof rawList}`
    );
  }

  const list = Array.isArray(rawList) ? rawList : [];

  // Parse items without dropping rows or slicing
  const items = list.map((item) => extractVideoItem(item));

  // Fetch comments sequentially if commentLimit > 0
  if (commentLimit > 0 && items.length > 0) {
    for (const item of items) {
      const remaining = getRemainingMs();
      if (remaining <= 0) {
        throw new TimeoutError(
          `Operation exceeded overall timeout while fetching comments for video ${item.aweme_id}`
        );
      }
      item.top_comments = await fetchAwemeCommentsFromPage(
        page,
        item.aweme_id,
        commentLimit,
        remaining
      );
    }
  }

  // Enforce overall timeout budget before returning
  if (getRemainingMs() <= 0) {
    throw new TimeoutError('Douyin user-videos request exceeded overall timeout budget');
  }

  return {
    sec_uid: secUid,
    cursor,
    next_cursor: nextCursor,
    has_more: hasMore,
    items,
  };
}

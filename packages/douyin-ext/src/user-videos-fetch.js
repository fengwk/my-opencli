import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@jackwener/opencli/errors';

export function unwrapEvaluateResult(payload) {
  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'session' in payload &&
    'data' in payload
  ) {
    return payload.data;
  }
  return payload;
}

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
export async function fetchAwemeCommentsFromPage(
  page,
  awemeId,
  count,
  remainingTimeoutMs
) {
  if (remainingTimeoutMs <= 0) {
    throw new TimeoutError(
      `Douyin comment request timed out before calling comment API for video ${awemeId}`
    );
  }

  const fetchTimeout = Math.max(1, Math.floor(remainingTimeoutMs));
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${fetchTimeout});
      try {
        const query = new URLSearchParams({
          aid: '6383',
          aweme_id: ${JSON.stringify(awemeId)},
          count: ${JSON.stringify(String(count))},
          cursor: '0'
        });
        const url = 'https://www.douyin.com/aweme/v1/web/comment/list/?' + query.toString();
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        const text = await res.text();
        if (!text.trim()) {
          return { __kind: 'empty', status: res.status };
        }
        try {
          const json = JSON.parse(text);
          if (!res.ok) {
            return {
              __kind: 'http_error',
              status: res.status,
              msg: json?.status_msg || json?.message || 'HTTP ' + res.status
            };
          }
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

  let evalRaw;
  try {
    evalRaw = await page.evaluate(js);
  } catch (err) {
    throw new CommandExecutionError(
      `In-page evaluate failed for comments of video ${awemeId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = unwrapEvaluateResult(evalRaw);
  if (!result || typeof result !== 'object') {
    throw new CommandExecutionError(
      `Malformed in-page evaluate response for comments of video ${awemeId}`
    );
  }

  if (result.__kind === 'abort') {
    throw new TimeoutError(
      `Douyin comment API fetch timed out for video ${awemeId} (aborted in browser)`
    );
  }

  if (result.__kind === 'fetch_error') {
    throw new CommandExecutionError(
      `In-page fetch request failed for comments of video ${awemeId}: ${result.message}`
    );
  }

  if (result.__kind === 'non_json') {
    throw new CommandExecutionError(
      `Douyin comment API returned non-JSON response for video ${awemeId} (HTTP ${result.status})`
    );
  }

  if (result.__kind === 'empty') {
    return [];
  }

  if (result.__kind === 'http_error') {
    if (isAuthLikeMessage(result.status, result.msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin comment request requires authentication (HTTP ${result.status}): ${result.msg}`
      );
    }
    throw new CommandExecutionError(
      `Douyin comment API returned HTTP ${result.status} for video ${awemeId}: ${result.msg}`
    );
  }

  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new CommandExecutionError(
      `Douyin comment API returned invalid JSON for video ${awemeId}`
    );
  }

  if ('status_code' in data && data.status_code !== 0) {
    const code = data.status_code;
    const msg = data.status_msg || data.message || 'unknown error';
    if (isAuthLikeMessage(code, msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin API authentication/permission error (${code}) on comments for video ${awemeId}: ${msg}`
      );
    }
    throw new CommandExecutionError(
      `Douyin comment API returned status_code ${code} for video ${awemeId}: ${msg}`
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

  const fetchTimeout = Math.max(1, Math.floor(remAfterWait));
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${fetchTimeout});
      try {
        const query = new URLSearchParams({
          aid: '6383',
          sec_user_id: ${JSON.stringify(secUid)},
          max_cursor: ${JSON.stringify(cursor)},
          count: ${JSON.stringify(String(count))}
        });
        const url = 'https://www.douyin.com/aweme/v1/web/aweme/post/?' + query.toString();
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        const text = await res.text();
        if (!text.trim()) {
          return { __kind: 'empty', status: res.status };
        }
        try {
          const json = JSON.parse(text);
          if (!res.ok) {
            return {
              __kind: 'http_error',
              status: res.status,
              msg: json?.status_msg || json?.message || 'HTTP ' + res.status
            };
          }
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

  let evalRaw;
  try {
    evalRaw = await page.evaluate(js);
  } catch (err) {
    throw new CommandExecutionError(
      `In-page evaluate failed for user ${secUid}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = unwrapEvaluateResult(evalRaw);
  if (!result || typeof result !== 'object') {
    throw new CommandExecutionError(`Malformed in-page evaluate response for user ${secUid}`);
  }

  if (result.__kind === 'abort') {
    throw new TimeoutError('Douyin user-videos request timed out (fetch aborted in browser)');
  }

  if (result.__kind === 'fetch_error') {
    throw new CommandExecutionError(
      `In-page fetch request failed for user ${secUid}: ${result.message}`
    );
  }

  if (result.__kind === 'non_json') {
    throw new CommandExecutionError(
      `Douyin post API returned non-JSON response for user ${secUid} (HTTP ${result.status}). The page may require login, verification, or is restricted.`
    );
  }

  if (result.__kind === 'empty') {
    throw new EmptyResultError(
      'douyin-ext',
      `Douyin post endpoint returned empty body for user ${secUid} (HTTP ${result.status}). User may be restricted or requires login verification.`
    );
  }

  if (result.__kind === 'http_error') {
    if (isAuthLikeMessage(result.status, result.msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin post request requires authentication (HTTP ${result.status}): ${result.msg}`
      );
    }
    throw new CommandExecutionError(`Douyin post API returned HTTP ${result.status}: ${result.msg}`);
  }

  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new CommandExecutionError(`Douyin post returned invalid JSON for user ${secUid}`);
  }

  if ('status_code' in data && data.status_code !== 0) {
    const code = data.status_code;
    const msg = data.status_msg || data.message || 'unknown error';
    if (isAuthLikeMessage(code, msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin API authentication/permission error (${code}): ${msg}. Please check login state or verify in browser.`
      );
    }
    throw new CommandExecutionError(
      `Douyin API returned status_code ${code} for user ${secUid}: ${msg}. Please check login status or verify in browser.`
    );
  }

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

  return {
    sec_uid: secUid,
    cursor,
    next_cursor: nextCursor,
    has_more: hasMore,
    items,
  };
}

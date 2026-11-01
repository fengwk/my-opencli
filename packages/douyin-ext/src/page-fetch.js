import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
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

function isAuthLikeMessage(code, msg) {
  const text = String(msg ?? '');
  return (
    code === 401 ||
    code === 403 ||
    /login|cookie|auth|captcha|verify|forbidden|permission|登录|登陆|权限|验证|验证码/i.test(text)
  );
}

/**
 * Fetch aweme video detail from within the page context.
 *
 * Runs a read-only fetch against /aweme/v1/web/aweme/detail/ with credentials: 'include'.
 * Does not mutate the DOM or click any elements.
 */
export async function fetchAwemeDetailFromPage(page, id, { timeoutMs = 30000, waitTime = 2.5 } = {}) {
  // Step 1: Navigate to the official video page
  const videoPageUrl = `https://www.douyin.com/video/${id}`;
  try {
    await page.goto(videoPageUrl);
  } catch (err) {
    throw new CommandExecutionError(
      `Failed to navigate to Douyin video page (${videoPageUrl}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Step 2: Bounded wait for page readiness
  if (typeof page.wait === 'function') {
    await page.wait({ time: waitTime });
  } else if (typeof page.sleep === 'function') {
    await page.sleep(Math.round(waitTime * 1000));
  }

  // Step 3: Read-only in-page fetch using safely serialized parameters
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${Number(timeoutMs)});
      try {
        const query = new URLSearchParams({
          aid: '6383',
          aweme_id: ${JSON.stringify(id)}
        });
        const url = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + query.toString();
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json'
          }
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
              msg: json?.status_msg || json?.message || 'HTTP error ' + res.status
            };
          }
          return { __kind: 'ok', data: json };
        } catch (parseErr) {
          return {
            __kind: 'non_json',
            status: res.status,
            snippet: text.slice(0, 300)
          };
        }
      } catch (fetchErr) {
        return {
          __kind: 'fetch_error',
          message: String(fetchErr && fetchErr.message || fetchErr)
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
      `In-page evaluate failed for Douyin detail (${id}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = unwrapEvaluateResult(evalRaw);
  if (!result || typeof result !== 'object') {
    throw new CommandExecutionError(
      `Malformed in-page evaluate response for video ${id}`
    );
  }

  if (result.__kind === 'fetch_error') {
    throw new CommandExecutionError(
      `In-page fetch request failed for video ${id}: ${result.message}`
    );
  }

  if (result.__kind === 'non_json') {
    throw new CommandExecutionError(
      `Douyin detail API returned non-JSON response for video ${id} (HTTP ${result.status}). The page may require login, verification, or is blocked: ${result.snippet}`
    );
  }

  if (result.__kind === 'empty') {
    throw new EmptyResultError(
      'douyin-ext',
      `Douyin detail endpoint returned an empty body for video ${id} (HTTP ${result.status}). Video may be restricted, deleted, or requires login verification.`
    );
  }

  if (result.__kind === 'http_error') {
    if (isAuthLikeMessage(result.status, result.msg)) {
      throw new AuthRequiredError(
        'www.douyin.com',
        `Douyin detail request requires authentication (HTTP ${result.status}): ${result.msg}`
      );
    }
    throw new CommandExecutionError(
      `Douyin detail API returned HTTP ${result.status}: ${result.msg}`
    );
  }

  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new CommandExecutionError(`Douyin detail returned invalid JSON for video ${id}`);
  }

  // Check API status_code
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
      `Douyin API returned status_code ${code} for video ${id}: ${msg}. Please check login status or verify in browser.`
    );
  }

  const detail = data.aweme_detail;
  if (!detail) {
    throw new EmptyResultError(
      'douyin-ext',
      `Video ${id} returned no detail payload. The video may be deleted, private, restricted, or requires an active login session.`
    );
  }

  if (typeof detail !== 'object' || Array.isArray(detail)) {
    throw new CommandExecutionError(`Invalid aweme_detail payload for video ${id}`);
  }

  // Strict aweme_id equality check
  if (String(detail.aweme_id) !== String(id)) {
    throw new CommandExecutionError(
      `Detail aweme_id mismatch: requested ${id}, received ${detail.aweme_id}`
    );
  }

  // Reject image collections (图集)
  if (detail.images && Array.isArray(detail.images) && detail.images.length > 0) {
    throw new CommandExecutionError(
      `Target ${id} is an image collection (图集, ${detail.images.length} images). douyin-ext download only supports videos.`
    );
  }

  // Ensure video object exists
  if (!detail.video || typeof detail.video !== 'object') {
    throw new CommandExecutionError(
      `No video stream metadata found for ${id}. Video may be unavailable or unplayable.`
    );
  }

  return detail;
}

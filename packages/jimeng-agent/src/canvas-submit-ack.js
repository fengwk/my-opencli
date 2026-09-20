/**
 * Canvas Agent submit ACK classification for known Jimeng conversation paths.
 *
 * JSON response success contract:
 *   response is a JSON object with numeric `code === 0`.
 * The request must include the canonical `资产编号：<assetId>` marker.
 */

import {
  classifyConversationEntry,
  normalizeCaptureEntry,
  requestBodyMatchesAssetId,
} from './submit-ack.js';

export const JIMENG_CANVAS_SEND_PATH = '/octo_api/v1/canvas_agent/messages/send';
export const JIMENG_CONVERSATION_PATH = '/mweb/v1/creation_agent/v2/conversation';
export const JIMENG_CANVAS_SEND_HOST = 'jimeng.jianying.com';
// OpenCLI treats this as a literal URL substring, not a regular expression.
export const JIMENG_CANVAS_CAPTURE_PATTERN = `${JIMENG_CANVAS_SEND_HOST}/`;

export function isCanvasSendUrl(url) {
  if (!url) return false;
  const urlStr = String(url).trim();
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443')) return false;
    if (parsed.hostname.toLowerCase() !== JIMENG_CANVAS_SEND_HOST) return false;
    return (
      parsed.pathname === JIMENG_CANVAS_SEND_PATH
      || parsed.pathname === JIMENG_CONVERSATION_PATH
      || /^\/octo_api\/v1\/canvas_agent\/messages\/(?:send|stream|send_stream)$/.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function parseJsonBody(raw) {
  if (raw == null) return { present: false, ok: false, value: null };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { present: true, ok: true, value: raw };
  }
  if (typeof raw !== 'string') {
    return { present: true, ok: false, value: null };
  }
  const text = raw.trim();
  if (!text) return { present: false, ok: false, value: null };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { present: true, ok: false, value: null };
    }
    return { present: true, ok: true, value };
  } catch {
    return { present: true, ok: false, value: null };
  }
}

export function extractCanvasSessionId(rawBody) {
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok || !parsed.value) return '';
  const candidates = [
    parsed.value.session_id,
    parsed.value.sessionId,
    parsed.value.data?.session_id,
    parsed.value.data?.sessionId,
    parsed.value.session?.session_id,
    parsed.value.session?.id,
    parsed.value.data?.session?.session_id,
    parsed.value.data?.session?.id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return '';
}

export function classifyCanvasSendEntry(rawEntry, assetId) {
  const entry = normalizeCaptureEntry(rawEntry);
  if (!isCanvasSendUrl(entry.url)) {
    return { kind: 'ignored', matches: false, isEndpoint: false, entry };
  }
  if (entry.method && entry.method !== 'POST') {
    return { kind: 'ignored', matches: false, isEndpoint: false, entry };
  }
  if (!entry.method) {
    return {
      kind: 'unconfirmed',
      matches: false,
      isEndpoint: true,
      entry,
      reason: 'canvas send request method was unavailable',
    };
  }
  const matches = requestBodyMatchesAssetId(rawEntry, assetId);
  if (entry.requestBodyTruncated) {
    return {
      kind: 'unconfirmed',
      matches,
      isEndpoint: true,
      entry,
      reason: 'request body truncated',
    };
  }
  if (!matches) {
    return {
      kind: 'unrelated',
      matches: false,
      isEndpoint: true,
      entry,
      sessionId: extractCanvasSessionId(entry.requestBody) || extractCanvasSessionId(entry.responseBody),
    };
  }
  let pathname = '';
  try {
    pathname = new URL(entry.url).pathname;
  } catch {
    // URL validity was checked by isCanvasSendUrl above.
  }
  const parsedResponse = parseJsonBody(entry.responseBody);
  if (
    pathname === JIMENG_CONVERSATION_PATH
    && !(parsedResponse.ok && typeof parsedResponse.value?.code === 'number')
  ) {
    const conversation = classifyConversationEntry(rawEntry, assetId);
    return {
      ...conversation,
      isEndpoint: true,
      sessionId: conversation.conversationId || conversation.threadId || '',
    };
  }
  if (entry.status == null) {
    return {
      kind: 'pending',
      matches: true,
      isEndpoint: true,
      entry,
      reason: 'response status missing',
    };
  }
  if (entry.status < 200 || entry.status >= 300) {
    return {
      kind: 'rejected',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      errorCode: parsedResponse.value?.code ?? entry.status,
      errorMsg: parsedResponse.value?.message || parsedResponse.value?.errmsg || `HTTP ${entry.status}`,
    };
  }
  if (entry.responseBodyTruncated) {
    return {
      kind: 'unconfirmed',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      reason: 'response body truncated',
    };
  }
  if (!parsedResponse.present) {
    return {
      kind: 'unconfirmed',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      reason: 'empty send response body',
    };
  }
  if (!parsedResponse.ok) {
    return {
      kind: 'unconfirmed',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      reason: 'send response was not JSON object',
    };
  }
  const code = parsedResponse.value.code;
  if (typeof code !== 'number' || !Number.isFinite(code)) {
    return {
      kind: 'unconfirmed',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      reason: 'response.code missing or not a number',
    };
  }
  if (code !== 0) {
    return {
      kind: 'rejected',
      matches: true,
      isEndpoint: true,
      entry,
      httpStatus: entry.status,
      errorCode: code,
      errorMsg: parsedResponse.value.message || parsedResponse.value.errmsg || `code ${code}`,
      sessionId: extractCanvasSessionId(parsedResponse.value) || extractCanvasSessionId(entry.requestBody),
    };
  }
  return {
    kind: 'confirmed',
    matches: true,
    isEndpoint: true,
    entry,
    httpStatus: entry.status,
    sessionId: extractCanvasSessionId(parsedResponse.value) || extractCanvasSessionId(entry.requestBody),
  };
}

export function classifyCanvasSubmitAck({
  entries = [],
  assetId,
  timedOut = false,
  captureError = null,
} = {}) {
  if (captureError) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
      nonRetryable: true,
      reason: `Capture error: ${captureError.message || captureError}`,
    };
  }
  if (!Array.isArray(entries)) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
      nonRetryable: true,
      reason: 'Network capture result was not an array',
    };
  }

  const normalized = entries.map(normalizeCaptureEntry);
  const malformed = normalized.filter((entry) => entry.captureMalformed);
  const classified = normalized.map((entry) => classifyCanvasSendEntry(entry, assetId));
  const endpointEntries = classified.filter((item) => item.isEndpoint);
  const matching = classified.filter((item) => item.matches);

  if (malformed.length > 0) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: matching.length,
      endpointRequestCount: endpointEntries.length,
      malformedCaptureEntryCount: malformed.length,
      nonRetryable: true,
      reason: 'Network capture contained malformed entries without a usable URL',
    };
  }

  if (matching.length > 0) {
    const confirmed = matching.filter((item) => item.kind === 'confirmed');
    const rejected = matching.filter((item) => item.kind === 'rejected');
    const pending = matching.filter((item) => item.kind === 'pending');
    const unconfirmed = matching.filter((item) => item.kind === 'unconfirmed');

    if (confirmed.length === 1 && rejected.length === 0 && pending.length === 0 && unconfirmed.length === 0) {
      return {
        kind: 'confirmed',
        status: 'ack_confirmed',
        matchingRequestCount: matching.length,
        endpointRequestCount: endpointEntries.length,
        sessionId: confirmed[0].sessionId || '',
        nonRetryable: false,
      };
    }
    if (rejected.length > 0 && confirmed.length === 0) {
      const first = rejected[0];
      return {
        kind: 'rejected',
        status: 'rejected',
        matchingRequestCount: matching.length,
        endpointRequestCount: endpointEntries.length,
        errorCode: first.errorCode,
        errorMsg: first.errorMsg,
        httpStatus: first.httpStatus,
        nonRetryable: true,
        reason: first.errorMsg || 'server rejected canvas send',
      };
    }
    if (pending.length > 0 && !timedOut && confirmed.length === 0 && rejected.length === 0) {
      return {
        kind: 'pending',
        status: 'pending',
        matchingRequestCount: matching.length,
        endpointRequestCount: endpointEntries.length,
        nonRetryable: true,
        reason: 'canvas send request is still pending',
      };
    }
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: matching.length,
      endpointRequestCount: endpointEntries.length,
      sessionId: confirmed[0]?.sessionId || rejected[0]?.sessionId || '',
      nonRetryable: true,
      reason: timedOut
        ? 'canvas send request was observed but ACK could not be confirmed before timeout'
        : 'canvas send ACK was mixed or incomplete',
    };
  }

  if (endpointEntries.length > 0) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: endpointEntries.length,
      nonRetryable: true,
      reason: 'canvas send requests were captured but none contained the canonical assetId',
    };
  }

  return {
    kind: 'not_sent',
    status: 'not_sent',
    matchingRequestCount: 0,
    endpointRequestCount: 0,
    nonRetryable: false,
    reason: 'no canvas send request was captured',
  };
}

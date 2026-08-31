/**
 * Jimeng Agent submit ACK validation and SSE protocol parser.
 *
 * Pure classification and parsing module for conversation submit requests.
 *
 * Responsibilities:
 * - Match POST https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation requests
 * - Normalize OpenCLI capture entries (responseStatus, requestBodyPreview, responsePreview, responseBodyTruncated)
 * - Correlate requests with the unique canonical assetId
 * - Parse and validate SSE stream (id:, retry:, handshake + stream_complete, trailer envelopes)
 * - Classify submit outcomes: confirmed, rejected, unconfirmed, not_sent, pending
 */

export const JIMENG_CONVERSATION_PATH = '/mweb/v1/creation_agent/v2/conversation';
export const JIMENG_CONVERSATION_HOST = 'jimeng.jianying.com';
export const TELEMETRY_URL_PATTERN = /mcs\.zijieapi\.com|click_agent_generate|agent_message_action/i;

function parseIntegerField(value) {
  if (value === undefined || value === null) {
    return { present: false, valid: false, value: null };
  }
  if (typeof value === 'number') {
    return {
      present: true,
      valid: Number.isSafeInteger(value),
      value: Number.isSafeInteger(value) ? value : null,
    };
  }
  if (typeof value !== 'string') {
    return { present: true, valid: false, value: null };
  }
  const text = value.trim();
  if (!text) return { present: false, valid: false, value: null };
  if (!/^-?\d+$/.test(text)) {
    return { present: true, valid: false, value: null };
  }
  const parsed = Number(text);
  return {
    present: true,
    valid: Number.isSafeInteger(parsed),
    value: Number.isSafeInteger(parsed) ? parsed : null,
  };
}

function normalizeProtocolIdentifier(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return '';
}

function isMalformedProtocolIdentifier(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'string') return false;
  return !(typeof value === 'number' && Number.isSafeInteger(value));
}

function parsedValueContainsMarker(root, marker) {
  const stack = [root];
  const seen = new Set();
  let visited = 0;
  while (stack.length > 0 && visited < 100_000) {
    const value = stack.pop();
    visited += 1;
    if (typeof value === 'string') {
      if (value.includes(marker)) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
    } else {
      stack.push(...Object.values(value));
    }
  }
  return false;
}

/**
 * Normalize OpenCLI captured network entry fields into a canonical shape.
 * Handles:
 * - request body: requestBodyPreview, requestBody, postData
 * - response body: responsePreview, responseBody
 * - status: responseStatus, status, statusCode, httpStatus (null if missing!)
 * - truncation: responseBodyTruncated, truncated, requestBodyTruncated
 *
 * @param {object} entry
 * @returns {{
 *   url: string,
 *   method: string,
 *   status: number | null,
 *   requestBody: any,
 *   responseBody: any,
 *   responseBodyTruncated: boolean,
 *   requestBodyTruncated: boolean,
 *   captureMalformed: boolean,
 *   raw: object
 * }}
 */
export function normalizeCaptureEntry(entry) {
  const structurallyValid = Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
  const source = structurallyValid ? entry : {};
  const url = String(source.url ?? source.request?.url ?? '').trim();
  const method = String(source.method ?? source.requestMethod ?? source.request?.method ?? '')
    .trim()
    .toUpperCase();

  const rawStatus = (
    source.responseStatus
    ?? source.status
    ?? source.statusCode
    ?? source.httpStatus
    ?? source.response?.status
  );
  let status = null;
  const parsedStatus = parseIntegerField(rawStatus);
  if (parsedStatus.valid && parsedStatus.value > 0) status = parsedStatus.value;

  const requestBody = (
    source.requestBodyPreview
    ?? source.requestBody
    ?? source.postData
    ?? source.request?.postData
    ?? source.request?.body
    ?? null
  );

  const responseBody = (
    source.responsePreview
    ?? source.responseBody
    ?? source.response?.body
    ?? null
  );

  const responseBodyTruncated = Boolean(
    source.responseBodyTruncated
    || source.truncated
    || source.response?.bodyTruncated,
  );
  const requestBodyTruncated = Boolean(
    source.requestBodyTruncated
    || source.postDataTruncated
    || source.request?.bodyTruncated,
  );

  return {
    url,
    method,
    status,
    requestBody,
    responseBody,
    responseBodyTruncated,
    requestBodyTruncated,
    captureMalformed: !structurallyValid || !url,
    raw: entry,
  };
}

/**
 * Parse raw SSE or JSON text into structured event objects.
 * Handles id:, retry:, event:, data:, and standalone JSON envelopes / trailers.
 *
 * @param {string|object} raw
 * @returns {Array<{ event: string, id: string, data: any, rawData: string }>}
 */
export function parseSseEvents(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'object') {
    return [{
      event: raw.event || raw.type || raw.event_type || 'message',
      id: '',
      data: raw,
      rawData: JSON.stringify(raw),
    }];
  }

  const text = String(raw).trim();
  if (!text) return [];

  const events = [];
  const lines = text.split(/\r\n|\r|\n/);
  let currentEvent = '';
  let currentId = '';
  let dataLines = [];

  const flushEvent = () => {
    if (currentEvent || dataLines.length > 0 || currentId) {
      const rawData = dataLines.join('\n');
      let data = rawData;
      if (rawData) {
        try {
          data = JSON.parse(rawData);
        } catch {
          data = rawData;
        }
      }
      events.push({
        event: currentEvent || 'message',
        id: currentId,
        data,
        rawData,
      });
      currentEvent = '';
      currentId = '';
      dataLines = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flushEvent();
      continue;
    }
    if (trimmed.startsWith(':')) {
      // SSE comment line
      continue;
    }
    if (line.startsWith('id:')) {
      currentId = line.slice('id:'.length).trim();
      continue;
    }
    if (line.startsWith('retry:')) {
      // SSE retry directive
      continue;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
      continue;
    }
    // Standalone JSON line / envelope / trailer (e.g. {"ret":"0","errmsg":"success"})
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        flushEvent();
        events.push({
          event: parsed.event || parsed.type || parsed.event_type || 'json_envelope',
          id: '',
          data: parsed,
          rawData: trimmed,
        });
        continue;
      } catch {
        // Not JSON; treat as data line
      }
    }
    dataLines.push(trimmed);
  }
  flushEvent();
  return events;
}

/**
 * Extract handshake, stream_complete, and error events from SSE response.
 *
 * @param {string|object} rawBody
 * @returns {{
 *   handshake: { threadId: string, conversationId: string, raw: object } | null,
 *   streamComplete: {
 *     success: boolean,
 *     explicitFailure: boolean,
 *     protocolComplete: boolean,
 *     errorCode: number | null,
 *     errorMsg: string,
 *     raw: object
 *   } | null,
 *   errorEvent: { errorCode: number, errorMsg: string, raw: object } | null,
 *   trailerError: { errorCode: number, errorMsg: string, raw: object } | null,
 *   protocolIssues: string[],
 *   events: Array<object>,
 *   isTruncated: boolean
 * }}
 */
export function parseConversationSse(rawBody) {
  const events = parseSseEvents(rawBody);
  let handshake = null;
  let streamComplete = null;
  let errorEvent = null;
  let trailerError = null;
  const protocolIssues = [];

  const isZeroCode = (code) => {
    const parsed = parseIntegerField(code);
    return parsed.valid && parsed.value === 0;
  };

  const extractCode = (code) => {
    const parsed = parseIntegerField(code);
    return parsed.valid ? parsed.value : -1;
  };

  const recordProtocolIssue = (message) => {
    if (!protocolIssues.includes(message)) protocolIssues.push(message);
  };

  for (const item of events) {
    const eventName = String(item.event || '').toLowerCase();
    const data = (item.data && typeof item.data === 'object') ? item.data : {};

    // Check handshake
    const isHandshake = (
      eventName === 'handshake'
      || data.event === 'handshake'
      || data.type === 'handshake'
      || data.event_type === 'handshake'
    );
    if (isHandshake) {
      const rawThreadId = data.thread_id ?? data.threadId ?? data?.data?.thread_id ?? data?.data?.threadId;
      const threadId = normalizeProtocolIdentifier(rawThreadId);
      const rawConvId = data.conversation_id ?? data.conversationId ?? data?.data?.conversation_id ?? data?.data?.conversationId;
      const conversationId = normalizeProtocolIdentifier(rawConvId);

      if (isMalformedProtocolIdentifier(rawThreadId)) {
        recordProtocolIssue('Handshake thread_id has an invalid type');
      }
      if (isMalformedProtocolIdentifier(rawConvId)) {
        recordProtocolIssue('Handshake conversation_id has an invalid type');
      }

      if (threadId) {
        const candidate = {
          threadId,
          conversationId,
          raw: data,
        };
        if (
          handshake
          && (
            handshake.threadId !== candidate.threadId
            || handshake.conversationId !== candidate.conversationId
          )
        ) {
          recordProtocolIssue('Conflicting handshake events were received');
        } else if (!handshake) {
          handshake = candidate;
        }
      }
    }

    // Check trailer / envelope errors (e.g. {"ret":"1001","errmsg":"fail"})
    if (eventName === 'json_envelope' || eventName === 'message') {
      const rawRet = data.ret ?? data.code;
      const rawErrCode = data.error_code ?? data.errorCode;
      const retField = parseIntegerField(rawRet);
      const errorCodeField = parseIntegerField(rawErrCode);
      if (retField.present && !retField.valid) {
        recordProtocolIssue('Trailer ret field is not an integer');
      }
      if (errorCodeField.present && !errorCodeField.valid) {
        recordProtocolIssue('Trailer error_code field is not an integer');
      }
      if (
        (retField.valid && retField.value !== 0)
        || (errorCodeField.valid && errorCodeField.value !== 0)
        || data.success === false
      ) {
        trailerError = {
          errorCode: extractCode(rawErrCode ?? rawRet ?? -1),
          errorMsg: String(data.errmsg || data.error_message || data.error_msg || data.message || data.msg || 'Trailer error'),
          raw: data,
        };
      }
    }

    // Check error event
    const rawErrorCode = data.error_code ?? data.errorCode ?? data.code ?? data.ret;
    const parsedErrorCode = parseIntegerField(rawErrorCode);
    const isExplicitError = (
      eventName === 'error'
      || data.event === 'error'
      || data.type === 'error'
      || (parsedErrorCode.valid && parsedErrorCode.value !== 0 && parsedErrorCode.value !== 200)
      || (data.success === false && !streamComplete)
    );
    if (data.success === false && streamComplete?.success === true) {
      recordProtocolIssue('A failure payload followed a successful stream completion');
    }
    if (isExplicitError && !errorEvent) {
      const errorCode = extractCode(rawErrorCode ?? -1);
      const errorMsg = String(
        data.error_message
        || data.error_msg
        || data.errorMsg
        || data.message
        || data.msg
        || data.errmsg
        || data.error
        || 'Conversation stream error',
      );
      errorEvent = {
        errorCode,
        errorMsg,
        raw: data,
      };
    }

    // Check stream_complete
    const isStreamComplete = (
      eventName === 'stream_complete'
      || eventName === 'message_stream_complete'
      || data.event === 'stream_complete'
      || data.type === 'stream_complete'
      || data.event_type === 'stream_complete'
    );
    if (isStreamComplete) {
      const rawCode = data.error_code ?? data.errorCode ?? data.code ?? data.ret;
      const parsedCode = parseIntegerField(rawCode);
      const hasExplicitSuccess = data.success === true || data.success === false;
      const hasExplicitCode = parsedCode.valid;
      if (parsedCode.present && !parsedCode.valid) {
        recordProtocolIssue('stream_complete error_code is not an integer');
      }
      const errorCode = hasExplicitCode ? extractCode(rawCode) : null;
      const explicitFailure = data.success === false || (hasExplicitCode && !isZeroCode(rawCode));
      const protocolComplete = hasExplicitSuccess && hasExplicitCode;
      const success = data.success === true && hasExplicitCode && isZeroCode(rawCode);
      const errorMsg = String(
        data.error_message
        || data.error_msg
        || data.errorMsg
        || data.message
        || data.msg
        || data.errmsg
        || '',
      );

      const candidate = {
        success,
        explicitFailure,
        protocolComplete,
        errorCode,
        errorMsg,
        raw: data,
      };
      if (
        streamComplete
        && (
          streamComplete.success !== candidate.success
          || streamComplete.explicitFailure !== candidate.explicitFailure
          || streamComplete.protocolComplete !== candidate.protocolComplete
          || streamComplete.errorCode !== candidate.errorCode
        )
      ) {
        recordProtocolIssue('Conflicting stream_complete events were received');
      } else if (!streamComplete) {
        streamComplete = candidate;
      }
    }
  }

  // Contradictory trailer error overrides success
  if (trailerError) {
    if (streamComplete?.success === true) {
      recordProtocolIssue('A trailer error contradicted a successful stream completion');
    }
    if (!errorEvent) errorEvent = trailerError;
    if (streamComplete) {
      streamComplete.success = false;
      streamComplete.explicitFailure = true;
      streamComplete.protocolComplete = true;
      streamComplete.errorCode = trailerError.errorCode;
      streamComplete.errorMsg = trailerError.errorMsg;
    }
  }

  const isTruncated = Boolean(handshake && !streamComplete && !errorEvent);

  return {
    handshake,
    streamComplete,
    errorEvent,
    trailerError,
    protocolIssues,
    events,
    isTruncated,
  };
}

/**
 * Check if the URL and method target the creation agent conversation endpoint
 * on the exact jimeng.jianying.com host.
 *
 * @param {string} url
 * @param {string} [method='POST']
 * @returns {boolean}
 */
export function isConversationEndpoint(url, method = 'POST') {
  return String(method || '').toUpperCase() === 'POST' && isConversationUrl(url);
}

export function isConversationUrl(url) {
  if (!url) return false;
  const urlStr = String(url).trim();
  if (TELEMETRY_URL_PATTERN.test(urlStr)) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443')) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== JIMENG_CONVERSATION_HOST) return false;
    return parsed.pathname === JIMENG_CONVERSATION_PATH;
  } catch {
    return false;
  }
}

/**
 * Check if the request body contains the given assetId.
 *
 * @param {object} rawEntry
 * @param {string} assetId
 * @returns {boolean}
 */
export function requestBodyMatchesAssetId(rawEntry, assetId) {
  if (!assetId || !rawEntry) return false;
  const normalizedAssetId = String(assetId).trim();
  if (!normalizedAssetId) return false;
  const entry = normalizeCaptureEntry(rawEntry);
  const payload = entry.requestBody;
  if (!payload) return false;
  const marker = `资产编号：${normalizedAssetId}`;
  if (typeof payload === 'string') {
    if (payload.includes(marker)) return true;
    try {
      return parsedValueContainsMarker(JSON.parse(payload), marker);
    } catch {
      return false;
    }
  }
  return parsedValueContainsMarker(payload, marker);
}

function extractRequestConversationId(payload) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return '';
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  return normalizeProtocolIdentifier(parsed.conversation_id ?? parsed.conversationId);
}

/**
 * Classify a single captured network entry against the expected assetId.
 *
 * @param {object} rawEntry
 * @param {string} assetId
 * @returns {object}
 */
export function classifyConversationEntry(rawEntry, assetId) {
  const entry = normalizeCaptureEntry(rawEntry);
  if (!entry.url) return { matches: false, isEndpoint: false };

  if (!isConversationUrl(entry.url)) return { matches: false, isEndpoint: false };
  if (entry.method !== 'POST') {
    return {
      matches: false,
      isEndpoint: true,
      uncorrelated: true,
      reason: `Conversation endpoint method was ${entry.method || 'unavailable'} instead of POST`,
    };
  }

  const hasAssetId = requestBodyMatchesAssetId(entry, assetId);
  const bodyUnavailableOrTruncated = !entry.requestBody || entry.requestBodyTruncated;

  if (!hasAssetId) {
    return {
      matches: false,
      isEndpoint: true,
      uncorrelated: true,
      bodyUnavailableOrTruncated,
      reason: bodyUnavailableOrTruncated
        ? 'Endpoint request body was unavailable or truncated'
        : 'Endpoint request body did not contain assetId',
    };
  }

  if (entry.requestBodyTruncated) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      nonRetryable: true,
      httpStatus: entry.status,
      reason: 'Captured request body was truncated',
    };
  }

  // Response body truncation by CDP/network layer is unconfirmed
  if (entry.responseBodyTruncated) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      nonRetryable: true,
      httpStatus: entry.status,
      reason: 'Captured response body was truncated',
    };
  }

  // Missing HTTP status is unconfirmed
  if (entry.status === null || entry.status === undefined) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      nonRetryable: true,
      httpStatus: null,
      reason: 'HTTP response status is missing',
    };
  }

  // HTTP non-2xx rejection
  if (entry.status < 200 || entry.status >= 300) {
    let errorMsg = `HTTP ${entry.status}`;
    if (entry.responseBody) {
      try {
        const parsed = typeof entry.responseBody === 'object' ? entry.responseBody : JSON.parse(entry.responseBody);
        errorMsg = parsed.error_message || parsed.error_msg || parsed.errorMsg || parsed.message || parsed.msg || parsed.errmsg || errorMsg;
      } catch {
        // ignore
      }
    }
    return {
      matches: true,
      isEndpoint: true,
      kind: 'rejected',
      status: 'rejected',
      httpStatus: entry.status,
      errorCode: entry.status,
      errorMsg,
      nonRetryable: true,
      reason: `HTTP ${entry.status} error returned by conversation endpoint`,
    };
  }

  if (entry.responseBody === undefined || entry.responseBody === null || entry.responseBody === '') {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'pending',
      status: 'pending',
      httpStatus: entry.status,
      reason: 'Request captured but response body is not yet available',
    };
  }

  const parsedSse = parseConversationSse(entry.responseBody);

  if (parsedSse.protocolIssues.length > 0) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      httpStatus: entry.status,
      nonRetryable: true,
      reason: `Conversation stream protocol conflict: ${parsedSse.protocolIssues.join('; ')}`,
    };
  }

  if (parsedSse.errorEvent && parsedSse.streamComplete?.success === true) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      httpStatus: entry.status,
      nonRetryable: true,
      reason: 'Conversation stream contained both an explicit error and a success completion',
    };
  }

  // Business rejection / error event / trailer error
  if (parsedSse.errorEvent || parsedSse.streamComplete?.explicitFailure) {
    const failure = parsedSse.streamComplete?.explicitFailure
      ? parsedSse.streamComplete
      : parsedSse.errorEvent;
    const errorCode = failure?.errorCode ?? -1;
    const errorMsg = failure?.errorMsg || 'Server rejected conversation request';
    return {
      matches: true,
      isEndpoint: true,
      kind: 'rejected',
      status: 'rejected',
      httpStatus: entry.status,
      errorCode,
      errorMsg,
      nonRetryable: true,
      reason: `Business rejection: ${errorMsg} (code: ${errorCode})`,
    };
  }

  // Confirmed success: requires HTTP 2xx, handshake with non-empty threadId, stream_complete success=true & errorCode=0
  if (parsedSse.handshake?.threadId && parsedSse.streamComplete?.success === true && parsedSse.streamComplete?.errorCode === 0) {
    const reqConvId = extractRequestConversationId(entry.requestBody);

    if (!reqConvId || !parsedSse.handshake.conversationId) {
      return {
        matches: true,
        isEndpoint: true,
        kind: 'unconfirmed',
        status: 'unconfirmed',
        httpStatus: entry.status,
        nonRetryable: true,
        reason: 'Conversation ID is missing from request body or handshake',
      };
    }

    if (reqConvId !== parsedSse.handshake.conversationId) {
      return {
        matches: true,
        isEndpoint: true,
        kind: 'unconfirmed',
        status: 'unconfirmed',
        httpStatus: entry.status,
        nonRetryable: true,
        reason: `Conversation ID mismatch: request=${reqConvId}, handshake=${parsedSse.handshake.conversationId}`,
      };
    }

    return {
      matches: true,
      isEndpoint: true,
      kind: 'confirmed',
      status: 'confirmed',
      httpStatus: entry.status,
      threadId: parsedSse.handshake.threadId,
      conversationId: parsedSse.handshake.conversationId || '',
      raw: parsedSse,
    };
  }

  // Handshake received but stream_complete pending
  if (parsedSse.handshake?.threadId && !parsedSse.streamComplete) {
    return {
      matches: true,
      isEndpoint: true,
      kind: 'pending',
      status: 'in_progress',
      httpStatus: entry.status,
      threadId: parsedSse.handshake.threadId,
      conversationId: parsedSse.handshake.conversationId || '',
      reason: 'Handshake received, waiting for stream_complete',
    };
  }

  return {
    matches: true,
    isEndpoint: true,
    kind: 'unconfirmed',
    status: 'unconfirmed',
    httpStatus: entry.status,
    nonRetryable: true,
    reason: 'Unparseable or unexpected conversation stream structure',
  };
}

/**
 * Classify the overall submit ACK status from captured network entries.
 *
 * @param {object} options
 * @param {Array<object>} [options.entries=[]]
 * @param {string} options.assetId
 * @param {boolean} [options.timedOut=false]
 * @param {Error|null} [options.captureError=null]
 * @param {object|null} [options.pageState=null]
 * @returns {object}
 */
export function classifySubmitAck({
  entries = [],
  assetId,
  timedOut = false,
  captureError = null,
  pageState = null,
}) {
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
      malformedCaptureEntryCount: 0,
      nonRetryable: true,
      reason: 'Network capture result was not an array',
    };
  }

  const normalized = entries.map(normalizeCaptureEntry);
  const malformedCaptureEntries = normalized.filter((entry) => entry.captureMalformed);
  const endpointEntries = normalized.filter((entry) => isConversationUrl(entry.url));
  const classifiedList = endpointEntries.map((entry) => classifyConversationEntry(entry, assetId));

  const matchingList = classifiedList.filter((c) => c.matches);

  if (malformedCaptureEntries.length > 0) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: matchingList.length,
      endpointRequestCount: endpointEntries.length,
      malformedCaptureEntryCount: malformedCaptureEntries.length,
      nonRetryable: true,
      reason: 'Network capture contained malformed entries without a usable URL',
    };
  }

  if (matchingList.length > 0) {
    const confirmed = matchingList.filter((c) => c.kind === 'confirmed');
    const rejected = matchingList.filter((c) => c.kind === 'rejected');
    const unconfirmed = matchingList.filter((c) => c.kind === 'unconfirmed');
    const pending = matchingList.filter((c) => c.kind === 'pending');

    if (
      confirmed.length > 1
      || (confirmed.length > 0 && (
        rejected.length > 0
        || unconfirmed.length > 0
        || pending.length > 0
        || endpointEntries.length !== matchingList.length
      ))
    ) {
      return {
        kind: 'unconfirmed',
        status: 'unconfirmed',
        matchingRequestCount: matchingList.length,
        endpointRequestCount: endpointEntries.length,
        nonRetryable: true,
        reason: 'Multiple or conflicting conversation requests/responses were captured',
      };
    }

    if (confirmed.length > 0) {
      const primary = confirmed[0];
      return {
        kind: 'confirmed',
        status: 'confirmed',
        matchingRequestCount: matchingList.length,
        endpointRequestCount: endpointEntries.length,
        threadId: primary.threadId,
        conversationId: primary.conversationId,
        httpStatus: primary.httpStatus,
      };
    }

    if (rejected.length > 0) {
      if (
        rejected.length > 1
        || unconfirmed.length > 0
        || pending.length > 0
        || endpointEntries.length !== matchingList.length
      ) {
        return {
          kind: 'unconfirmed',
          status: 'unconfirmed',
          matchingRequestCount: matchingList.length,
          endpointRequestCount: endpointEntries.length,
          nonRetryable: true,
          reason: 'Multiple or conflicting conversation rejections/responses were captured',
        };
      }
      const primary = rejected[0];
      return {
        kind: 'rejected',
        status: 'rejected',
        matchingRequestCount: matchingList.length,
        endpointRequestCount: endpointEntries.length,
        errorCode: primary.errorCode,
        errorMsg: primary.errorMsg,
        httpStatus: primary.httpStatus,
        nonRetryable: true,
        reason: primary.reason,
      };
    }

    if (unconfirmed.length > 0) {
      const primary = unconfirmed[0];
      return {
        kind: 'unconfirmed',
        status: 'unconfirmed',
        matchingRequestCount: matchingList.length,
        endpointRequestCount: endpointEntries.length,
        nonRetryable: true,
        reason: primary.reason,
      };
    }

    if (pending.length > 0) {
      if (endpointEntries.length !== matchingList.length) {
        return {
          kind: 'unconfirmed',
          status: 'unconfirmed',
          matchingRequestCount: matchingList.length,
          endpointRequestCount: endpointEntries.length,
          nonRetryable: true,
          reason: 'Pending conversation request coexisted with an uncorrelated endpoint request',
        };
      }
      if (!timedOut) {
        return {
          kind: 'pending',
          status: 'in_progress',
          matchingRequestCount: matchingList.length,
          endpointRequestCount: endpointEntries.length,
        };
      }
      return {
        kind: 'unconfirmed',
        status: 'unconfirmed',
        matchingRequestCount: matchingList.length,
        endpointRequestCount: endpointEntries.length,
        nonRetryable: true,
        reason: 'Conversation request was sent but response was truncated or timed out',
      };
    }
  }

  // 0 matching requests found:
  // If ANY endpoint request was captured but could not be correlated, outcome is UNCONFIRMED!
  if (endpointEntries.length > 0) {
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: endpointEntries.length,
      nonRetryable: true,
      reason: 'Conversation endpoint request was observed but could not be correlated safely with assetId',
    };
  }

  // 0 endpoint requests at all:
  if (!timedOut) {
    return {
      kind: 'none',
      status: 'waiting',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
    };
  }

  if (pageState) {
    if (pageState.assetIdInComposer === true && pageState.assetIdOutsideComposer === false) {
      return {
        kind: 'not_sent',
        status: 'not_sent',
        matchingRequestCount: 0,
        endpointRequestCount: 0,
        retryable: true,
        reason: 'No conversation endpoint request captured and assetId remains safely in composer',
      };
    }
    return {
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
      nonRetryable: true,
      reason: 'No conversation request captured but page composer state is inconsistent',
    };
  }

  return {
    kind: 'no_request_timed_out',
    status: 'no_request',
    matchingRequestCount: 0,
    endpointRequestCount: 0,
  };
}

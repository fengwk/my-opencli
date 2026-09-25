/**
 * Incremental reader for OpenCLI's non-invasive HTTP SSE capture
 * (page.startSseCapture / page.readSseCapture).
 *
 * The host hands over raw response-body bytes of our own conversation POST
 * (https://chatgpt.com/backend-api/f/conversation) as `base64:` slices, so this
 * module owns everything between "bytes" and "stream event": streaming UTF-8
 * decode, SSE framing across arbitrary chunk / event / UTF-8 boundaries
 * (CRLF, comments, multi-line data), and fail-closed integrity. Turn semantics
 * (text patches, tool/file/image pointers, lifecycle) stay in StreamCollector.
 *
 * Integrity is never traded for progress: evicted chunks, truncated payloads,
 * undecodable bytes or an arm the browser rejected raise
 * SSE_CAPTURE_INCOMPLETE / SSE_CAPTURE_UNSUPPORTED instead of yielding a
 * silently partial answer.
 */

import { SSE_CAPTURE_INCOMPLETE, SSE_CAPTURE_UNSUPPORTED } from './stream-collector.js';

/**
 * Our own conversation POST. The `/prepare` endpoint shares this prefix, so the
 * plugin re-checks the URL exactly instead of trusting the substring arm filter.
 */
export const CHATGPT_CONVERSATION_SSE_URL = 'https://chatgpt.com/backend-api/f/conversation';

/**
 * Upper bound for one incomplete SSE event (data lines that have not reached
 * their terminating blank line). Real ChatGPT events are a few KB; a "line"
 * that never ends means the framing assumption is wrong, so fail closed instead
 * of buffering without bound.
 */
export const MAX_SSE_EVENT_CHARS = 4 << 20;
/** Bound on concurrently tracked request ids so odd stream sets cannot grow state. */
const MAX_SSE_REQUESTS = 8;

/** Fail-closed error carrying the code/hint the command layer turns into guidance. */
function captureError(code, message, hint) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint;
  return err;
}

function incomplete(message, hint) {
  return captureError(SSE_CAPTURE_INCOMPLETE, `SSE_CAPTURE_INCOMPLETE: ${message}`, hint);
}

/**
 * `base64:<bytes>` → Buffer, or null when the host contract is violated.
 * Padding is tolerated in either canonical form, but the bytes must round-trip:
 * Buffer.from silently skips stray characters, which would hide corruption.
 */
function decodeBase64Payload(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('base64:')) {
    return null;
  }
  const encoded = payload.slice('base64:'.length).replace(/=+$/, '');
  if (!encoded || !/^[A-Za-z0-9+/]+$/.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded) {
    return null;
  }
  return bytes;
}

/** One leading space after the field colon is part of the SSE framing, not the value. */
function fieldValue(text) {
  return text.startsWith(' ') ? text.slice(1) : text;
}

/**
 * Parse complete SSE frames out of newly decoded text while keeping an
 * incomplete event (a partial line, or data lines without their blank line) in
 * `state` for the next chunk. Comments and unknown fields are tolerated and
 * ignored — ChatGPT streams keep-alive comments, and only `data:` carries turn
 * events.
 */
function parseSseFrames(state, text) {
  state.text += text;
  const buf = state.text;
  const frames = [];
  let lineStart = 0;
  let i = 0;

  while (i < buf.length) {
    const ch = buf[i];
    if (ch !== '\n' && ch !== '\r') {
      i += 1;
      continue;
    }
    // A trailing CR may be the first half of a CRLF pair split across chunks —
    // treating it as a blank line here would fabricate an event boundary.
    if (ch === '\r' && i + 1 === buf.length) {
      break;
    }
    const line = buf.slice(lineStart, i);
    const nextIndex = ch === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1;

    if (line === '') {
      if (state.dataLines.length > 0) {
        frames.push({ event: state.eventName, data: state.dataLines.join('\n') });
        state.dataLines = [];
        state.dataChars = 0;
      }
      state.eventName = '';
    } else if (line.startsWith(':')) {
      // Comment / keep-alive.
    } else if (line.startsWith('data:')) {
      const value = fieldValue(line.slice('data:'.length));
      state.dataLines.push(value);
      state.dataChars += value.length;
    } else if (line.startsWith('event:')) {
      state.eventName = fieldValue(line.slice('event:'.length));
    }

    lineStart = nextIndex;
    i = nextIndex;
  }

  state.text = buf.slice(lineStart);
  if (state.text.length + state.dataChars > MAX_SSE_EVENT_CHARS) {
    throw incomplete(
      'a single HTTP-stream event exceeded the SSE framing limit without terminating',
      'The captured response does not look like a ChatGPT event stream. Retry the ask; if it repeats, report a CLI/extension mismatch.',
    );
  }
  return frames;
}

/** Decode streamed bytes; malformed UTF-8 must fail closed rather than substitute U+FFFD. */
function decodeUtf8(state, bytes) {
  try {
    return state.decoder.decode(bytes, { stream: true });
  } catch {
    return null;
  }
}

/**
 * Consumes page.readSseCapture() results for one turn and feeds the collector.
 * One instance per turn; it also reports whether our stream is still open so the
 * wait loop does not end the turn on WebSocket-only evidence.
 */
export class SseCaptureStream {
  /**
   * @param {import('./stream-collector.js').StreamCollector} collector
   * @param {{ url?: string }} [opts]
   */
  constructor(collector, opts = {}) {
    this.collector = collector;
    this.url = opts.url || CHATGPT_CONVERSATION_SSE_URL;
    /** requestId → SSE framing state, so interleaved streams never share a decoder. */
    this.requests = new Map();
    this.chunkCount = 0;
    this.byteLength = 0;
    this.eventCount = 0;
    this.dropped = 0;
    /** Bytes of our own conversation POST have been captured (arming alone is not evidence). */
    this.sawOwnStream = false;
    /** Terminal `data: [DONE]` of our own stream was seen. */
    this.doneSeen = false;
    this.lastChunkAt = null;
    /**
     * Raw capture failure reported by the browser, internal diagnosis only:
     * it can quote request URLs (with query strings) and must never be logged,
     * returned in an error, or included in describe().
     */
    this.captureErrorText = '';
  }

  /** Drain one readSseCapture() batch into the collector. */
  async drain(page) {
    if (typeof page?.readSseCapture !== 'function') {
      return 0;
    }
    const result = await page.readSseCapture();
    return this.ingestRead(result);
  }

  /** Our turn stream produced bytes but has not reached its terminal event yet. */
  isOpen() {
    return this.sawOwnStream && !this.doneSeen;
  }

  /** Counters only: verbose diagnostics must never surface captured content. */
  describe() {
    const silentMs = this.lastChunkAt === null ? '-' : Date.now() - this.lastChunkAt;
    return `chunks=${this.chunkCount} bytes=${this.byteLength} events=${this.eventCount} `
      + `open=${this.isOpen()} silentMs=${silentMs}`;
  }

  /** Exact own-POST match: query/hash/trailing slash must not smuggle in `/prepare`. */
  isOwnConversationUrl(url) {
    if (typeof url !== 'string' || !url) {
      return false;
    }
    const normalized = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
    return normalized === this.url;
  }

  /**
   * Consume one read result. Anything that makes the captured bytes an
   * incomplete view of the stream aborts the turn instead of continuing.
   */
  ingestRead(result) {
    const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
    const dropped = Number(result?.dropped) || 0;
    if (dropped > 0) {
      this.dropped += dropped;
      throw incomplete(
        `${dropped} captured HTTP-stream chunk(s) were evicted before they could be read`,
        'The turn response is incomplete and was discarded. Retry the ask; if it repeats, report a capture ring overflow.',
      );
    }
    for (const chunk of chunks) {
      this._ingestChunk(chunk);
    }
    return chunks.length;
  }

  _ingestChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') {
      throw incomplete(
        'the capture result contained a malformed chunk entry',
        'Update the forked CLI/extension pair — their SSE capture contract does not match this plugin.',
      );
    }
    if (chunk.kind === 'sse-error') {
      if (chunk.url && !this.isOwnConversationUrl(chunk.url)) {
        return; // Unrelated stream (e.g. /prepare) — never fail this turn for it.
      }
      // CDP's errorText can quote the request URL (query strings/tokens included),
      // so it is kept for internal diagnosis only and never printed or returned.
      this.captureErrorText = String(chunk.error ?? '').slice(0, 4096);
      throw captureError(
        SSE_CAPTURE_UNSUPPORTED,
        'SSE_CAPTURE_UNSUPPORTED: the browser could not stream this response body',
        'Update the forked Browser Bridge extension and Chrome, then retry: HTTP stream capture needs a streaming-capable target.',
      );
    }
    if (chunk.kind !== 'sse-chunk') {
      throw incomplete(
        `the capture result contained an unknown chunk kind (${summarize(chunk.kind)})`,
        'Update the forked CLI/extension pair — their SSE capture contract does not match this plugin.',
      );
    }
    if (!this.isOwnConversationUrl(chunk.url)) {
      return; // Unrelated request: /prepare or any other URL must never be read as turn output.
    }
    if (chunk.payloadTruncated === true) {
      throw incomplete(
        'a captured HTTP-stream chunk exceeded the capture limit and was stored truncated',
        'The turn response is incomplete and was discarded. Retry the ask; if it repeats, report a capture payload overflow.',
      );
    }

    const bytes = decodeBase64Payload(chunk.payload);
    if (!bytes) {
      throw incomplete(
        'a captured HTTP-stream chunk payload was not valid base64',
        'Update the forked CLI/extension pair — their SSE capture contract does not match this plugin.',
      );
    }
    const state = this._requestState(chunk.requestId);
    const text = decodeUtf8(state, bytes);
    if (text === null) {
      throw incomplete(
        'a captured HTTP-stream chunk was not valid UTF-8',
        'The turn response is incomplete and was discarded. Retry the ask; if it repeats, report a capture decode error.',
      );
    }

    this.chunkCount += 1;
    this.byteLength += bytes.length;
    this.lastChunkAt = Date.now();
    this.sawOwnStream = true;

    for (const frame of parseSseFrames(state, text)) {
      this._ingestFrame(frame);
    }
  }

  _ingestFrame(frame) {
    this.eventCount += 1;
    if (String(frame.data).trim() === '[DONE]') {
      this.doneSeen = true;
    }
    this.collector.ingestDirectSseEvent(frame);
  }

  _requestState(requestId) {
    const key = String(requestId || '');
    let state = this.requests.get(key);
    if (!state) {
      if (this.requests.size >= MAX_SSE_REQUESTS) {
        throw incomplete(
          `more than ${MAX_SSE_REQUESTS} concurrent HTTP streams were captured for this turn`,
          'The turn response cannot be attributed to a single request and was discarded. Retry the ask.',
        );
      }
      state = {
        decoder: new TextDecoder('utf-8', { fatal: true }),
        text: '',
        dataLines: [],
        dataChars: 0,
        eventName: '',
      };
      this.requests.set(key, state);
    }
    return state;
  }
}

/** Bounded, non-echoing rendering of host-provided text for error messages. */
function summarize(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return 'no reason given';
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

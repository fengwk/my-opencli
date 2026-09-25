import { describe, expect, it } from 'vitest';
import { SSE_CAPTURE_UNSUPPORTED, StreamCollector } from '../src/stream-collector.js';
import {
  CHATGPT_CONVERSATION_SSE_URL,
  SseCaptureStream,
} from '../src/sse-stream.js';
import { waitForProtocolStream } from '../src/wait-stream.js';

const CONVERSATION_ID = '68f1c7b0-9d3e-4f21-8a55-6c0a1d2e3f44';
const PREPARE_URL = `${CHATGPT_CONVERSATION_SSE_URL}/prepare`;

/**
 * Sanitized capture of one real-shaped search turn on our own conversation POST:
 * a keep-alive comment, CRLF framing, a conversation-created binding event, a
 * tool marker, append patches (CJK + emoji), a citation patch, lifecycle
 * markers and the terminating `[DONE]`.
 */
const TURN_FIXTURE = [
  ': ping\r\n\r\n',
  `data: ${JSON.stringify({
    type: 'conversation-created',
    conversation: { id: CONVERSATION_ID },
    conversation_id: CONVERSATION_ID,
  })}\r\n\r\n`,
  `data: ${JSON.stringify({
    type: 'server_ste_metadata',
    metadata: { tool_invoked: true },
  })}\n\n`,
  `data: ${JSON.stringify({
    o: 'add',
    v: {
      message: {
        id: 'user-1',
        author: { role: 'user' },
        content: { parts: ['今天有什么值得关注的技术新闻？'] },
      },
    },
  })}\n\n`,
  `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '根据检索到的资料，' })}\r\n\r\n`,
  `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '今天最值得关注的是 ' })}\n\n`,
  // Patches are applied on top of the appended text.
  `data: ${JSON.stringify({
    o: 'patch',
    v: [{ p: '/message/content/parts/0', o: 'append', v: 'GB200 🚀 出货' }],
  })}\n\n`,
  `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '。' })}\n\ndata: \n\n`,
  'data: \n\n',
  // Search citations ride on the final assistant message's metadata (the same
  // shape the conversation-update channel uses).
  `data: ${JSON.stringify({
    o: 'add',
    v: {
      message: {
        id: 'assistant-final',
        author: { role: 'assistant' },
        content: { parts: ['根据检索到的资料，今天最值得关注的是 GB200 🚀 出货。'] },
        metadata: {
          content_references: [{
            matched_text: 'gb200',
            title: 'NVIDIA GB200 出货提速',
            url: 'https://example.com/gb200',
          }],
        },
      },
    },
  })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_marker', marker: 'last_token', event: 'last' })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_stream_complete' })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const EXPECTED_TEXT = '根据检索到的资料，今天最值得关注的是 GB200 🚀 出货。';

/** Cut points inside UTF-8 sequences, inside events and on framing boundaries. */
function fixtureCuts(bytes) {
  const emojiAt = bytes.indexOf(Buffer.from('🚀', 'utf8'));
  const hanAt = bytes.indexOf(Buffer.from('据', 'utf8'));
  const blankAt = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const cuts = new Set([
    9,
    10,
    37,
    96,
    emojiAt + 1,
    emojiAt + 2,
    hanAt + 2,
    blankAt + 1,
    blankAt + 3,
    bytes.length,
  ]);
  return {
    cuts: [...cuts].filter((cut) => cut > 0 && cut <= bytes.length).sort((a, b) => a - b),
    emojiAt,
    hanAt,
  };
}

function splitBuffer(bytes, cuts) {
  const parts = [];
  let previous = 0;
  for (const cut of cuts) {
    parts.push(bytes.subarray(previous, cut));
    previous = cut;
  }
  return parts.filter((part) => part.length > 0);
}

function sseChunk(payloadBytes, opts = {}) {
  return {
    kind: 'sse-chunk',
    url: opts.url || CHATGPT_CONVERSATION_SSE_URL,
    requestId: opts.requestId || 'req-own-1',
    timestamp: Date.now(),
    payload: `base64:${Buffer.from(payloadBytes).toString('base64')}`,
    payloadTruncated: opts.payloadTruncated === true,
  };
}

/** Page fake that hands out the fixture chunk by chunk, then nothing. */
function sseOnlyPage(chunks, { wsBatches = [] } = {}) {
  const pending = chunks.slice();
  let wsIndex = 0;
  return {
    readWsCapture: async () => {
      const batch = wsBatches[wsIndex] || [];
      wsIndex += 1;
      return batch;
    },
    readSseCapture: async () => {
      const chunk = pending.shift();
      return chunk ? { chunks: [chunk], dropped: 0 } : { chunks: [], dropped: 0 };
    },
    sleep: async () => {},
  };
}

function immediateWaitOptions(overrides = {}) {
  return {
    timeoutMs: 500,
    textSettleMs: 0,
    imageSettleMs: 0,
    graceMs: 0,
    pollMs: 0,
    ...overrides,
  };
}

function ingestFixture(collector, opts = {}) {
  const sse = new SseCaptureStream(collector);
  const bytes = Buffer.from(TURN_FIXTURE, 'utf8');
  const cutInfo = fixtureCuts(bytes);
  for (const part of splitBuffer(bytes, cutInfo.cuts)) {
    sse.ingestRead({ chunks: [sseChunk(part, opts)], dropped: 0 });
  }
  return { sse, bytes, ...cutInfo };
}

describe('SseCaptureStream byte→event decoding', () => {
  // Fragments land inside UTF-8 sequences, inside events and on framing
  // boundaries; only boundary-aware decoding can reproduce the exact text.
  it('reproduces exact text, sources and lifecycle from arbitrarily fragmented chunks', () => {
    const collector = new StreamCollector({ guarded: true });
    const { sse, bytes, cuts, emojiAt, hanAt } = ingestFixture(collector);

    // Explicitly prove the fixture really exercises mid-character fragmentation.
    expect(bytes[emojiAt + 1] & 0xc0).toBe(0x80);
    expect(cuts).toContain(emojiAt + 1);
    expect(cuts).toContain(hanAt + 2);

    expect(collector.text).toBe(EXPECTED_TEXT);
    expect(collector.conversationId).toBe(CONVERSATION_ID);
    expect(collector.expectedConversationId).toBe(CONVERSATION_ID);
    expect(collector.sources).toEqual([{
      title: 'NVIDIA GB200 出货提速',
      url: 'https://example.com/gb200',
      ref: 'gb200',
    }]);
    expect(collector.toolInvoked).toBe(true);
    expect(collector.strongLifecycle).toMatchObject({
      doneSeen: true,
      lastTokenSeen: true,
      messageStreamCompleteSeen: true,
    });

    // Direct ingestion must register progress on the collector's clocks.
    expect(collector.firstProgressAt).not.toBeNull();
    expect(collector.lastProgressAt).toBeGreaterThanOrEqual(collector.firstProgressAt);
    expect(collector.frameCount).toBeGreaterThan(0);
    expect(sse.doneSeen).toBe(true);
    expect(sse.isOpen()).toBe(false);
    expect(sse.sawOwnStream).toBe(true);
    expect(sse.byteLength).toBe(bytes.length);
  });

  // Comments, CRLF framing and a trailing empty data line must not end an event early.
  it('tolerates keep-alive comments, CRLF and multi-line data fields', () => {
    const collector = new StreamCollector({ guarded: false });
    const sse = new SseCaptureStream(collector);
    const body = [
      ': keep-alive\r\n\r\n',
      'data: {"p":"/message/content/parts/0","o":"append","v":"A"}\r\ndata: \r\n\r\n',
    ].join('');
    sse.ingestRead({ chunks: [sseChunk(Buffer.from(body, 'utf8'))], dropped: 0 });

    expect(collector.text).toBe('A');
  });

  // A retained partial line must complete once the next chunk arrives.
  it('holds an incomplete event until the remaining bytes arrive', () => {
    const collector = new StreamCollector({ guarded: false });
    const sse = new SseCaptureStream(collector);
    const event = `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '半' })}\n\n`;
    const bytes = Buffer.from(event, 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('半', 'utf8')) + 1;

    sse.ingestRead({ chunks: [sseChunk(bytes.subarray(0, splitAt))], dropped: 0 });
    expect(collector.text).toBe('');
    expect(sse.isOpen()).toBe(true);

    sse.ingestRead({ chunks: [sseChunk(bytes.subarray(splitAt))], dropped: 0 });
    expect(collector.text).toBe('半');
  });

  // Only our own conversation POST may be read as turn output: the /prepare
  // endpoint shares the arm pattern and must never contribute text.
  it('ignores unrelated captured requests', () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);
    const foreignEvent = Buffer.from(
      `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'foreign' })}\n\n`,
      'utf8',
    );

    sse.ingestRead({
      chunks: [
        sseChunk(foreignEvent, { url: PREPARE_URL }),
        sseChunk(foreignEvent, { url: 'https://chatgpt.com/backend-api/conversation/other' }),
      ],
      dropped: 0,
    });

    expect(collector.text).toBe('');
    expect(sse.chunkCount).toBe(0);
    expect(sse.eventCount).toBe(0);
    expect(sse.sawOwnStream).toBe(false);
  });

  // Two captures can share the endpoint (e.g. an interleaved retry); each
  // request keeps its own decoder and partial frame so neither corrupts ours.
  it('keeps per-request framing isolated', () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);
    const otherStreamHead = Buffer.from(
      'data: {"p":"/message/content/parts/0","o":"append","v":"other-st',
      'utf8',
    );

    sse.ingestRead({ chunks: [sseChunk(otherStreamHead, { requestId: 'req-other' })], dropped: 0 });
    const { sse: ownStream } = ingestFixture(collector);

    expect(collector.text).toBe(EXPECTED_TEXT);
    expect(ownStream.isOpen()).toBe(false);
    // The other request's dangling frame never produced an event of its own.
    expect(collector.sources).toHaveLength(1);
  });

  // A second, unrelated request's failure must not fail this turn.
  it('ignores an sse-error reported for an unrelated request', () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);

    expect(() => sse.ingestRead({
      chunks: [{ kind: 'sse-error', url: PREPARE_URL, requestId: 'req-prepare', timestamp: Date.now(), error: 'not streamable' }],
      dropped: 0,
    })).not.toThrow();
    expect(collector.text).toBe('');
  });
});

describe('SseCaptureStream fail-closed integrity', () => {
  const cases = [
    // Evicted chunks mean the answer is missing a middle slice.
    ['dropped chunks', () => ({ chunks: [], dropped: 3 }), /SSE_CAPTURE_INCOMPLETE: 3 captured/],
    // A truncated chunk is a silently shortened stream.
    ['truncated payload', () => ({
      chunks: [sseChunk(Buffer.from('data: {}\n\n', 'utf8'), { payloadTruncated: true })],
      dropped: 0,
    }), /stored truncated/],
    // The browser could not stream the body at all (old Chrome/target).
    ['unsupported stream', () => ({
      chunks: [{
        kind: 'sse-error',
        url: CHATGPT_CONVERSATION_SSE_URL,
        requestId: 'req-own-1',
        timestamp: Date.now(),
        error: 'Network.streamResourceContent was not found',
      }],
      dropped: 0,
    }), /SSE_CAPTURE_UNSUPPORTED/],
    ['malformed base64', () => ({
      chunks: [sseChunk(Buffer.from('data: {}\n\n', 'utf8'))].map((chunk) => ({
        ...chunk,
        payload: 'base64:not*base64!',
      })),
      dropped: 0,
    }), /not valid base64/],
    ['missing base64 prefix', () => ({
      chunks: [sseChunk(Buffer.from('data: {}\n\n', 'utf8'))].map((chunk) => ({ ...chunk, payload: 'data: {}' })),
      dropped: 0,
    }), /not valid base64/],
    ['invalid UTF-8', () => ({
      chunks: [sseChunk(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]))],
      dropped: 0,
    }), /not valid UTF-8/],
    ['unknown chunk kind', () => ({
      chunks: [{ kind: 'sse-partial', url: CHATGPT_CONVERSATION_SSE_URL, requestId: 'req-own-1' }],
      dropped: 0,
    }), /unknown chunk kind/],
  ];

  for (const [name, result, expected] of cases) {
    // Any of these would silently truncate or corrupt the answer: abort instead.
    it(`fails closed on ${name}`, () => {
      const sse = new SseCaptureStream(new StreamCollector({ guarded: true }));
      expect(() => sse.ingestRead(result())).toThrow(expected);
    });
  }

  // CDP errorText can quote the request URL, tokens included: the failure must
  // stay generic, and the raw text must never reach message/hint/describe().
  it('never echoes the raw capture error of our own request', () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);
    const secretError = 'Network.streamResourceContent failed for https://chatgpt.com/backend-api/f/conversation?token=SECRET-TOKEN-1234';

    let thrown = null;
    try {
      sse.ingestRead({
        chunks: [{
          kind: 'sse-error',
          url: CHATGPT_CONVERSATION_SSE_URL,
          requestId: 'req-own-1',
          timestamp: Date.now(),
          error: secretError,
        }],
        dropped: 0,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe(SSE_CAPTURE_UNSUPPORTED);
    expect(thrown.message).toMatch(/could not stream this response body/);
    const surfaced = `${thrown.message}\n${thrown.hint || ''}\n${sse.describe()}`;
    expect(surfaced).not.toContain('SECRET-TOKEN-1234');
    expect(surfaced).not.toContain('token=');
    expect(surfaced).not.toContain('backend-api');
    // Kept for internal diagnosis only (never printed or returned).
    expect(sse.captureErrorText).toBe(secretError);
  });

  // The wait loop must surface the abort instead of returning partial output.
  it('propagates the integrity failure out of the wait loop', async () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);
    const page = {
      readWsCapture: async () => [],
      readSseCapture: async () => ({ chunks: [sseChunk(Buffer.from('data: [DONE]\n\n', 'utf8'))], dropped: 1 }),
      sleep: async () => {},
    };

    await expect(
      waitForProtocolStream(page, collector, immediateWaitOptions({ sse })),
    ).rejects.toMatchObject({ code: 'SSE_CAPTURE_INCOMPLETE' });
  });
});

describe('conversation binding from the direct HTTP stream', () => {
  // New chats have no id before send: early events are held, then replayed in
  // order once the stream's own conversation id appears.
  it('buffers events until the conversation id is known, then replays them in order', () => {
    const collector = new StreamCollector({ guarded: true });

    collector.ingestDirectSseEvent({ data: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '提前到达' }) });
    expect(collector.text).toBe('');
    expect(collector.frameCount).toBe(0);
    expect(collector.bufferedDirectSseEvents).toHaveLength(1);

    collector.ingestDirectSseEvent({ data: JSON.stringify({ conversation_id: 'cid-sse', type: 'server_ste_metadata' }) });
    collector.ingestDirectSseEvent({ data: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '的正文' }) });

    expect(collector.conversationId).toBe('cid-sse');
    expect(collector.text).toBe('提前到达的正文');
    expect(collector.bufferedDirectSseEvents).toHaveLength(0);
    expect(collector.firstProgressAt).not.toBeNull();
  });

  // Live streams may nest the conversation object instead of the flat id.
  it('binds from a nested conversation object id', () => {
    const collector = new StreamCollector({ guarded: true });

    collector.ingestDirectSseEvent({
      data: JSON.stringify({ type: 'conversation-created', conversation: { id: 'cid-nested' } }),
    });

    expect(collector.expectedConversationId).toBe('cid-nested');
  });

  // URL binding and stream binding must agree; a mismatch stays fail-closed.
  it('fails closed when the stream id conflicts with the bound conversation', () => {
    const collector = new StreamCollector({ guarded: true, conversationId: 'cid-bound' });

    collector.ingestDirectSseEvent({ data: JSON.stringify({ conversation_id: 'cid-other' }) });
    expect(collector.conversationId).toBe('cid-bound');
    expect(collector.text).toBe('');
  });

  // The binding buffer is bounded: losing the stream prefix would silently
  // truncate the answer, so overflow must abort.
  it('fails closed instead of dropping buffered pre-bind events', () => {
    const collector = new StreamCollector({ guarded: true });
    for (let i = 0; i < 500; i += 1) {
      collector.ingestDirectSseEvent({ data: JSON.stringify({ o: 'add', v: { message: { id: `m${i}` } } }) });
    }
    expect(collector.bufferedDirectSseEvents).toHaveLength(500);
    expect(() => collector.ingestDirectSseEvent({
      data: JSON.stringify({ o: 'add', v: { message: { id: 'overflow' } } }),
    })).toThrow(/SSE_CAPTURE_INCOMPLETE/);
  });
});

describe('waitForProtocolStream over the HTTP stream', () => {
  // The live failure mode: WebSockets only carry handshake frames while the
  // answer streams over HTTP. The turn must still complete with exact text.
  it('completes a turn from the HTTP stream alone without WebSocket payload', async () => {
    const collector = new StreamCollector({ guarded: true });
    const sse = new SseCaptureStream(collector);
    const bytes = Buffer.from(TURN_FIXTURE, 'utf8');
    const { cuts } = fixtureCuts(bytes);
    const page = sseOnlyPage(splitBuffer(bytes, cuts).map((part) => sseChunk(part)));

    const result = await waitForProtocolStream(page, collector, immediateWaitOptions({ sse }));

    expect(result).toEqual({ reason: 'protocol-complete', text: EXPECTED_TEXT });
    expect(collector.sources).toHaveLength(1);
    expect(sse.doneSeen).toBe(true);
  });

  // A WebSocket-only lifecycle signal (legacy handshake / unrelated stream)
  // must not end the turn while our own HTTP stream is still delivering.
  it('keeps draining while the HTTP stream is still open despite WebSocket lifecycle', async () => {
    const bytes = Buffer.from(TURN_FIXTURE, 'utf8');
    const { cuts } = fixtureCuts(bytes);
    const parts = splitBuffer(bytes, cuts);
    const wsBatch = [{
      direction: 'received',
      payload: JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn-ws',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn-ws',
            encoded_item: `data: ${JSON.stringify({
              type: 'message_stream_complete',
              conversation_id: CONVERSATION_ID,
            })}\n\n`,
          },
        },
      }]),
    }];

    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const page = sseOnlyPage(parts.map((part) => sseChunk(part)), { wsBatches: [wsBatch] });

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, pollMs: 1 }),
    );

    // Without HTTP-stream awareness the empty turn-stream lifecycle would have
    // been classified as a finished empty turn instead of waiting for the text.
    expect(result).toEqual({ reason: 'protocol-complete', text: EXPECTED_TEXT });
  });

  // A stale/empty WebSocket terminal state can precede the first HTTP-stream
  // byte: classifying immediately would answer EMPTY_REPLY for a turn whose
  // content only ever arrives over HTTP.
  it('does not classify an empty WebSocket terminal before the HTTP stream starts', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const body = `data: ${JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: '迟到的回答',
      conversation_id: CONVERSATION_ID,
    })}\n\ndata: [DONE]\n\n`;
    let sseReads = 0;
    let wsReads = 0;
    const page = {
      readWsCapture: async () => {
        wsReads += 1;
        if (wsReads > 1) return [];
        return [{
          direction: 'received',
          payload: JSON.stringify([{
            type: 'message',
            topic_id: 'conversation-turn-turn-ws',
            payload: {
              type: 'conversation-turn-stream',
              payload: {
                turn_id: 'turn-ws',
                encoded_item: `data: ${JSON.stringify({
                  type: 'message_stream_complete',
                  conversation_id: CONVERSATION_ID,
                })}\n\n`,
              },
            },
          }]),
        }];
      },
      readSseCapture: async () => {
        sseReads += 1;
        // The POST response takes a few polls to start streaming.
        if (sseReads < 3) return { chunks: [], dropped: 0 };
        return { chunks: [sseChunk(Buffer.from(body, 'utf8'))], dropped: 0 };
      },
      sleep: async () => {},
    };

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, sseStartGraceMs: 5000, pollMs: 1 }),
    );

    expect(result).toEqual({ reason: 'protocol-complete', text: '迟到的回答' });
  });

  // ...and the startup wait is bounded: a build that never streams over HTTP
  // still classifies the empty turn instead of draining until --timeout.
  it('classifies an empty turn once the HTTP-stream startup window expires', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const page = {
      readWsCapture: async () => [{
        direction: 'received',
        payload: JSON.stringify([{
          type: 'message',
          topic_id: 'conversation-turn-turn-ws',
          payload: {
            type: 'conversation-turn-stream',
            payload: {
              turn_id: 'turn-ws',
              encoded_item: `data: ${JSON.stringify({
                type: 'message_stream_complete',
                conversation_id: CONVERSATION_ID,
              })}\n\n`,
            },
          },
        }]),
      }],
      readSseCapture: async () => ({ chunks: [], dropped: 0 }),
      sleep: async () => {},
    };

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, sseStartGraceMs: 30, timeoutMs: 2000, pollMs: 1 }),
    );

    expect(result).toEqual({ reason: 'protocol-complete-text-empty', text: '' });
  });

  // The startup window must not delay a turn that already produced text.
  it('does not delay a WebSocket-only text turn while the HTTP stream is silent', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const page = {
      readWsCapture: async () => [{
        direction: 'received',
        payload: JSON.stringify([{
          type: 'message',
          topic_id: 'conversation-turn-turn-ws',
          payload: {
            type: 'conversation-turn-stream',
            payload: {
              turn_id: 'turn-ws',
              encoded_item: `data: ${JSON.stringify({
                p: '/message/content/parts/0',
                o: 'append',
                v: '立即返回',
                conversation_id: CONVERSATION_ID,
              })}\n\ndata: ${JSON.stringify({
                type: 'message_stream_complete',
                conversation_id: CONVERSATION_ID,
              })}\n\n`,
            },
          },
        }]),
      }],
      readSseCapture: async () => ({ chunks: [], dropped: 0 }),
      sleep: async () => {},
    };

    const t0 = Date.now();
    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, sseStartGraceMs: 60_000, pollMs: 1 }),
    );
    const elapsedMs = Date.now() - t0;

    expect(result).toEqual({ reason: 'protocol-complete', text: '立即返回' });
    expect(elapsedMs).toBeLessThan(1000);
  });

  // Once our own stream has started, only its terminal event may end the turn:
  // a quiet stream may simply be truncated, so the loop keeps draining to the
  // user timeout and the command layer fails closed instead of returning text.
  it('never completes an unterminated own stream on quiet', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    let sseReads = 0;
    const page = {
      readWsCapture: async () => [],
      readSseCapture: async () => {
        sseReads += 1;
        if (sseReads > 1) return { chunks: [], dropped: 0 };
        // The message stream reports completion and text arrives, but the
        // response never sends its terminal `[DONE]` before going silent.
        const body = [
          `data: ${JSON.stringify({
            p: '/message/content/parts/0',
            o: 'append',
            v: '这是被截断的部分回答',
            conversation_id: CONVERSATION_ID,
          })}\n\n`,
          `data: ${JSON.stringify({ type: 'message_stream_complete' })}\n\n`,
        ].join('');
        return { chunks: [sseChunk(Buffer.from(body, 'utf8'))], dropped: 0 };
      },
      sleep: async () => {},
    };

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, timeoutMs: 60, textSettleMs: 0, pollMs: 1 }),
    );

    // Text exists and the settle rule allows exit — only the missing terminal
    // event keeps the turn open until the outer bound.
    expect(collector.text).toBe('这是被截断的部分回答');
    expect(collector.canExit(0)).toBe(true);
    expect(sse.isOpen()).toBe(true);
    expect(result.reason).toBe('wait-timeout');
  });

  // The legacy WS-only path keeps its previous semantics: no own stream, so
  // quiet timeouts and empty classifications behave as before.
  it('keeps legacy WS-only classification when the own stream never starts', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    let wsReads = 0;
    const page = {
      readWsCapture: async () => {
        wsReads += 1;
        if (wsReads > 1) return [];
        return [{
          direction: 'received',
          payload: JSON.stringify([{
            type: 'message',
            topic_id: 'conversation-turn-turn-ws',
            payload: {
              type: 'conversation-turn-stream',
              payload: {
                turn_id: 'turn-ws',
                encoded_item: `data: ${JSON.stringify({
                  type: 'message_stream_complete',
                  conversation_id: CONVERSATION_ID,
                })}\n\n`,
              },
            },
          }]),
        }];
      },
      readSseCapture: async () => ({ chunks: [], dropped: 0 }),
      sleep: async () => {},
    };

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, sseStartGraceMs: 20, timeoutMs: 500, pollMs: 1 }),
    );

    expect(sse.sawOwnStream).toBe(false);
    expect(result).toEqual({ reason: 'protocol-complete-text-empty', text: '' });
  });

  // Artifact resolution must stay sound when the text arrives over HTTP and
  // image generation finishes over the WebSocket channel.
  it('keeps image artifacts collected over WebSockets while text streams over HTTP', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const sseBody = [
      `data: ${JSON.stringify({
        p: '/message/content/parts/0',
        o: 'append',
        v: '正在生成图片。',
        conversation_id: CONVERSATION_ID,
      })}\n\n`,
      `data: ${JSON.stringify({
        o: 'add',
        v: {
          message: {
            id: 'image-tool',
            author: { role: 'tool', name: 'image_gen' },
            content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://draft_image' }] },
            metadata: { async_task_type: 'image_gen', ghostrider: { status: 'intermediate' } },
          },
        },
      })}\n\n`,
    ].join('');
    const sseTail = `data: ${JSON.stringify({ type: 'message_stream_complete' })}\n\ndata: [DONE]\n\n`;
    const wsFinal = [{
      direction: 'received',
      payload: JSON.stringify([{
        type: 'conversation-update',
        payload: {
          conversation_id: CONVERSATION_ID,
          update_type: 'add-messages',
          update_content: {
            messages: [{
              id: 'image-tool',
              conversation_id: CONVERSATION_ID,
              author: { role: 'tool', name: 'image_gen' },
              content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://final_image' }] },
              metadata: { async_task_type: 'image_gen', ghostrider: { status: 'final' } },
            }],
          },
        },
      }]),
    }];

    const page = sseOnlyPage(
      [sseChunk(Buffer.from(sseBody, 'utf8')), sseChunk(Buffer.from(sseTail, 'utf8'))],
      { wsBatches: [[], wsFinal] },
    );

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, pollMs: 1 }),
    );

    expect(result).toEqual({ reason: 'protocol-complete', text: '正在生成图片。' });
    expect(collector.imagePointers.map((pointer) => pointer.id)).toEqual(['draft_image', 'final_image']);
    expect(collector.pendingImageGen).toBe(false);
    expect(collector.imageGenFinalSeen).toBe(true);
  });

  // The WebSocket path stays functional when the HTTP stream never appears.
  it('still completes a WebSocket-only turn', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: CONVERSATION_ID });
    const sse = new SseCaptureStream(collector);
    const page = {
      readWsCapture: async () => [{
        direction: 'received',
        payload: JSON.stringify([{
          type: 'message',
          topic_id: 'conversation-turn-turn-ws',
          payload: {
            type: 'conversation-turn-stream',
            payload: {
              turn_id: 'turn-ws',
              encoded_item: `data: ${JSON.stringify({
                p: '/message/content/parts/0',
                o: 'append',
                v: '旧通道仍然可用',
                conversation_id: CONVERSATION_ID,
              })}\n\ndata: ${JSON.stringify({
                type: 'message_stream_complete',
                conversation_id: CONVERSATION_ID,
              })}\n\n`,
            },
          },
        }]),
      }],
      readSseCapture: async () => ({ chunks: [], dropped: 0 }),
      sleep: async () => {},
    };

    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions({ sse, pollMs: 1 }),
    );

    expect(result).toEqual({ reason: 'protocol-complete', text: '旧通道仍然可用' });
    expect(sse.sawOwnStream).toBe(false);
  });
});

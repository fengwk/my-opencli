import { describe, expect, it } from 'vitest';

import {
  JIMENG_CANVAS_CAPTURE_PATTERN,
  JIMENG_CANVAS_SEND_PATH,
  classifyCanvasSendEntry,
  classifyCanvasSubmitAck,
  extractCanvasSessionId,
  isCanvasSendUrl,
} from '../src/canvas-submit-ack.js';

const TEST_ASSET_ID = 'b7e4f19a2c0d5e68';

function makeEntry(overrides = {}) {
  return {
    url: `https://jimeng.jianying.com${JIMENG_CANVAS_SEND_PATH}`,
    method: 'POST',
    status: 200,
    requestBody: JSON.stringify({
      text: `prefix\n资产编号：${TEST_ASSET_ID}\n---\nprompt`,
      session_id: 'sess-123',
    }),
    responseBody: JSON.stringify({
      code: 0,
      message: 'success',
      session_id: 'sess-123',
    }),
    responseBodyTruncated: false,
    requestBodyTruncated: false,
    ...overrides,
  };
}

describe('jimeng-agent/canvas-submit-ack — URL classification', () => {
  it('identifies canonical canvas send URL', () => {
    expect(JIMENG_CANVAS_CAPTURE_PATTERN).toBe('jimeng.jianying.com/');
    expect(JIMENG_CANVAS_CAPTURE_PATTERN).not.toContain('|');
    expect(isCanvasSendUrl(`https://jimeng.jianying.com${JIMENG_CANVAS_SEND_PATH}`)).toBe(true);
    expect(isCanvasSendUrl('https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation')).toBe(true);
    expect(isCanvasSendUrl('https://jimeng.jianying.com/octo_api/v1/canvas_agent/messages/stream')).toBe(true);
    expect(isCanvasSendUrl('https://jimeng.jianying.com/mweb/v1/creation_agent/v2/get_agent_config')).toBe(false);
    expect(isCanvasSendUrl('https://other.com/octo_api/v1/canvas_agent/messages/send')).toBe(false);
    expect(isCanvasSendUrl('https://jimeng.jianying.com/unrelated/api')).toBe(false);
  });
});

describe('jimeng-agent/canvas-submit-ack — sessionId extraction', () => {
  it('extracts sessionId from various response structures', () => {
    expect(extractCanvasSessionId(JSON.stringify({ session_id: 's1' }))).toBe('s1');
    expect(extractCanvasSessionId(JSON.stringify({ sessionId: 's2' }))).toBe('s2');
    expect(extractCanvasSessionId(JSON.stringify({ data: { session_id: 's3' } }))).toBe('s3');
    expect(extractCanvasSessionId(JSON.stringify({ session: { id: 's4' } }))).toBe('s4');
    expect(extractCanvasSessionId('')).toBe('');
    expect(extractCanvasSessionId(null)).toBe('');
  });
});

describe('jimeng-agent/canvas-submit-ack — entry classification', () => {
  it('classifies successful matching send entry as confirmed', () => {
    const entry = makeEntry();
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('confirmed');
    expect(result.matches).toBe(true);
    expect(result.sessionId).toBe('sess-123');
  });

  it('classifies the legacy conversation SSE protocol when canvas reuses that endpoint', () => {
    const conversationId = '7488349283742819840';
    const threadId = '7488349283742819842';
    const result = classifyCanvasSendEntry(makeEntry({
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      requestBody: JSON.stringify({
        conversation_id: conversationId,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responseBody: `event: handshake\ndata: {"thread_id":"${threadId}","conversation_id":"${conversationId}"}\n\nevent: stream_complete\ndata: {"success":true,"error_code":0}\n\n`,
    }), TEST_ASSET_ID);
    expect(result).toMatchObject({
      kind: 'confirmed',
      matches: true,
      isEndpoint: true,
      sessionId: conversationId,
      threadId,
      conversationId,
    });
  });

  it('classifies entry with different assetId as unrelated', () => {
    const entry = makeEntry({
      requestBody: JSON.stringify({ text: '资产编号：other-id-1234' }),
    });
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('unrelated');
    expect(result.matches).toBe(false);
  });

  it('classifies non-zero code response as rejected', () => {
    const entry = makeEntry({
      responseBody: JSON.stringify({ code: 10403, message: 'Risk control moderation rejected' }),
    });
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('rejected');
    expect(result.errorCode).toBe(10403);
    expect(result.errorMsg).toContain('Risk control');
  });

  it('classifies HTTP 4xx/5xx as rejected', () => {
    const entry = makeEntry({ status: 500, responseBody: 'Internal error' });
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('rejected');
    expect(result.httpStatus).toBe(500);
  });

  it('classifies pending request (no status) as pending', () => {
    const entry = makeEntry({ status: null, responseBody: null });
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('pending');
  });

  it('classifies truncated response as unconfirmed', () => {
    const entry = makeEntry({ responseBodyTruncated: true });
    const result = classifyCanvasSendEntry(entry, TEST_ASSET_ID);
    expect(result.kind).toBe('unconfirmed');
  });

  it('classifies a truncated matching request body as unconfirmed', () => {
    const result = classifyCanvasSendEntry(
      makeEntry({ requestBodyTruncated: true }),
      TEST_ASSET_ID,
    );
    expect(result).toMatchObject({
      kind: 'unconfirmed',
      matches: true,
      isEndpoint: true,
    });
  });

  it('ignores non-POST traffic under a broad capture prefix', () => {
    const result = classifyCanvasSendEntry(makeEntry({
      method: 'GET',
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/get_agent_config',
      requestBody: null,
    }), TEST_ASSET_ID);
    expect(result).toMatchObject({
      kind: 'ignored',
      matches: false,
      isEndpoint: false,
    });
  });

  it('does not treat another creation-agent POST with the assetId as a send ACK', () => {
    const result = classifyCanvasSendEntry(makeEntry({
      method: 'POST',
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/save_draft',
      requestBody: JSON.stringify({ text: `资产编号：${TEST_ASSET_ID}` }),
    }), TEST_ASSET_ID);
    expect(result).toMatchObject({
      kind: 'ignored',
      matches: false,
      isEndpoint: false,
    });
  });

  it('keeps a send endpoint with missing method unconfirmed', () => {
    const result = classifyCanvasSendEntry(makeEntry({ method: undefined }), TEST_ASSET_ID);
    expect(result).toMatchObject({
      kind: 'unconfirmed',
      matches: false,
      isEndpoint: true,
    });
  });
});

describe('jimeng-agent/canvas-submit-ack — classifyCanvasSubmitAck', () => {
  it('returns confirmed when exactly one matching confirmed entry exists', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [makeEntry()],
      assetId: TEST_ASSET_ID,
    });
    expect(ack.kind).toBe('confirmed');
    expect(ack.status).toBe('ack_confirmed');
    expect(ack.sessionId).toBe('sess-123');
  });

  it('returns rejected when matching entry is rejected', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [makeEntry({ responseBody: JSON.stringify({ code: 1001, message: 'quota exceeded' }) })],
      assetId: TEST_ASSET_ID,
    });
    expect(ack.kind).toBe('rejected');
    expect(ack.nonRetryable).toBe(true);
  });

  it('returns not_sent when no send requests were captured', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [],
      assetId: TEST_ASSET_ID,
    });
    expect(ack.kind).toBe('not_sent');
    expect(ack.status).toBe('not_sent');
  });

  it('returns unconfirmed when capture was malformed', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [{ captureMalformed: true }],
      assetId: TEST_ASSET_ID,
    });
    expect(ack.kind).toBe('unconfirmed');
    expect(ack.nonRetryable).toBe(true);
  });

  it('returns unconfirmed when capture result is not an array', () => {
    const ack = classifyCanvasSubmitAck({
      entries: null,
      assetId: TEST_ASSET_ID,
    });
    expect(ack.kind).toBe('unconfirmed');
    expect(ack.nonRetryable).toBe(true);
  });

  it('returns pending for a matching in-flight request before timeout', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [makeEntry({ status: null, responseBody: null })],
      assetId: TEST_ASSET_ID,
      timedOut: false,
    });
    expect(ack.kind).toBe('pending');
  });

  it('returns unconfirmed for POST endpoint traffic without the canonical assetId', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [makeEntry({
        requestBody: JSON.stringify({ text: 'another prompt' }),
      })],
      assetId: TEST_ASSET_ID,
      timedOut: true,
    });
    expect(ack).toMatchObject({
      kind: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 1,
    });
  });

  it('ignores GET configuration traffic captured under the creation-agent prefix', () => {
    const ack = classifyCanvasSubmitAck({
      entries: [makeEntry({
        method: 'GET',
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/get_agent_config',
        requestBody: null,
      })],
      assetId: TEST_ASSET_ID,
      timedOut: true,
    });
    expect(ack).toMatchObject({
      kind: 'not_sent',
      endpointRequestCount: 0,
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  JIMENG_CONVERSATION_PATH,
  classifyConversationEntry,
  classifySubmitAck,
  isConversationEndpoint,
  normalizeCaptureEntry,
  parseConversationSse,
  parseSseEvents,
  requestBodyMatchesAssetId,
} from '../src/submit-ack.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Exact real Canary observed SSE fixture from parent review
const EXACT_CANARY_FIXTURE = `id:d31481f9-9065-4f30-8a18-d069c9b4e877
event:handshake
data:{"thread_id":327598892300,"conversation_id":"ab792c30"}

event:stream_complete
data:{"success":true,"error_code":"0","error_message":"success"}

{"ret":"0","errmsg":"success"}
`;

const CANARY_BUSINESS_REJECTED_SSE = `id:d31481f9-9065-4f30-8a18-d069c9b4e877
event:handshake
data:{"thread_id":327598892300,"conversation_id":"ab792c30"}

event:stream_complete
data:{"success":false,"error_code":"10403","error_message":"Triggered risk control moderation"}
`;

const CANARY_CONTRADICTORY_TRAILER_SSE = `id:d31481f9-9065-4f30-8a18-d069c9b4e877
event:handshake
data:{"thread_id":327598892300,"conversation_id":"ab792c30"}

event:stream_complete
data:{"success":true,"error_code":"0","error_message":"success"}

{"ret":"1001","errmsg":"Post-check risk moderation failed"}
`;

const CANARY_ERROR_EVENT_SSE = `id:err-1
event:error
data:{"error_code":"10001","error_message":"Account token expired"}
`;

const CANARY_TRUNCATED_SSE = `id:d31481f9-9065-4f30-8a18-d069c9b4e877
event:handshake
data:{"thread_id":327598892300,"conversation_id":"ab792c30"}

event:progress
data:{"status":"generating"
`;

const TEST_ASSET_ID = 'b7e4f19a2c0d5e68';
const TEST_CONVERSATION_ID = 'ab792c30';

describe('jimeng-agent/submit-ack — SSE Parsing with Exact Canary Fixture', () => {
  it('parses exact canary SSE with id: and trailer without losing handshake', () => {
    const events = parseSseEvents(EXACT_CANARY_FIXTURE);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const parsed = parseConversationSse(EXACT_CANARY_FIXTURE);
    expect(parsed.handshake).toMatchObject({
      threadId: '327598892300',
      conversationId: 'ab792c30',
    });
    expect(parsed.streamComplete).toMatchObject({
      success: true,
      errorCode: 0,
      errorMsg: 'success',
    });
    expect(parsed.errorEvent).toBeNull();
    expect(parsed.protocolIssues).toEqual([]);
    expect(parsed.isTruncated).toBe(false);
  });

  it('rejects a contradictory error in the trailing envelope', () => {
    const parsed = parseConversationSse(CANARY_CONTRADICTORY_TRAILER_SSE);
    expect(parsed.streamComplete?.success).toBe(false);
    expect(parsed.errorEvent).not.toBeNull();
    expect(parsed.errorEvent?.errorCode).toBe(1001);
    // A success event plus a rejecting trailer is ambiguous, never a clean rejection/ACK.
    expect(parsed.protocolIssues).toContain(
      'A trailer error contradicted a successful stream completion',
    );
  });

  it('handles numeric and string error codes and retry: lines in SSE', () => {
    const raw = `retry: 3000\nid: 1\nevent: error\ndata: {"error_code": "10001", "error_message": "Invalid token"}\n\n`;
    const parsed = parseConversationSse(raw);
    expect(parsed.errorEvent).toMatchObject({
      errorCode: 10001,
      errorMsg: 'Invalid token',
    });
  });

  it('flags truncated stream when handshake exists but stream_complete is missing', () => {
    const parsed = parseConversationSse(CANARY_TRUNCATED_SSE);
    expect(parsed.handshake).not.toBeNull();
    expect(parsed.streamComplete).toBeNull();
    expect(parsed.isTruncated).toBe(true);
  });

  it('does not infer success when stream_complete omits success or error_code', () => {
    const missingSuccess = parseConversationSse(`event:handshake
data:{"thread_id":"327598892300","conversation_id":"${TEST_CONVERSATION_ID}"}

event:stream_complete
data:{"error_code":"0"}

`);
    expect(missingSuccess.streamComplete).toMatchObject({
      success: false,
      explicitFailure: false,
      protocolComplete: false,
    });

    const missingCode = parseConversationSse(`event:handshake
data:{"thread_id":"327598892300","conversation_id":"${TEST_CONVERSATION_ID}"}

event:stream_complete
data:{"success":true}

`);
    expect(missingCode.streamComplete).toMatchObject({
      success: false,
      explicitFailure: false,
      protocolComplete: false,
    });
  });

  it('does not treat malformed error_code container types as integer zero', () => {
    const parsed = parseConversationSse(`event:handshake
data:{"thread_id":"327598892300","conversation_id":"${TEST_CONVERSATION_ID}"}

event:stream_complete
data:{"success":true,"error_code":[0]}

`);
    // JSON coercion would turn [0] into numeric zero; strict parsing must not.
    expect(parsed.streamComplete).toMatchObject({
      success: false,
      explicitFailure: false,
      protocolComplete: false,
      errorCode: null,
    });
    expect(parsed.protocolIssues).toContain('stream_complete error_code is not an integer');
  });

  it('records conflicting handshake events instead of accepting the last one', () => {
    const parsed = parseConversationSse(`event:handshake
data:{"thread_id":"first-thread","conversation_id":"first-conversation"}

event:handshake
data:{"thread_id":"second-thread","conversation_id":"${TEST_CONVERSATION_ID}"}

event:stream_complete
data:{"success":true,"error_code":"0"}

`);
    expect(parsed.handshake).toMatchObject({
      threadId: 'first-thread',
      conversationId: 'first-conversation',
    });
    expect(parsed.protocolIssues).toContain('Conflicting handshake events were received');
  });

  it('does not promote unrelated success payloads into handshake or stream_complete events', () => {
    const parsed = parseConversationSse(`event:progress
data:{"thread_id":"327598892300","success":true,"error_code":"0"}

`);
    expect(parsed.handshake).toBeNull();
    expect(parsed.streamComplete).toBeNull();
  });
});

describe('jimeng-agent/submit-ack — Capture Normalization & OpenCLI Fields', () => {
  it('normalizes OpenCLI preview fields: responseStatus, requestBodyPreview, responsePreview, responseBodyTruncated', () => {
    const realOpenCliEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: EXACT_CANARY_FIXTURE,
      responseBodyTruncated: false,
    };
    const norm = normalizeCaptureEntry(realOpenCliEntry);
    expect(norm.status).toBe(200);
    expect(norm.requestBody).toContain(TEST_ASSET_ID);
    expect(norm.responseBody).toContain('thread_id');
    expect(norm.responseBodyTruncated).toBe(false);

    const classification = classifyConversationEntry(realOpenCliEntry, TEST_ASSET_ID);
    expect(classification).toMatchObject({
      matches: true,
      kind: 'confirmed',
      status: 'confirmed',
      threadId: '327598892300',
      conversationId: 'ab792c30',
      httpStatus: 200,
    });
  });

  it('classifies missing HTTP status as unconfirmed (never defaults to 200)', () => {
    const entryMissingStatus = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: EXACT_CANARY_FIXTURE,
    };
    const norm = normalizeCaptureEntry(entryMissingStatus);
    expect(norm.status).toBeNull();

    const classification = classifyConversationEntry(entryMissingStatus, TEST_ASSET_ID);
    expect(classification).toMatchObject({
      matches: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      nonRetryable: true,
      httpStatus: null,
    });
  });

  it('classifies responseBodyTruncated=true as unconfirmed even with valid partial payload', () => {
    const truncatedCapture = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: EXACT_CANARY_FIXTURE,
      responseBodyTruncated: true,
    };
    const classification = classifyConversationEntry(truncatedCapture, TEST_ASSET_ID);
    expect(classification).toMatchObject({
      matches: true,
      kind: 'unconfirmed',
      status: 'unconfirmed',
      nonRetryable: true,
    });
    expect(classification.reason).toContain('truncated');
  });

  it('normalizes nested request fields but marks entries without any URL as malformed', () => {
    const nested = normalizeCaptureEntry({
      request: {
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        postData: JSON.stringify({ prompt: `资产编号：${TEST_ASSET_ID}` }),
      },
      response: {
        status: 200,
        body: EXACT_CANARY_FIXTURE,
      },
    });
    expect(nested).toMatchObject({
      method: 'POST',
      status: 200,
      captureMalformed: false,
    });
    expect(nested.url).toContain(JIMENG_CONVERSATION_PATH);
    expect(normalizeCaptureEntry(null).captureMalformed).toBe(true);
    expect(normalizeCaptureEntry({ method: 'POST' }).captureMalformed).toBe(true);
  });
});

describe('jimeng-agent/submit-ack — Endpoint Host Verification & Asset Correlation', () => {
  it('requires host jimeng.jianying.com and exact path /mweb/v1/creation_agent/v2/conversation', () => {
    expect(isConversationEndpoint('https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(true);
    expect(isConversationEndpoint('https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation?aid=1', 'post')).toBe(true);

    // Reject arbitrary host with same path
    expect(isConversationEndpoint('https://attacker.com/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    expect(isConversationEndpoint('https://proxy.jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    expect(isConversationEndpoint('http://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    expect(isConversationEndpoint('https://jimeng.jianying.com:444/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    expect(isConversationEndpoint('/mweb/v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    expect(isConversationEndpoint('https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation', '')).toBe(false);
    expect(isConversationEndpoint('https://jimeng.jianying.com/mweb//v1/creation_agent/v2/conversation', 'POST')).toBe(false);
    // Reject other paths on jimeng
    expect(isConversationEndpoint('https://jimeng.jianying.com/mweb/search/v1/search', 'POST')).toBe(false);
    // Reject telemetry
    expect(isConversationEndpoint('https://mcs.zijieapi.com/webid/click_agent_generate', 'POST')).toBe(false);
  });

  it('correlates only the canonical labeled asset id, not an arbitrary substring', () => {
    expect(requestBodyMatchesAssetId({
      requestBodyPreview: JSON.stringify({ prompt: `unlabeled ${TEST_ASSET_ID}` }),
    }, TEST_ASSET_ID)).toBe(false);
    expect(requestBodyMatchesAssetId({
      requestBodyPreview: JSON.stringify({ prompt: `资产编号：${TEST_ASSET_ID}` }),
    }, TEST_ASSET_ID)).toBe(true);
    expect(requestBodyMatchesAssetId({
      requestBodyPreview: {
        messages: [{ content: `资产编号：${TEST_ASSET_ID}` }],
      },
    }, TEST_ASSET_ID)).toBe(true);
  });

  it('returns unconfirmed when an endpoint request exists but cannot be correlated, never not_sent', () => {
    const uncorrelatableEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: null, // body unavailable
      responsePreview: EXACT_CANARY_FIXTURE,
    };

    const ack = classifySubmitAck({
      entries: [uncorrelatableEntry],
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState: { assetIdInComposer: true, assetIdOutsideComposer: false },
    });

    expect(ack).toMatchObject({
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 1,
      nonRetryable: true,
    });
  });

  it('returns unconfirmed when an exact endpoint capture omits its HTTP method', () => {
    const ack = classifySubmitAck({
      entries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        responseStatus: 200,
        requestBodyPreview: JSON.stringify({
          conversation_id: TEST_CONVERSATION_ID,
          prompt: `资产编号：${TEST_ASSET_ID}`,
        }),
        responsePreview: EXACT_CANARY_FIXTURE,
      }],
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState: { assetIdInComposer: true, assetIdOutsideComposer: false },
    });
    expect(ack).toMatchObject({
      kind: 'unconfirmed',
      endpointRequestCount: 1,
      nonRetryable: true,
    });
  });

  it('returns not_sent ONLY when 0 endpoint requests exist and assetId remains solely in composer', () => {
    const ack = classifySubmitAck({
      entries: [],
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState: { assetIdInComposer: true, assetIdOutsideComposer: false },
    });

    expect(ack).toMatchObject({
      kind: 'not_sent',
      status: 'not_sent',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
      retryable: true,
    });
  });

  it('returns unconfirmed when 0 requests were captured but assetId moved outside composer', () => {
    const ack = classifySubmitAck({
      entries: [],
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState: { assetIdInComposer: false, assetIdOutsideComposer: true },
    });

    expect(ack).toMatchObject({
      kind: 'unconfirmed',
      status: 'unconfirmed',
      matchingRequestCount: 0,
      endpointRequestCount: 0,
      nonRetryable: true,
    });
  });

  it('never downgrades malformed capture output to a retryable not-sent state', () => {
    const pageState = { assetIdInComposer: true, assetIdOutsideComposer: false };
    expect(classifySubmitAck({
      entries: [null],
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState,
    })).toMatchObject({
      kind: 'unconfirmed',
      malformedCaptureEntryCount: 1,
      nonRetryable: true,
    });
    expect(classifySubmitAck({
      entries: {},
      assetId: TEST_ASSET_ID,
      timedOut: true,
      pageState,
    })).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
  });

  it('requires request and handshake conversation IDs to be present and equal', () => {
    const baseEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      responsePreview: EXACT_CANARY_FIXTURE,
    };

    const missingRequestConversation = classifyConversationEntry({
      ...baseEntry,
      requestBodyPreview: JSON.stringify({ prompt: `资产编号：${TEST_ASSET_ID}` }),
    }, TEST_ASSET_ID);
    expect(missingRequestConversation).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });

    const mismatchedConversation = classifyConversationEntry({
      ...baseEntry,
      requestBodyPreview: JSON.stringify({
        conversation_id: 'different-conversation',
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
    }, TEST_ASSET_ID);
    expect(mismatchedConversation).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
    expect(mismatchedConversation.reason).toContain('mismatch');
  });

  it('rejects non-string/non-safe-integer handshake identifiers as unconfirmed', () => {
    const classification = classifyConversationEntry({
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: { malformed: true },
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: `event:handshake
data:{"thread_id":{"malformed":true},"conversation_id":{"malformed":true}}

event:stream_complete
data:{"success":true,"error_code":"0"}

`,
    }, TEST_ASSET_ID);
    expect(classification).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
    expect(classification.reason).toContain('invalid type');
  });

  it('treats a truncated request body as unconfirmed even when its preview contains the assetId', () => {
    expect(classifyConversationEntry({
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      requestBodyTruncated: true,
      responsePreview: EXACT_CANARY_FIXTURE,
    }, TEST_ASSET_ID)).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
  });

  it('classifies malformed stream_complete as unconfirmed rather than rejected or confirmed', () => {
    const entry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: `event:handshake
data:{"thread_id":"327598892300","conversation_id":"${TEST_CONVERSATION_ID}"}

event:stream_complete
data:{"success":true}

`,
    };

    expect(classifyConversationEntry(entry, TEST_ASSET_ID)).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
  });

  it('classifies contradictory error and success events as unconfirmed', () => {
    const entry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: `event:handshake
data:{"thread_id":"327598892300","conversation_id":"${TEST_CONVERSATION_ID}"}

event:error
data:{"error_code":"1001","error_message":"temporary protocol error"}

event:stream_complete
data:{"success":true,"error_code":"0","error_message":"success"}

`,
    };

    expect(classifyConversationEntry(entry, TEST_ASSET_ID)).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
  });

  it('classifies a success event followed by a rejecting trailer as unconfirmed', () => {
    const classification = classifyConversationEntry({
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: CANARY_CONTRADICTORY_TRAILER_SSE,
    }, TEST_ASSET_ID);
    expect(classification).toMatchObject({
      kind: 'unconfirmed',
      nonRetryable: true,
    });
    expect(classification.reason).toContain('protocol conflict');
  });

  it('fails closed when a confirmed response coexists with another endpoint request', () => {
    const confirmedEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: EXACT_CANARY_FIXTURE,
    };
    const unrelatedEndpointEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({
        conversation_id: 'another-conversation',
        prompt: 'another request',
      }),
      responsePreview: '',
    };

    expect(classifySubmitAck({
      entries: [confirmedEntry, unrelatedEndpointEntry],
      assetId: TEST_ASSET_ID,
      timedOut: true,
    })).toMatchObject({
      kind: 'unconfirmed',
      matchingRequestCount: 1,
      endpointRequestCount: 2,
      nonRetryable: true,
    });
  });

  it('fails closed when a rejection coexists with an uncorrelated endpoint request', () => {
    const rejectedEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 403,
      requestBodyPreview: JSON.stringify({
        conversation_id: TEST_CONVERSATION_ID,
        prompt: `资产编号：${TEST_ASSET_ID}`,
      }),
      responsePreview: JSON.stringify({ error_msg: 'Forbidden' }),
    };
    const uncorrelatedEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      responseStatus: 200,
      requestBodyPreview: JSON.stringify({ prompt: 'different request' }),
      responsePreview: '',
    };

    expect(classifySubmitAck({
      entries: [rejectedEntry, uncorrelatedEntry],
      assetId: TEST_ASSET_ID,
      timedOut: true,
    })).toMatchObject({
      kind: 'unconfirmed',
      matchingRequestCount: 1,
      endpointRequestCount: 2,
      nonRetryable: true,
    });
  });
});

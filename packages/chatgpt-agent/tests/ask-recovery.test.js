import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureIdleSurfaceWithRecovery = vi.fn();
const recoverChatSurfaceAfterFailure = vi.fn();

vi.mock('../src/session-recovery.js', () => ({
  ensureIdleSurfaceWithRecovery: (...args) => ensureIdleSurfaceWithRecovery(...args),
  recoverChatSurfaceAfterFailure: (...args) => recoverChatSurfaceAfterFailure(...args),
}));

const ensureChatGPTLogin = vi.fn();
const ensureChatGPTComposer = vi.fn();
const startNewChat = vi.fn();
const clearChatGPTDraft = vi.fn();
const sendChatGPTMessage = vi.fn();
const currentChatGPTUrl = vi.fn();

vi.mock('../src/host-chatgpt.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureChatGPTLogin: (...args) => ensureChatGPTLogin(...args),
    ensureChatGPTComposer: (...args) => ensureChatGPTComposer(...args),
    startNewChat: (...args) => startNewChat(...args),
    clearChatGPTDraft: (...args) => clearChatGPTDraft(...args),
    sendChatGPTMessage: (...args) => sendChatGPTMessage(...args),
    currentChatGPTUrl: (...args) => currentChatGPTUrl(...args),
  };
});

const ensureHealthyChatSurface = vi.fn();
const probeChatSurface = vi.fn();

vi.mock('../src/page-health.js', () => ({
  ensureHealthyChatSurface: (...args) => ensureHealthyChatSurface(...args),
  probeChatSurface: (...args) => probeChatSurface(...args),
}));

const waitForProtocolStream = vi.fn();
vi.mock('../src/wait-stream.js', () => ({
  waitForProtocolStream: (...args) => waitForProtocolStream(...args),
}));

const resolveArtifacts = vi.fn();
const hasReturnableArtifacts = vi.fn();
vi.mock('../src/resolve.js', () => ({
  resolveArtifacts: (...args) => resolveArtifacts(...args),
  hasReturnableArtifacts: (...args) => hasReturnableArtifacts(...args),
}));

const exportNewImagesLikeOfficial = vi.fn();
const snapshotVisibleImageUrls = vi.fn();
const resolveImageOutputDir = vi.fn((p) => p || '/tmp/pictures');
vi.mock('../src/image-export.js', () => ({
  exportNewImagesLikeOfficial: (...args) => exportNewImagesLikeOfficial(...args),
  snapshotVisibleImageUrls: (...args) => snapshotVisibleImageUrls(...args),
  resolveImageOutputDir: (...args) => resolveImageOutputDir(...args),
}));

const { askCommand } = await import('../ask.js');

describe('chatgpt-agent/ask recovery execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureHealthyChatSurface.mockResolvedValue({ recovered: false });
    ensureIdleSurfaceWithRecovery.mockResolvedValue({ ok: true });
    recoverChatSurfaceAfterFailure.mockResolvedValue({});
    snapshotVisibleImageUrls.mockResolvedValue([]);
    sendChatGPTMessage.mockResolvedValue(true);
    currentChatGPTUrl.mockResolvedValue('https://chatgpt.com/c/c-test-123');
    waitForProtocolStream.mockResolvedValue({ reason: 'stream-end' });
    hasReturnableArtifacts.mockReturnValue(true);
  });

  function fakePage() {
    return {
      sleep: vi.fn(async () => {}),
      startWsCapture: vi.fn(async () => true),
      stopWsCapture: vi.fn(async () => {}),
      startSseCapture: vi.fn(async () => true),
      readSseCapture: vi.fn(async () => ({ chunks: [], dropped: 0 })),
      stopSseCapture: vi.fn(async () => {}),
    };
  }

  /**
   * One own-POST HTTP-stream chunk carrying an append patch plus the stream's
   * conversation id and terminal event.
   */
  function sseTurnChunk(text, conversationId = 'cid-ask-sse', { done = true } = {}) {
    const body = `data: ${JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: text,
      conversation_id: conversationId,
    })}\n\n${done ? 'data: [DONE]\n\n' : ''}`;
    return {
      kind: 'sse-chunk',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      requestId: 'req-ask-1',
      timestamp: Date.now(),
      payload: `base64:${Buffer.from(body, 'utf8').toString('base64')}`,
      payloadTruncated: false,
    };
  }

  // Pre-send idle check must run hard recovery if generating, and throw STILL_GENERATING if recovery fails.
  it('pre-send throws STILL_GENERATING when ensureIdleSurfaceWithRecovery reports ok=false', async () => {
    const page = fakePage();
    ensureIdleSurfaceWithRecovery.mockResolvedValue({
      ok: false,
      stillGenerating: true,
      recovered: true,
    });

    await expect(askCommand.func(page, { prompt: 'hello' })).rejects.toThrow(
      /STILL_GENERATING/,
    );
    expect(ensureIdleSurfaceWithRecovery).toHaveBeenCalledTimes(1);
    expect(ensureIdleSurfaceWithRecovery).toHaveBeenCalledWith(page, expect.objectContaining({
      hardReset: expect.any(Function),
    }));
  });

  it('reports the live surface as busy so an in-flight turn is not cut short', async () => {
    const page = fakePage();
    probeChatSurface.mockResolvedValue({
      composer: true,
      broken: false,
      generating: true,
      generationFailed: false,
    });
    let busy;
    waitForProtocolStream.mockImplementationOnce(async (_page, _collector, options) => {
      busy = await options.isPageBusy();
      return { reason: 'stream-end' };
    });

    await askCommand.func(page, { prompt: 'hello' });

    expect(busy).toBe(true);
    expect(waitForProtocolStream).toHaveBeenCalledWith(page, expect.anything(), expect.objectContaining({
      isPageBusy: expect.any(Function),
      checkPage: expect.any(Function),
    }));
  });

  it('maps a generation-failed page check to an actionable command error', async () => {
    const page = fakePage();
    probeChatSurface.mockResolvedValue({
      composer: true,
      broken: true,
      generationFailed: true,
    });
    waitForProtocolStream.mockImplementationOnce(async (_page, _collector, options) => {
      await options.checkPage();
      return { reason: 'unreachable' };
    });

    await expect(askCommand.func(page, { prompt: 'hello' })).rejects.toThrow(
      /GENERATION_FAILED: ChatGPT showed a generation error banner/,
    );
    expect(recoverChatSurfaceAfterFailure).toHaveBeenCalledWith(page, expect.objectContaining({
      hardReset: expect.any(Function),
    }));
  });

  // Successful image turns run bounded idle recovery before return, and preserve results when cleanup fails.
  it('runs post-image idle recovery with the same helper and preserves image output when cleanup fails', async () => {
    const page = fakePage();
    resolveArtifacts.mockResolvedValue({
      text: 'Here is your image',
      files: [],
      images: [{ id: 'img-1', name: 'image.png' }],
    });
    exportNewImagesLikeOfficial.mockResolvedValue([{
      kind: 'image-export',
      downloaded: true,
      path: '/tmp/pictures/image.png',
    }]);

    // Pre-send returns ok=true, post-image cleanup returns ok=false.
    ensureIdleSurfaceWithRecovery
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, stillGenerating: true, recovered: true });

    const result = await askCommand.func(page, { prompt: 'draw a cat' });
    expect(exportNewImagesLikeOfficial).toHaveBeenCalledWith(page, expect.objectContaining({
      pollIterations: 60,
      canContinue: expect.any(Function),
    }));
    expect(ensureIdleSurfaceWithRecovery).toHaveBeenCalledTimes(2);
    expect(ensureIdleSurfaceWithRecovery).toHaveBeenNthCalledWith(2, page, expect.objectContaining({
      session: '',
      hardReset: expect.any(Function),
    }));
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Here is your image');
    expect(JSON.parse(result[0].downloads)).toHaveLength(1);
    expect(JSON.parse(result[0].downloads)[0].path).toBe('/tmp/pictures/image.png');
  });

  // Post-image cleanup is best-effort and must not discard successfully exported images.
  it('preserves image output even if post-image cleanup throws an error', async () => {
    const page = fakePage();
    resolveArtifacts.mockResolvedValue({
      text: 'Here is your image',
      files: [],
      images: [{ id: 'img-1', name: 'image.png' }],
    });
    exportNewImagesLikeOfficial.mockResolvedValue([{
      kind: 'image-export',
      downloaded: true,
      path: '/tmp/pictures/image.png',
    }]);

    ensureIdleSurfaceWithRecovery
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('transient cleanup error'));

    const result = await askCommand.func(page, { prompt: 'draw a cat' });
    expect(ensureIdleSurfaceWithRecovery).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Here is your image');
    expect(JSON.parse(result[0].downloads)).toHaveLength(1);
    expect(JSON.parse(result[0].downloads)[0].path).toBe('/tmp/pictures/image.png');
  });

  // Both captures must be armed before the prompt is sent, the HTTP-stream
  // reader must feed the same collector the wait loop drains, and both captures
  // must be disarmed afterwards.
  it('arms HTTP-stream + WS capture before send, wires the reader and disarms both', async () => {
    const page = fakePage();
    const order = [];
    page.startWsCapture.mockImplementation(async () => {
      order.push('ws-arm');
      return true;
    });
    page.startSseCapture.mockImplementation(async () => {
      order.push('sse-arm');
      return true;
    });
    page.stopWsCapture.mockImplementation(async () => {
      order.push('ws-stop');
    });
    page.stopSseCapture.mockImplementation(async () => {
      order.push('sse-stop');
    });
    sendChatGPTMessage.mockImplementation(async () => {
      order.push('send');
      return true;
    });
    currentChatGPTUrl.mockResolvedValue('https://chatgpt.com/c/cid-ask-sse');
    resolveArtifacts.mockResolvedValue({
      text: 'SSE 回答',
      files: [],
      images: [],
      sources: [],
    });

    let wired = null;
    let wiredCollector = null;
    waitForProtocolStream.mockImplementationOnce(async (_page, collector, options) => {
      wired = options;
      wiredCollector = collector;
      // The turn's HTTP stream is the only transport that carries content.
      options.sse.ingestRead({ chunks: [sseTurnChunk('SSE 回答')], dropped: 0 });
      expect(collector.text).toBe('SSE 回答');
      return { reason: 'protocol-complete' };
    });

    const result = await askCommand.func(page, { prompt: 'hello' });

    expect(page.startSseCapture).toHaveBeenCalledWith('https://chatgpt.com/backend-api/f/conversation');
    expect(wired.sse).toBeTruthy();
    // The reader must feed the same collector the wait loop polls.
    expect(wired.sse.collector).toBe(wiredCollector);
    expect(order).toEqual(['ws-arm', 'sse-arm', 'send', 'sse-stop', 'ws-stop']);
    expect(result[0].source).toBe('sse');
    expect(result[0].text).toBe('SSE 回答');
  });

  // Without a new fork API the command must fail before the prompt is sent and
  // must not touch the (untouched) shell.
  it('fails before send when the HTTP-stream capture API is unavailable', async () => {
    const page = fakePage();
    delete page.startSseCapture;
    delete page.readSseCapture;

    await expect(askCommand.func(page, { prompt: 'hello' })).rejects.toThrow(/SSE_CAPTURE_UNSUPPORTED/);
    expect(sendChatGPTMessage).not.toHaveBeenCalled();
    expect(recoverChatSurfaceAfterFailure).not.toHaveBeenCalled();
  });

  // A mismatched extension must not leave WS capture armed on the tab.
  it('disarms WS capture and fails before send when the extension cannot arm HTTP-stream capture', async () => {
    const page = fakePage();
    page.startSseCapture.mockResolvedValue(false);

    await expect(askCommand.func(page, { prompt: 'hello' })).rejects.toThrow(
      /SSE_CAPTURE_UNSUPPORTED: Browser Bridge extension does not support sse-capture-start/,
    );
    expect(page.stopWsCapture).toHaveBeenCalledTimes(1);
    expect(sendChatGPTMessage).not.toHaveBeenCalled();
  });

  // An incomplete captured stream must fail loudly and still clean up captures
  // and the shell (the prompt was already sent).
  it('surfaces an incomplete HTTP-stream capture as an actionable failure', async () => {
    const page = fakePage();
    waitForProtocolStream.mockImplementationOnce(async (_page, _collector, options) => {
      options.sse.ingestRead({ chunks: [sseTurnChunk('部分')], dropped: 2 });
      return { reason: 'unreachable' };
    });

    await expect(askCommand.func(page, { prompt: 'hello' })).rejects.toThrow(
      /SSE_CAPTURE_INCOMPLETE: 2 captured HTTP-stream chunk\(s\) were evicted/,
    );
    expect(page.stopSseCapture).toHaveBeenCalledTimes(1);
    expect(page.stopWsCapture).toHaveBeenCalledTimes(1);
    expect(recoverChatSurfaceAfterFailure).toHaveBeenCalledTimes(1);
  });

  // An own stream that started but never reported its terminal event must never
  // be returned as a partial success, even though artifacts would resolve and
  // the wait loop only stopped at the user --timeout bound.
  it('fails closed instead of returning a partial answer when the own stream never completed', async () => {
    const page = fakePage();
    currentChatGPTUrl.mockResolvedValue('https://chatgpt.com/c/cid-ask-sse');
    resolveArtifacts.mockResolvedValue({
      text: '被截断的部分回答',
      files: [],
      images: [],
      sources: [],
    });
    waitForProtocolStream.mockImplementationOnce(async (_page, _collector, options) => {
      // Text arrives without the stream's terminal event, then the stream stalls.
      options.sse.ingestRead({
        chunks: [sseTurnChunk('被截断的部分回答', 'cid-ask-sse', { done: false })],
        dropped: 0,
      });
      return { reason: 'wait-timeout', text: '被截断的部分回答' };
    });

    const err = await askCommand.func(page, { prompt: 'hello' }).then(() => null, (e) => e);

    expect(err).toBeTruthy();
    expect(err.message).toMatch(
      /SSE_CAPTURE_INCOMPLETE: the turn response did not report completion before the wait ended/,
    );
    // The partial answer must not be echoed, resolved, or returned.
    expect(`${err.message}\n${err.hint || ''}`).not.toContain('被截断的部分回答');
    expect(resolveArtifacts).not.toHaveBeenCalled();
    expect(recoverChatSurfaceAfterFailure).toHaveBeenCalledTimes(1);
    expect(page.stopSseCapture).toHaveBeenCalledTimes(1);
    expect(page.stopWsCapture).toHaveBeenCalledTimes(1);
  });

  // Legacy WS-only semantics are untouched: without an own stream a timeout may
  // still return the artifacts that were already collected.
  it('keeps returning collected artifacts on wait-timeout when no own stream started', async () => {
    const page = fakePage();
    resolveArtifacts.mockResolvedValue({
      text: '部分回答',
      files: [],
      images: [],
      sources: [],
    });
    waitForProtocolStream.mockResolvedValue({ reason: 'wait-timeout', text: '部分回答' });

    const result = await askCommand.func(page, { prompt: 'hello' });

    expect(result[0].text).toBe('部分回答');
  });

  // CDP errorText can quote the request URL (query string included): the command
  // failure must stay generic and must not echo the browser's failure text.
  it('does not echo the raw browser capture error in the command failure', async () => {
    const page = fakePage();
    waitForProtocolStream.mockImplementationOnce(async (_page, _collector, options) => {
      options.sse.ingestRead({
        chunks: [{
          ...sseTurnChunk('x'),
          kind: 'sse-error',
          payload: undefined,
          error: 'Network.streamResourceContent failed for https://chatgpt.com/backend-api/f/conversation?token=SECRET-TOKEN-9',
        }],
        dropped: 0,
      });
      return { reason: 'unreachable' };
    });

    const err = await askCommand.func(page, { prompt: 'hello' }).then(() => null, (e) => e);

    expect(err).toBeTruthy();
    expect(err.message).toMatch(/SSE_CAPTURE_UNSUPPORTED/);
    const surfaced = `${err.message}\n${err.hint || ''}`;
    expect(surfaced).not.toContain('SECRET-TOKEN-9');
    expect(surfaced).not.toContain('token=');
    expect(surfaced).not.toContain('backend-api');
  });

  // WebSocket-only turns (image/file flows) keep reporting the legacy source.
  it('reports the ws source when no HTTP-stream event was consumed', async () => {
    const page = fakePage();
    resolveArtifacts.mockResolvedValue({
      text: '来自协议流的回答',
      files: [],
      images: [],
      sources: [],
    });

    const result = await askCommand.func(page, { prompt: 'hello' });

    expect(result[0].source).toBe('ws');
  });
});

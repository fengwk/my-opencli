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

describe('chatgpt-agent/ask command registration', () => {
  it('defaults the remote protocol turn timeout to 1200 seconds', () => {
    // Keep the plugin contract aligned with the wrapper Skill default.
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout).toMatchObject({ type: 'int', default: 1200 });
    expect(timeout.help).toContain('default 1200');
  });
});

describe('chatgpt-agent/ask execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureHealthyChatSurface.mockResolvedValue({ recovered: false });
    ensureIdleSurfaceWithRecovery.mockResolvedValue({ ok: true });
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

    // Pre-send returns ok=true, post-image cleanup returns ok=false (or throws)
    ensureIdleSurfaceWithRecovery
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, stillGenerating: true, recovered: true });

    const result = await askCommand.func(page, { prompt: 'draw a cat' });
    expect(exportNewImagesLikeOfficial).toHaveBeenCalledWith(page, expect.objectContaining({
      pollIterations: 60,
      canContinue: expect.any(Function),
    }));
    // Both pre-send and post-image use ensureIdleSurfaceWithRecovery
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

  // Post-image cleanup preserves results even if ensureIdleSurfaceWithRecovery throws an exception.
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

    // Pre-send returns ok=true, post-image cleanup throws
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
});

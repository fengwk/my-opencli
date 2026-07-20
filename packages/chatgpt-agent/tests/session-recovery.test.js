import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearChatGPTDraft = vi.fn(async () => true);
const startNewChat = vi.fn(async () => {});
const probeChatSurface = vi.fn();

vi.mock('../src/host-chatgpt.js', () => ({
  clearChatGPTDraft: (...args) => clearChatGPTDraft(...args),
  startNewChat: (...args) => startNewChat(...args),
}));

vi.mock('../src/page-health.js', () => ({
  probeChatSurface: (...args) => probeChatSurface(...args),
}));

const {
  ensureNotGenerating,
  isChatGPTGenerating,
  recoverChatSurfaceAfterFailure,
  stopChatGPTGeneration,
} = await import('../src/session-recovery.js');

function fakePage({ evaluateResults = [], sleep = vi.fn(async () => {}) } = {}) {
  let idx = 0;
  return {
    sleep,
    evaluate: vi.fn(async () => {
      if (!evaluateResults.length) return false;
      const value = evaluateResults[Math.min(idx, evaluateResults.length - 1)];
      idx += 1;
      return value;
    }),
  };
}

describe('session-recovery', () => {
  beforeEach(() => {
    clearChatGPTDraft.mockClear();
    startNewChat.mockClear();
    probeChatSurface.mockReset();
  });

  // Stop must click the stop control when ChatGPT leaves a turn mid-flight.
  it('stopChatGPTGeneration returns whether a stop control was clicked', async () => {
    const page = fakePage({ evaluateResults: [true] });
    await expect(stopChatGPTGeneration(page)).resolves.toBe(true);
    expect(page.evaluate).toHaveBeenCalledOnce();
  });

  // Ensure we wait for generation, then stop once the budget is exhausted.
  it('ensureNotGenerating waits then stops a stuck generation', async () => {
    const page = fakePage({
      evaluateResults: [
        true,  // generating
        true,  // stop clicked
        false, // final generating
      ],
      sleep: vi.fn(async () => {}),
    });
    const result = await ensureNotGenerating(page, { timeoutSec: 0, pollSec: 0.05 });
    expect(result.waited).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.stillGenerating).toBe(false);
  });

  // Failure recovery must stop generation and hard-reset when the shell is dirty.
  it('recoverChatSurfaceAfterFailure hard-resets an errorish generating shell', async () => {
    const hardReset = vi.fn(async () => {});
    const page = fakePage({
      evaluateResults: [
        true,  // stop
        true,  // stop after reset
      ],
    });
    probeChatSurface
      .mockResolvedValueOnce({
        url: 'https://chatgpt.com/c/abc',
        composer: true,
        errorish: true,
        broken: true,
      })
      .mockResolvedValueOnce({
        url: 'https://chatgpt.com/',
        composer: true,
        errorish: false,
        broken: false,
      });

    // isChatGPTGenerating uses page.evaluate; sequence after stop:
    // first generating check uses evaluateResults after stop's evaluate.
    // stop consumes true; generating checks need values.
    // Rebuild page with a clearer sequence:
    const page2 = fakePage({
      evaluateResults: [
        true,  // stop initial
        true,  // generating after probe
        true,  // stop after reset
        false, // generating final
      ],
    });
    probeChatSurface.mockReset();
    probeChatSurface
      .mockResolvedValueOnce({
        url: 'https://chatgpt.com/c/abc',
        composer: true,
        errorish: true,
        broken: true,
      })
      .mockResolvedValueOnce({
        url: 'https://chatgpt.com/',
        composer: true,
        errorish: false,
        broken: false,
      });

    const result = await recoverChatSurfaceAfterFailure(page2, { hardReset });
    expect(hardReset).toHaveBeenCalledOnce();
    expect(clearChatGPTDraft).toHaveBeenCalled();
    expect(result.reset).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.generating).toBe(false);
  });

  it('isChatGPTGenerating returns false when evaluate fails', async () => {
    const page = {
      evaluate: vi.fn(async () => {
        throw new Error('detached');
      }),
    };
    await expect(isChatGPTGenerating(page)).resolves.toBe(false);
  });
});

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
  ensureIdleSurfaceWithRecovery,
  ensureNotGenerating,
  isChatGPTGenerating,
  pollUntilIdle,
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

  // When stop is clicked, the UI transition may lag across several poll cycles before settling.
  // Verify that bounded grace polling waits through transient generating=true and reports success.
  it('ensureNotGenerating polls through delayed stop transitions until idle', async () => {
    const page = fakePage({
      evaluateResults: [
        true,  // initial generating
        true,  // stop clicked
        true,  // grace poll 1 (generating -> sleeps)
        true,  // grace poll 2 (generating -> sleeps)
        false, // grace poll 3 -> idle, breaks grace loop
        false, // final isChatGPTGenerating
      ],
      sleep: vi.fn(async () => {}),
    });

    const result = await ensureNotGenerating(page, {
      timeoutSec: 0,
      pollSec: 0.05,
      stopGraceSec: 5,
      stopGracePollSec: 0.05,
      maxGraceAttempts: 10,
    });

    expect(result.waited).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.stillGenerating).toBe(false);
    expect(page.sleep).toHaveBeenCalledTimes(2);
  });

  // When stop fails to clear the generating state within the grace budget,
  // ensureNotGenerating terminates finitely and reports stillGenerating=true.
  it('ensureNotGenerating terminates finitely when stop grace is exhausted', async () => {
    const page = fakePage({
      evaluateResults: [
        true, // initial generating
        true, // stop clicked
        true, // grace polls always true
      ],
      sleep: vi.fn(async () => {}),
    });

    const result = await ensureNotGenerating(page, {
      timeoutSec: 0,
      pollSec: 0.05,
      stopGraceSec: 0.2,
      stopGracePollSec: 0.05,
      maxGraceAttempts: 3,
    });

    expect(result.waited).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.stillGenerating).toBe(true);
    expect(page.sleep).toHaveBeenCalledTimes(3);
  });

  // Grace polling continues even if stop click fails/returns false (state may clear on its own).
  it('ensureNotGenerating continues grace polling and succeeds even when stop click returns false', async () => {
    const page = fakePage({
      evaluateResults: [
        true,  // 1. initial isChatGPTGenerating -> true
        false, // 2. stop click returned false
        true,  // 3. grace poll 1 (generating -> sleeps)
        false, // 4. grace poll 2 -> idle, breaks grace loop
        false, // 5. final check -> false
      ],
      sleep: vi.fn(async () => {}),
    });

    const result = await ensureNotGenerating(page, {
      timeoutSec: 0,
      pollSec: 0.05,
      stopGraceSec: 5,
      stopGracePollSec: 0.05,
      maxGraceAttempts: 10,
    });

    expect(result.waited).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.stillGenerating).toBe(false);
    expect(page.sleep).toHaveBeenCalledTimes(1);
  });

  // When the surface is immediately idle, ensureIdleSurfaceWithRecovery completes without recovery.
  it('ensureIdleSurfaceWithRecovery skips hard reset when initial surface is idle', async () => {
    const hardReset = vi.fn(async () => {});
    const page = fakePage({
      evaluateResults: [false], // not generating
    });

    const result = await ensureIdleSurfaceWithRecovery(page, { hardReset });
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.stillGenerating).toBe(false);
    expect(hardReset).not.toHaveBeenCalled();
  });

  // When pre-send initial wait/stop remains generating after grace exhaustion,
  // ensureIdleSurfaceWithRecovery must execute hard recovery (hardReset) and re-check.
  it('ensureIdleSurfaceWithRecovery triggers hard recovery and succeeds if reset clears generating state', async () => {
    const hardReset = vi.fn(async () => {});
    probeChatSurface.mockResolvedValue({
      url: 'https://chatgpt.com/',
      composer: true,
      errorish: false,
      broken: false,
    });

    const page = fakePage({
      evaluateResults: [
        true,  // 1. initial isChatGPTGenerating -> true
        true,  // 2. initial stop -> true
        true,  // 3. initial grace poll -> true
        true,  // 4. initial final check -> true (stillGenerating=true)
        true,  // 5. recovery stop -> true
        true,  // 6. recovery isChatGPTGenerating -> true
        true,  // 7. recovery grace poll 1 -> true (still generating -> needsReset=true)
        true,  // 8. recovery post-reset stop -> true
        false, // 9. recovery post-reset isChatGPTGenerating -> false (idle!)
      ],
      sleep: vi.fn(async () => {}),
    });

    const result = await ensureIdleSurfaceWithRecovery(page, {
      timeoutSec: 0,
      pollSec: 0.05,
      stopGraceSec: 0.1,
      maxGraceAttempts: 1,
      hardReset,
    });

    expect(hardReset).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.stillGenerating).toBe(false);
  });

  // When hard recovery fails to restore an idle composer shell,
  // ensureIdleSurfaceWithRecovery reports ok=false so pre-send throws cleanly.
  it('ensureIdleSurfaceWithRecovery reports ok=false when hard recovery remains stuck', async () => {
    const hardReset = vi.fn(async () => {});
    probeChatSurface.mockResolvedValue({
      url: 'https://chatgpt.com/',
      composer: false,
      errorish: true,
      broken: true,
    });

    const page = fakePage({
      evaluateResults: [
        true, // initial isChatGPTGenerating
        true, // initial stop
        true, // initial grace poll
        true, // initial final
        true, // recovery stop
        true, // recovery isChatGPTGenerating
        true, // recovery grace poll
        true, // recovery post-reset stop
        true, // recovery post-reset isChatGPTGenerating (stuck)
      ],
      sleep: vi.fn(async () => {}),
    });

    const result = await ensureIdleSurfaceWithRecovery(page, {
      timeoutSec: 0,
      maxGraceAttempts: 1,
      hardReset,
    });

    expect(hardReset).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.recovered).toBe(true);
    expect(result.stillGenerating).toBe(true);
  });

  // Failure recovery must stop generation and hard-reset when the shell is dirty.
  it('recoverChatSurfaceAfterFailure hard-resets an errorish generating shell', async () => {
    const hardReset = vi.fn(async () => {});
    const page2 = fakePage({
      evaluateResults: [
        true,  // stop initial
        true,  // generating after initial stop
        true,  // grace poll
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

    const result = await recoverChatSurfaceAfterFailure(page2, { hardReset, maxGraceAttempts: 1 });
    expect(hardReset).toHaveBeenCalledOnce();
    expect(clearChatGPTDraft).toHaveBeenCalled();
    expect(result.reset).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.generating).toBe(false);
  });

  // When session is supplied without hardReset, recoverChatSurfaceAfterFailure reloads the page.
  it('recoverChatSurfaceAfterFailure uses page.reload for session recovery when hardReset is omitted', async () => {
    const page = {
      sleep: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // stop initial
        .mockResolvedValueOnce(true)  // generating check
        .mockResolvedValueOnce(true)  // grace poll 1 (still generating)
        .mockResolvedValueOnce(true)  // stop after reload
        .mockResolvedValueOnce(false), // generating final -> idle
    };
    probeChatSurface.mockResolvedValue({
      url: 'https://chatgpt.com/c/123',
      composer: true,
      errorish: false,
      broken: false,
    });

    const result = await recoverChatSurfaceAfterFailure(page, { session: '123', maxGraceAttempts: 1 });
    expect(page.reload).toHaveBeenCalledWith({ settleMs: 2000 });
    expect(result.reset).toBe(true);
    expect(result.generating).toBe(false);
  });

  // When neither hardReset nor session is supplied, recoverChatSurfaceAfterFailure falls back to startNewChat.
  it('recoverChatSurfaceAfterFailure falls back to startNewChat when session and hardReset are omitted', async () => {
    const page = fakePage({
      evaluateResults: [
        true,  // stop initial
        true,  // generating check
        true,  // grace poll 1 (still generating)
        true,  // stop after new chat
        false, // generating final -> idle
      ],
    });
    probeChatSurface.mockResolvedValue({
      url: 'https://chatgpt.com/',
      composer: true,
      errorish: false,
      broken: false,
    });

    const result = await recoverChatSurfaceAfterFailure(page, { maxGraceAttempts: 1 });
    expect(startNewChat).toHaveBeenCalledWith(page);
    expect(result.reset).toBe(true);
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

describe('pollUntilIdle', () => {
  // Bounded idle polling normalizes invalid input and terminates finitely.
  it('normalizes NaN/negative numbers and terminates finitely', async () => {
    const page = fakePage({
      evaluateResults: [true, true, false],
      sleep: vi.fn(async () => {}),
    });

    const result = await pollUntilIdle(page, {
      timeoutSec: -10,
      pollSec: NaN,
      maxAttempts: 'invalid',
    });

    expect(result.stillGenerating).toBe(false);
    expect(result.waited).toBe(true);
    expect(result.attempts).toBe(2);
    expect(page.sleep).toHaveBeenCalledTimes(2);
  });
});

/**
 * Keep the persistent ChatGPT tab usable across failed turns.
 *
 * Failures must not leave Thinking / stop-button / broken shells behind;
 * otherwise the next ask cannot submit.
 */

import { clearChatGPTDraft, startNewChat } from './host-chatgpt.js';
import { probeChatSurface } from './page-health.js';

/**
 * Best-effort click of ChatGPT's stop control.
 * @param {object} page
 * @returns {Promise<boolean>} true when a stop control was clicked
 */
export async function stopChatGPTGeneration(page) {
  if (!page || typeof page.evaluate !== 'function') return false;
  try {
    const clicked = await page.evaluate(`(() => {
      const byTestId = document.querySelector('[data-testid="stop-button"]');
      if (byTestId instanceof HTMLElement) {
        byTestId.click();
        return true;
      }
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'));
      for (const control of controls) {
        const label = [
          control.getAttribute('aria-label') || '',
          control.getAttribute('title') || '',
          (control.textContent || '').trim(),
        ].join(' ');
        if (/Stop generating|停止生成|停止/.test(label)) {
          control.click();
          return true;
        }
      }
      return false;
    })()`);
    return !!clicked;
  } catch {
    return false;
  }
}

/**
 * Cheap generation probe aligned with OpenCLI host utils.isGenerating signals.
 * @param {object} page
 * @returns {Promise<boolean>}
 */
export async function isChatGPTGenerating(page) {
  if (!page || typeof page.evaluate !== 'function') return false;
  try {
    const generating = await page.evaluate(`(() => {
      if (document.querySelector('[data-testid="stop-button"]')) return true;
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'));
      for (const control of controls) {
        const label = control.getAttribute('aria-label') || '';
        if (
          label.includes('Stop generating')
          || label.includes('停止生成')
          || label.includes('正在思考')
        ) {
          return true;
        }
      }
      const turns = document.querySelectorAll('article[data-testid*="conversation-turn"]');
      const messages = turns.length ? turns : document.querySelectorAll('[data-message-author-role]');
      if (!messages.length) return false;
      const last = messages[messages.length - 1];
      for (const el of [last, ...last.querySelectorAll('*')]) {
        if (el.children && el.children.length) continue;
        if (el.closest && el.closest('.markdown, pre, code')) continue;
        const text = (el.textContent || '').trim();
        if (text && text.length <= 40 && /正在思考|停止生成|Thinking/.test(text)) {
          return true;
        }
      }
      return false;
    })()`);
    return !!generating;
  } catch {
    return false;
  }
}

function normalizeNonNegativeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizePositiveNumber(value, fallback, min = 0.05) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function normalizeAttempts(attempts, timeoutSec, pollSec) {
  if (attempts != null) {
    const n = Number(attempts);
    if (Number.isFinite(n) && n >= 0) {
      return Math.floor(n);
    }
  }
  if (timeoutSec <= 0) return 0;
  return Math.max(1, Math.ceil((timeoutSec * 1000) / (pollSec * 1000)));
}

/**
 * Internal bounded idle poller: polls isChatGPTGenerating until false or budget exhausted.
 * @param {object} page
 * @param {{
 *   timeoutSec?: number,
 *   pollSec?: number,
 *   maxAttempts?: number,
 * }} [opts]
 * @returns {Promise<{ waited: boolean, stillGenerating: boolean, attempts: number }>}
 */
export async function pollUntilIdle(page, opts = {}) {
  const timeoutSec = normalizeNonNegativeNumber(opts.timeoutSec, 30);
  const pollSec = normalizePositiveNumber(opts.pollSec, 1, 0.05);
  const maxAttempts = normalizeAttempts(opts.maxAttempts, timeoutSec, pollSec);

  const start = Date.now();
  let waited = false;
  let attempts = 0;

  while (await isChatGPTGenerating(page)) {
    waited = true;
    const timeExpired = (Date.now() - start) >= timeoutSec * 1000;
    const attemptsExpired = attempts >= maxAttempts;
    if (timeExpired || attemptsExpired) {
      return { waited, stillGenerating: true, attempts };
    }
    attempts += 1;
    if (typeof page.sleep === 'function') {
      await page.sleep(pollSec);
    } else {
      break;
    }
  }

  const stillGenerating = await isChatGPTGenerating(page);
  return { waited, stillGenerating, attempts };
}

/**
 * Wait until the page is not generating; stop once if the wait budget is spent,
 * followed by a bounded post-stop polling grace period.
 *
 * @param {object} page
 * @param {{
 *   timeoutSec?: number,
 *   pollSec?: number,
 *   stopGraceSec?: number,
 *   stopGracePollSec?: number,
 *   maxWaitAttempts?: number,
 *   maxGraceAttempts?: number,
 * }} [opts]
 * @returns {Promise<{ waited: boolean, stopped: boolean, stillGenerating: boolean }>}
 */
export async function ensureNotGenerating(page, opts = {}) {
  const timeoutSec = normalizeNonNegativeNumber(opts.timeoutSec, 30);
  const pollSec = normalizePositiveNumber(opts.pollSec, 1, 0.05);
  const stopGraceSec = normalizeNonNegativeNumber(opts.stopGraceSec, 5);
  const stopGracePollSec = normalizePositiveNumber(opts.stopGracePollSec, Math.min(1, pollSec), 0.05);

  const initial = await pollUntilIdle(page, {
    timeoutSec,
    pollSec,
    maxAttempts: opts.maxWaitAttempts,
  });

  let stopped = false;
  let waited = initial.waited;

  if (initial.stillGenerating) {
    stopped = await stopChatGPTGeneration(page);
    // Grace polling proceeds even if stop click returned false (state may clear on its own)
    const hasGraceBudget = stopGraceSec > 0 || (opts.maxGraceAttempts != null && Number(opts.maxGraceAttempts) > 0);
    if (hasGraceBudget) {
      const grace = await pollUntilIdle(page, {
        timeoutSec: stopGraceSec,
        pollSec: stopGracePollSec,
        maxAttempts: opts.maxGraceAttempts,
      });
      if (grace.waited) waited = true;
      return { waited, stopped, stillGenerating: grace.stillGenerating };
    }
  }

  const stillGenerating = await isChatGPTGenerating(page);
  return { waited, stopped, stillGenerating };
}

/**
 * Best-effort recovery after a failed ask so the next command can submit.
 * @param {object} page
 * @param {{
 *   session?: string,
 *   hardReset?: () => Promise<void>,
 *   stopGraceSec?: number,
 *   pollSec?: number,
 *   maxGraceAttempts?: number,
 * }} [opts]
 * @returns {Promise<{ stopped: boolean, reset: boolean, surface: object, generating: boolean }>}
 */
export async function recoverChatSurfaceAfterFailure(page, opts = {}) {
  const pollSec = normalizePositiveNumber(opts.pollSec, 0.5, 0.05);
  const stopGraceSec = normalizeNonNegativeNumber(opts.stopGraceSec, 3);
  const maxGraceAttempts = opts.maxGraceAttempts != null
    ? normalizeAttempts(opts.maxGraceAttempts, stopGraceSec, pollSec)
    : undefined;

  let stopped = await stopChatGPTGeneration(page);
  if (typeof page.sleep === 'function') {
    await page.sleep(0.8);
  }

  // Bounded post-stop idle poll before evaluating surface state
  const initialIdle = await pollUntilIdle(page, {
    timeoutSec: stopGraceSec,
    pollSec,
    maxAttempts: maxGraceAttempts,
  });

  try {
    await clearChatGPTDraft(page);
  } catch {
    // ignore draft cleanup failures during recovery
  }

  let surface = await probeChatSurface(page).catch(() => ({
    errorish: true,
    composer: false,
    broken: true,
  }));
  let generating = initialIdle.stillGenerating;
  let reset = false;

  const needsReset = !!(
    surface.errorish
    || surface.broken
    || !surface.composer
    || generating
  );

  if (needsReset) {
    reset = true;
    if (typeof opts.hardReset === 'function') {
      await opts.hardReset();
    } else if (!opts.session) {
      await startNewChat(page);
    } else if (typeof page.reload === 'function') {
      await page.reload({ settleMs: 2000 }).catch(() => null);
    }
    if (typeof page.sleep === 'function') {
      await page.sleep(1);
    }
    const postResetStop = await stopChatGPTGeneration(page);
    stopped = stopped || postResetStop;
    try {
      await clearChatGPTDraft(page);
    } catch {
      // ignore
    }

    // Bounded idle polling after reset
    const postResetIdle = await pollUntilIdle(page, {
      timeoutSec: stopGraceSec,
      pollSec,
      maxAttempts: maxGraceAttempts,
    });
    surface = await probeChatSurface(page).catch(() => surface);
    generating = postResetIdle.stillGenerating;
  }

  return { stopped, reset, surface, generating };
}

/**
 * Ensure the chat surface is idle before sending.
 * If the page is still generating after initial wait/stop, runs bounded recovery
 * (with hardReset) and re-checks before giving up.
 *
 * @param {object} page
 * @param {{
 *   timeoutSec?: number,
 *   pollSec?: number,
 *   stopGraceSec?: number,
 *   session?: string,
 *   hardReset?: () => Promise<void>,
 *   maxWaitAttempts?: number,
 *   maxGraceAttempts?: number,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   waited: boolean,
 *   stopped: boolean,
 *   stillGenerating: boolean,
 *   recovered: boolean,
 *   recovery?: object,
 * }>}
 */
export async function ensureIdleSurfaceWithRecovery(page, opts = {}) {
  const initial = await ensureNotGenerating(page, {
    timeoutSec: opts.timeoutSec ?? 30,
    pollSec: opts.pollSec ?? 1,
    stopGraceSec: opts.stopGraceSec ?? 5,
    maxWaitAttempts: opts.maxWaitAttempts,
    maxGraceAttempts: opts.maxGraceAttempts,
  });

  if (!initial.stillGenerating) {
    return {
      ok: true,
      waited: initial.waited,
      stopped: initial.stopped,
      stillGenerating: false,
      recovered: false,
    };
  }

  // Initial wait/stop exhausted but page is still generating.
  // Perform hard recovery before failing.
  const recovery = await recoverChatSurfaceAfterFailure(page, {
    session: opts.session,
    hardReset: opts.hardReset,
    stopGraceSec: opts.stopGraceSec ?? 3,
    pollSec: opts.pollSec ?? 0.5,
    maxGraceAttempts: opts.maxGraceAttempts,
  });

  const stillGenerating = !!recovery.generating;
  const surfaceBroken = !!(recovery.surface?.broken || recovery.surface?.errorish || !recovery.surface?.composer);
  const ok = !stillGenerating && !surfaceBroken;

  return {
    ok,
    waited: initial.waited,
    stopped: initial.stopped || recovery.stopped,
    stillGenerating,
    recovered: true,
    recovery,
  };
}

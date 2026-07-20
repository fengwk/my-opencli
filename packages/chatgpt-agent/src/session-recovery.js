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

/**
 * Wait until the page is not generating; stop once if the wait budget is spent.
 * @param {object} page
 * @param {{ timeoutSec?: number, pollSec?: number }} [opts]
 * @returns {Promise<{ waited: boolean, stopped: boolean, stillGenerating: boolean }>}
 */
export async function ensureNotGenerating(page, opts = {}) {
  const timeoutSec = Math.max(0, Number(opts.timeoutSec ?? 30));
  const pollSec = Math.max(0.05, Number(opts.pollSec ?? 1));
  const start = Date.now();
  let waited = false;
  let stopped = false;

  while (await isChatGPTGenerating(page)) {
    waited = true;
    // timeoutSec=0 means "stop immediately if currently generating".
    if (Date.now() - start >= timeoutSec * 1000) {
      stopped = await stopChatGPTGeneration(page);
      if (typeof page.sleep === 'function') {
        await page.sleep(Math.min(1, Math.max(0.05, pollSec)));
      }
      break;
    }
    if (typeof page.sleep === 'function') {
      await page.sleep(pollSec);
    } else {
      break;
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
 * }} [opts]
 * @returns {Promise<{ stopped: boolean, reset: boolean, surface: object, generating: boolean }>}
 */
export async function recoverChatSurfaceAfterFailure(page, opts = {}) {
  const stopped = await stopChatGPTGeneration(page);
  if (typeof page.sleep === 'function') {
    await page.sleep(0.8);
  }

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
  let generating = await isChatGPTGenerating(page);
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
    await stopChatGPTGeneration(page);
    try {
      await clearChatGPTDraft(page);
    } catch {
      // ignore
    }
    surface = await probeChatSurface(page).catch(() => surface);
    generating = await isChatGPTGenerating(page);
  }

  return { stopped, reset, surface, generating };
}

/**
 * Wait for a usable composer and rendered conversation before sending.
 * A visible composer alone does not prove that a resumed conversation loaded.
 */

import { parseChatGPTConversationId } from './host-chatgpt.js';

export const PAGE_ERRORISH_RE = /something went wrong|出错了|无法加载|try again|重新加载|unable to load|network error/i;
export const GENERATION_FAILED_RE = /something went wrong while generating the response|生成回复时出错|生成响应时出错/i;
export const CONVERSATION_UNAVAILABLE_RE = /(?:could not|unable to) load (?:this )?(?:chatgpt )?conversation|conversation not found/i;

const MESSAGE_SELECTOR = '[data-message-author-role], article[data-testid*="conversation-turn"], '
  + '[data-talvt-turn-state], [data-conversation-role], [data-chatgpt-search-unit-key]';
const CONTENT_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"] .markdown, '
  + '[data-chatgpt-search-unit-key], [data-content-search-unit-key], '
  + '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"], '
  + '[contenteditable="true"][role="textbox"]';

function conversationIdFromUrl(url) {
  try {
    return parseChatGPTConversationId(url);
  } catch {
    return null;
  }
}

/**
 * Classify visible ChatGPT main-thread text in Node so tests can pin the
 * generation-failed banner without driving a browser.
 * @param {string} mainText
 * @returns {{ errorish: boolean, generationFailed: boolean }}
 */
export function classifyChatMainText(mainText) {
  const text = String(mainText || '');
  return {
    errorish: PAGE_ERRORISH_RE.test(text),
    generationFailed: GENERATION_FAILED_RE.test(text),
  };
}

/**
 * @param {object} page
 * @param {{ session?: string }} [opts]
 * @returns {Promise<{
 *   url: string,
 *   conversationId: string | null,
 *   sessionMismatch: boolean,
 *   conversationUnavailable: boolean,
 *   composer: boolean,
 *   messages: number,
 *   mainLen: number,
 *   errorish: boolean,
 *   generationFailed: boolean,
 *   onConversation: boolean,
 *   blankThread: boolean,
 *   broken: boolean,
 * }>}
 */
export async function probeChatSurface(page, opts = {}) {
  const expectedId = opts.session ? parseChatGPTConversationId(opts.session) : null;
  const state = await page.evaluate(`(() => {
    const url = location.href || '';
    const composer = Array.from(document.querySelectorAll(
      '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    )).some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
    });
    const messages = document.querySelectorAll(${JSON.stringify(MESSAGE_SELECTOR)}).length;
    const main = document.querySelector('main') || document.body;
    const mainText = ((main && (main.innerText || main.textContent)) || '').trim();
    const mainLen = mainText.length;
    const hasErrorText = new RegExp(
      ${JSON.stringify(PAGE_ERRORISH_RE.source)},
      ${JSON.stringify(PAGE_ERRORISH_RE.flags)},
    ).test(mainText);
    const hasGenerationFailureText = new RegExp(
      ${JSON.stringify(GENERATION_FAILED_RE.source)},
      ${JSON.stringify(GENERATION_FAILED_RE.flags)},
    ).test(mainText);
    const hasUnavailableText = new RegExp(
      ${JSON.stringify(CONVERSATION_UNAVAILABLE_RE.source)},
      ${JSON.stringify(CONVERSATION_UNAVAILABLE_RE.flags)},
    ).test(mainText);
    let surfaceText = mainText;
    if (hasErrorText || hasGenerationFailureText || hasUnavailableText) {
      const parts = [];
      const walker = document.createTreeWalker(main, 4);
      let textNode = walker.nextNode();
      while (textNode) {
        const owner = textNode.parentElement;
        const excluded = owner && owner.closest(${JSON.stringify(CONTENT_SELECTOR)});
        const alert = owner && owner.closest('[role="alert"]');
        if (!excluded || alert) parts.push(textNode.nodeValue || '');
        textNode = walker.nextNode();
      }
      surfaceText = parts.join(' ');
    }
    const errorish = new RegExp(
      ${JSON.stringify(PAGE_ERRORISH_RE.source)},
      ${JSON.stringify(PAGE_ERRORISH_RE.flags)},
    ).test(surfaceText);
    const conversationUnavailable = new RegExp(
      ${JSON.stringify(CONVERSATION_UNAVAILABLE_RE.source)},
      ${JSON.stringify(CONVERSATION_UNAVAILABLE_RE.flags)},
    ).test(surfaceText);
    const generationFailed = new RegExp(
      ${JSON.stringify(GENERATION_FAILED_RE.source)},
      ${JSON.stringify(GENERATION_FAILED_RE.flags)},
    ).test(surfaceText);
    const generating = !!document.querySelector(
      '[data-testid="stop-button"], button[aria-label="Stop"], button[aria-label="Stop streaming"], button[aria-label="停止生成"], button[aria-label="停止"]',
    );
    return {
      url,
      composer,
      messages,
      mainLen,
      // Keep the latest text for diagnostics, but classify the full non-user
      // surface above so long threads are covered without treating prompts as UI.
      mainText: mainText.slice(-8000),
      errorish,
      generationFailed,
      conversationUnavailable,
      generating,
    };
  })()`).catch(() => ({
    url: '',
    composer: false,
    messages: 0,
    mainLen: 0,
    mainText: '',
    errorish: true,
    generationFailed: false,
    conversationUnavailable: false,
    generating: false,
  }));

  const flags = classifyChatMainText(state.mainText);
  const errorish = typeof state.errorish === 'boolean' ? state.errorish : flags.errorish;
  const generationFailed = typeof state.generationFailed === 'boolean'
    ? state.generationFailed
    : flags.generationFailed;
  const conversationUnavailable = typeof state.conversationUnavailable === 'boolean'
    ? state.conversationUnavailable
    : CONVERSATION_UNAVAILABLE_RE.test(state.mainText || '');
  const conversationId = conversationIdFromUrl(state.url);
  const onConversation = conversationId !== null;
  const sessionMismatch = expectedId !== null && conversationId !== expectedId;
  // UI chrome and placeholders can contain plenty of text without any history.
  const blankThread = onConversation && !(state.messages > 0);
  const broken = !!(
    errorish
    || generationFailed
    || !state.composer
    || blankThread
    || sessionMismatch
    || conversationUnavailable
  );
  return {
    ...state, errorish, generationFailed, conversationUnavailable,
    conversationId, onConversation, sessionMismatch, blankThread,
    generating: !!state.generating, broken,
  };
}

/**
 * Poll through hydration before and after at most one pre-send reload.
 *
 * @param {object} page
 * @param {{
 *   session?: string,
 *   reload?: (page: object) => Promise<void>,
 *   allowReload?: boolean,
 *   settleMs?: number,
 * }} opts
 * @returns {Promise<{ recovered: boolean, before: object, after: object }>}
 */
export async function ensureHealthyChatSurface(page, opts = {}) {
  const settleMs = opts.settleMs ?? 15_000;
  const pollMs = 500;
  const waitForReady = async () => {
    const deadline = Date.now() + settleMs;
    let state = await probeChatSurface(page, { session: opts.session });
    // The attempt cap also bounds tests and custom pages with non-blocking sleep.
    for (let attempt = 0; attempt < Math.ceil(settleMs / pollMs); attempt += 1) {
      if (!state.broken || state.conversationUnavailable) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.sleep(Math.min(pollMs, remaining) / 1000);
      state = await probeChatSurface(page, { session: opts.session });
    }
    return state;
  };

  const before = await waitForReady();
  if (!before.broken || before.conversationUnavailable || opts.allowReload === false) {
    return { recovered: false, before, after: before };
  }

  if (process.env.OPENCLI_VERBOSE) {
    const { mainText, ...diagnostics } = before;
    console.error(`[chatgpt-agent] page-health broken → reload ${JSON.stringify(diagnostics)}`);
  }

  if (typeof opts.reload === 'function') {
    await opts.reload(page);
  } else if (typeof page.reload === 'function') {
    await page.reload({ settleMs: 2000 }).catch(async () => {
      const url = before.url || 'https://chatgpt.com/';
      if (typeof page.goto === 'function') await page.goto(url, { settleMs: 2000 });
    });
  } else if (typeof page.goto === 'function') {
    await page.goto(before.url || 'https://chatgpt.com/', { settleMs: 2000 });
  } else {
    return { recovered: false, before, after: before };
  }

  const after = await waitForReady();
  if (process.env.OPENCLI_VERBOSE) {
    const { mainText, ...diagnostics } = after;
    console.error(`[chatgpt-agent] page-health after reload ${JSON.stringify(diagnostics)}`);
  }
  return { recovered: true, before, after };
}

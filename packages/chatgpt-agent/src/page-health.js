/**
 * Detect blank / broken ChatGPT thread shells and recover with a single reload.
 *
 * Symptoms seen in the wild:
 *   - composer still visible
 *   - main thread pure white / empty
 *   - /c/{id} has zero message nodes after settle
 *   - WS only emits conversation-update/reply, no turn stream
 *   - in-thread red banner: "Something went wrong while generating the response"
 */

export const PAGE_ERRORISH_RE = /something went wrong|出错了|无法加载|try again|重新加载|unable to load|network error/i;
export const GENERATION_FAILED_RE = /something went wrong while generating the response|生成回复时出错|生成响应时出错/i;

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
 * @returns {Promise<{
 *   url: string,
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
export async function probeChatSurface(page) {
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
    const messages = document.querySelectorAll('[data-message-author-role]').length;
    const main = document.querySelector('main') || document.body;
    const mainText = ((main && (main.innerText || main.textContent)) || '').trim();
    const mainLen = mainText.length;
    const rawErrorish = new RegExp(
      ${JSON.stringify(PAGE_ERRORISH_RE.source)},
      ${JSON.stringify(PAGE_ERRORISH_RE.flags)},
    ).test(mainText);
    const hasGenerationFailureText = new RegExp(
      ${JSON.stringify(GENERATION_FAILED_RE.source)},
      ${JSON.stringify(GENERATION_FAILED_RE.flags)},
    ).test(mainText);
    let surfaceText = mainText;
    if (hasGenerationFailureText) {
      const parts = [];
      const walker = document.createTreeWalker(main, 4);
      let textNode = walker.nextNode();
      while (textNode) {
        const owner = textNode.parentElement;
        const excluded = owner && owner.closest(
          '[data-message-author-role="user"], '
          + '[data-message-author-role="assistant"] .markdown, #prompt-textarea, '
          + '[data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"], '
          + '[contenteditable="true"][role="textbox"]',
        );
        if (!excluded) parts.push(textNode.nodeValue || '');
        textNode = walker.nextNode();
      }
      surfaceText = parts.join(' ');
    }
    const errorish = hasGenerationFailureText
      ? new RegExp(
        ${JSON.stringify(PAGE_ERRORISH_RE.source)},
        ${JSON.stringify(PAGE_ERRORISH_RE.flags)},
      ).test(surfaceText)
      : rawErrorish;
    const generationFailed = new RegExp(
      ${JSON.stringify(GENERATION_FAILED_RE.source)},
      ${JSON.stringify(GENERATION_FAILED_RE.flags)},
    ).test(surfaceText);
    const onConversation = /\\/c\\/[A-Za-z0-9-]+/.test(url);
    // Composer-only shell on an existing conversation = broken or still hydrating.
    const blankThread = onConversation && messages === 0 && mainLen < 120;
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
      onConversation,
      blankThread,
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
    onConversation: false,
    blankThread: true,
    generating: false,
  }));

  const flags = classifyChatMainText(state.mainText);
  const errorish = typeof state.errorish === 'boolean' ? state.errorish : flags.errorish;
  const generationFailed = typeof state.generationFailed === 'boolean'
    ? state.generationFailed
    : flags.generationFailed;
  const broken = !!(
    errorish
    || !state.composer
    || state.blankThread
  );
  return { ...state, errorish, generationFailed, generating: !!state.generating, broken };
}

/**
 * Wait briefly for hydration, then reload once if the thread shell is blank/broken.
 *
 * @param {object} page
 * @param {{
 *   session?: string,
 *   reload?: (page: object) => Promise<void>,
 *   settleMs?: number,
 * }} opts
 * @returns {Promise<{ recovered: boolean, before: object, after: object }>}
 */
export async function ensureHealthyChatSurface(page, opts = {}) {
  const settleMs = opts.settleMs ?? 4000;
  const hasSession = !!(opts.session && String(opts.session).trim());

  // Give hydration a moment (blank for <settle is often normal).
  await page.sleep(Math.min(1.5, settleMs / 1000));
  let before = await probeChatSurface(page);

  // New chat is allowed to be empty; only force recovery on conversation URLs / errors.
  if (!before.broken) {
    return { recovered: false, before, after: before };
  }
  if (!hasSession && !before.errorish && before.composer) {
    // /new with empty thread is healthy.
    if (!before.onConversation) {
      return { recovered: false, before, after: before };
    }
  }

  // Wait remaining settle window in case messages are still mounting.
  const waited = 1500;
  const rest = Math.max(0, settleMs - waited);
  if (rest > 0) await page.sleep(rest / 1000);
  before = await probeChatSurface(page);
  if (!before.broken) {
    return { recovered: false, before, after: before };
  }
  if (!hasSession && !before.errorish && before.composer && !before.onConversation) {
    return { recovered: false, before, after: before };
  }

  if (process.env.OPENCLI_VERBOSE) {
    console.error(`[chatgpt-agent] page-health broken → reload ${JSON.stringify(before)}`);
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
  }

  await page.sleep(1.5);
  const after = await probeChatSurface(page);
  if (process.env.OPENCLI_VERBOSE) {
    console.error(`[chatgpt-agent] page-health after reload ${JSON.stringify(after)}`);
  }
  return { recovered: true, before, after };
}

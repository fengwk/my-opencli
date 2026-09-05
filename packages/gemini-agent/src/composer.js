/**
 * Gemini composer: structural selectors + native typing + trusted CDP click/Enter.
 *
 * Do not match localized button labels. Send is confirmed by StreamGenerate
 * or cleared composer, not by UI chrome text.
 */

import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from './eval.js';
import {
  GEMINI_APP_URL,
  GEMINI_DOMAIN,
  geminiConversationUrl,
  isGeminiAppUrl,
  isGoogleAccountsUrl,
  parseGeminiSessionId,
} from './session.js';
import { probeStreamGenerateTiming } from './stream-timing.js';

export const COMPOSER_SELECTORS = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  '.ql-editor[contenteditable="true"][role="textbox"]',
  'input-area-v2 [contenteditable="true"][role="textbox"]',
  '.ql-editor[contenteditable="true"]',
];

function composerLocatorScript() {
  const selectorsJson = JSON.stringify(COMPOSER_SELECTORS);
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const findComposer = () => {
      const selectors = ${selectorsJson};
      for (const selector of selectors) {
        const node = Array.from(document.querySelectorAll(selector)).find((candidate) => isVisible(candidate));
        if (node instanceof HTMLElement) return node;
      }
      return null;
    };
  `;
}

export function sendTargetLocatorScript() {
  return `
    const isElementVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isElementDisabled = (el) => {
      if (!el || !(el instanceof HTMLElement)) return true;
      if (el.disabled === true) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      if (el.hasAttribute('disabled')) return true;
      return false;
    };
    const findSendTarget = () => {
      const container = document.querySelector('[data-test-id="send-button-container"]');
      if (!(container instanceof HTMLElement)) return null;
      if (!isElementVisible(container)) return null;

      const host = container.querySelector(':scope > gem-icon-button')
        || container.querySelector('gem-icon-button')
        || container.querySelector('button')
        || container;

      if (!(host instanceof HTMLElement)) return null;
      if (isElementDisabled(host)) return null;

      const button = host.tagName.toLowerCase() === 'button'
        ? host
        : (host.querySelector('button') || host.shadowRoot?.querySelector('button') || host);

      if (button instanceof HTMLElement && isElementDisabled(button)) return null;

      const targetEl = (button instanceof HTMLElement && isElementVisible(button)) ? button : host;
      if (!isElementVisible(targetEl)) return null;

      const rect = targetEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      return {
        ok: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    };
  `;
}

export async function currentGeminiUrl(page) {
  if (typeof page.getCurrentUrl === 'function') {
    const url = await page.getCurrentUrl().catch(() => '');
    if (url) return String(url);
  }
  const raw = await page.evaluate('window.location.href').catch(() => '');
  const url = unwrapEvaluateResult(raw);
  return typeof url === 'string' && url ? url : '';
}

export async function ensureGeminiPage(page) {
  const url = await currentGeminiUrl(page);
  if (isGoogleAccountsUrl(url)) return url;
  if (isGeminiAppUrl(url)) return url;
  await page.goto(GEMINI_APP_URL, { waitUntil: 'load', settleMs: 2500 });
  if (typeof page.sleep === 'function') await page.sleep(1);
  else if (typeof page.wait === 'function') await page.wait(1);
  return currentGeminiUrl(page);
}

export async function startNewGeminiChat(page) {
  await page.goto(GEMINI_APP_URL, { waitUntil: 'load', settleMs: 2500 });
  if (typeof page.sleep === 'function') await page.sleep(1);
  else if (typeof page.wait === 'function') await page.wait(1);
}

export async function openGeminiConversation(page, session) {
  const id = parseGeminiSessionId(session);
  const target = id ? geminiConversationUrl(id) : GEMINI_APP_URL;
  await page.goto(target, { waitUntil: 'load', settleMs: 2500 });
  if (typeof page.sleep === 'function') await page.sleep(1);
  else if (typeof page.wait === 'function') await page.wait(1);
}

export async function probeGeminiSurface(page) {
  const raw = await page.evaluate(`(() => {
    ${composerLocatorScript()}
    const composer = findComposer();
    const url = location.href || '';
    const overlays = [...document.querySelectorAll('[data-test-id="image-loading-overlay"]')];
    const overlayVisible = overlays.some((overlay) => (
      overlay instanceof HTMLElement
      && !overlay.classList.contains('done-generating')
      && overlay.offsetWidth
      && overlay.offsetHeight
    ));
    return {
      url,
      composer: !!composer,
      overlayVisible,
    };
  })()`).catch(() => ({ url: '', composer: false, overlayVisible: false }));
  return unwrapEvaluateResult(raw) || { url: '', composer: false, overlayVisible: false };
}

export async function ensureGeminiLogin(page, message) {
  const url = await currentGeminiUrl(page);
  if (isGoogleAccountsUrl(url)) {
    throw new AuthRequiredError(
      GEMINI_DOMAIN,
      message || 'gemini-agent ask requires a logged-in Gemini browser session.',
    );
  }
  const surface = await probeGeminiSurface(page);
  if (!surface.composer) {
    throw new AuthRequiredError(
      GEMINI_DOMAIN,
      message || 'gemini-agent ask requires a logged-in Gemini browser session with a visible composer.',
    );
  }
  return surface;
}

export async function ensureGeminiComposer(page, message) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const surface = await probeGeminiSurface(page);
    if (surface.composer) return surface;
    if (typeof page.sleep === 'function') await page.sleep(0.5);
    else if (typeof page.wait === 'function') await page.wait(0.5);
  }
  throw new CommandExecutionError(
    message || 'gemini-agent ask requires a visible composer.',
    `Open ${GEMINI_APP_URL} in the automation window and finish any interstitial.`,
  );
}

export async function clearGeminiDraft(page) {
  await page.evaluate(`(() => {
    ${composerLocatorScript()}
    const composer = findComposer();
    if (!(composer instanceof HTMLElement)) return false;
    composer.focus();
    composer.click();
    const selectAll = () => {
      document.execCommand('selectAll');
      document.execCommand('delete');
    };
    selectAll();
    return true;
  })()`).catch(() => false);
}

export async function composerHasText(page) {
  const raw = await page.evaluate(`(() => {
    ${composerLocatorScript()}
    const composer = findComposer();
    if (!(composer instanceof HTMLElement)) return false;
    const text = (composer.innerText || composer.textContent || '').replace(/\\u00a0/g, ' ').trim();
    return text.length > 0;
  })()`).catch(() => false);
  return !!unwrapEvaluateResult(raw);
}

async function focusComposer(page) {
  const raw = await page.evaluate(`(() => {
    ${composerLocatorScript()}
    const composer = findComposer();
    if (!(composer instanceof HTMLElement)) return { ok: false };
    composer.scrollIntoView({ block: 'center' });
    composer.focus();
    composer.click();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { ok: true };
  })()`);
  const result = unwrapEvaluateResult(raw);
  return !!(result && result.ok);
}

async function activateCurrentGeminiTab(page) {
  if (typeof page.getActivePage !== 'function' || typeof page.selectTab !== 'function') return false;
  const pageId = page.getActivePage();
  if (!pageId) return false;
  try {
    await page.selectTab(pageId);
    return true;
  } catch {
    return false;
  }
}

async function probeGeminiInteractionState(page) {
  const raw = await page.evaluate(`(() => ({
    visibilityState: document.visibilityState || '',
    documentHasFocus: document.hasFocus(),
  }))()`).catch(() => null);
  const state = unwrapEvaluateResult(raw);
  return state && typeof state === 'object'
    ? state
    : { visibilityState: '', documentHasFocus: false };
}

function notifyComposerInputScript() {
  return `
    (() => {
      ${composerLocatorScript()}
      const composer = findComposer();
      if (!(composer instanceof HTMLElement)) return false;
      const text = ((composer.innerText || composer.textContent || '').replace(/\\u00a0/g, ' ')).trim();
      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: text, inputType: 'insertText' }));
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `;
}

function insertComposerTextFallbackScript(text) {
  return `
    ((inputText) => {
      ${composerLocatorScript()}
      const composer = findComposer();
      if (!(composer instanceof HTMLElement)) return { hasText: false };
      composer.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const execResult = typeof document.execCommand === 'function'
        ? document.execCommand('insertText', false, inputText)
        : false;
      if (!execResult) {
        const paragraph = document.createElement('p');
        paragraph.appendChild(document.createTextNode(String(inputText)));
        composer.replaceChildren(paragraph);
      }
      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: inputText, inputType: 'insertText' }));
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: inputText, inputType: 'insertText' }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        hasText: !!((composer.textContent || '').trim() || (composer.innerText || '').trim()),
      };
    })(${JSON.stringify(text)})
  `;
}

async function dispatchComposerInput(page) {
  await page.evaluate(notifyComposerInputScript()).catch(() => null);
}

async function waitForSubmitControl(page, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await page.evaluate(`(() => {
      ${sendTargetLocatorScript()}
      const target = findSendTarget();
      return { ready: !!target, ok: !!target, target };
    })()`).catch(() => ({ ready: false, ok: false }));
    const result = unwrapEvaluateResult(raw);
    if (result && (result.ready || result.ok || result.target)) return true;
    if (typeof page.sleep === 'function') await page.sleep(0.1);
    else if (typeof page.wait === 'function') await page.wait(0.1);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function fillGeminiComposer(page, text, opts = {}) {
  const focused = await focusComposer(page);
  if (!focused) return false;
  await clearGeminiDraft(page);
  await focusComposer(page);
  if (typeof page.nativeType === 'function') {
    try {
      await page.nativeType(text);
    } catch { /* try other transports */ }
  }
  if (!(await composerHasText(page)) && typeof page.insertText === 'function') {
    try {
      await page.insertText(text);
    } catch { /* try execCommand */ }
  }
  if (!(await composerHasText(page))) {
    await page.evaluate(insertComposerTextFallbackScript(text)).catch(() => null);
  }
  await dispatchComposerInput(page);
  if (typeof page.sleep === 'function') await page.sleep(0.35);
  else if (typeof page.wait === 'function') await page.wait(0.35);
  if (!(await composerHasText(page))) return false;
  const controlTimeoutMs = Number.isFinite(opts?.controlTimeoutMs) ? Number(opts.controlTimeoutMs) : 3000;
  return waitForSubmitControl(page, controlTimeoutMs);
}

export async function clickSendButton(page) {
  const raw = await page.evaluate(`(() => {
    ${sendTargetLocatorScript()}
    const target = findSendTarget();
    if (!target) return { ok: false };
    return target;
  })()`).catch(() => ({ ok: false }));
  const target = unwrapEvaluateResult(raw);

  if (target && target.ok && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    if (typeof page.cdp === 'function') {
      let pressed = false;
      try {
        await page.cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: target.x,
          y: target.y,
          pointerType: 'mouse',
        });
        await page.cdp('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: 1,
          buttons: 1,
          pointerType: 'mouse',
        });
        pressed = true;
        if (typeof page.sleep === 'function') await page.sleep(0.08);
        else if (typeof page.wait === 'function') await page.wait(0.08);
        else await new Promise((resolve) => setTimeout(resolve, 80));
        await page.cdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: 1,
          buttons: 0,
          pointerType: 'mouse',
        });
        return true;
      } catch {
        if (pressed) {
          await page.cdp('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: target.x,
            y: target.y,
            button: 'left',
            clickCount: 1,
            buttons: 0,
            pointerType: 'mouse',
          }).catch(() => null);
        }
      }
    }
    if (typeof page.nativeClick === 'function') {
      try {
        await page.nativeClick(target.x, target.y);
        return true;
      } catch { /* fall through to DOM click */ }
    }
  }

  const domClicked = await page.evaluate(`(() => {
    ${sendTargetLocatorScript()}
    const container = document.querySelector('[data-test-id="send-button-container"]');
    if (!(container instanceof HTMLElement)) return false;
    const host = container.querySelector(':scope > gem-icon-button')
      || container.querySelector('gem-icon-button')
      || container.querySelector('button')
      || container;
    if (!(host instanceof HTMLElement)) return false;
    if (isElementDisabled(host)) return false;
    const button = host.tagName.toLowerCase() === 'button'
      ? host
      : (host.querySelector('button') || host.shadowRoot?.querySelector('button') || host);
    if (button instanceof HTMLElement && isElementDisabled(button)) return false;
    const targetEl = (button instanceof HTMLElement && isElementVisible(button)) ? button : host;
    if (!isElementVisible(targetEl)) return false;
    if (typeof targetEl.click !== 'function') return false;
    targetEl.click();
    return true;
  })()`).catch(() => false);

  return !!unwrapEvaluateResult(domClicked);
}

export async function submitGeminiComposer(page) {
  await focusComposer(page);
  if (typeof page.cdp === 'function') {
    try {
      await page.cdp('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await page.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      return true;
    } catch { /* fall through */ }
  }
  if (typeof page.nativeKeyPress === 'function') {
    try {
      await page.nativeKeyPress('Enter');
      return true;
    } catch { /* fall through */ }
  }
  const raw = await page.evaluate(`(() => {
    ${composerLocatorScript()}
    const composer = findComposer();
    if (!(composer instanceof HTMLElement)) return false;
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    composer.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    return true;
  })()`).catch(() => false);
  return !!unwrapEvaluateResult(raw);
}

async function hasSubmissionSignal(page, streamMark) {
  const hasText = await composerHasText(page);
  if (!hasText) return true;
  if (Number(streamMark) > 0) {
    const probe = await probeStreamGenerateTiming(page, streamMark).catch(() => null);
    if (probe && Number(probe.count) > 0) return true;
  }
  return false;
}

async function waitForSubmission(page, streamMark, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasSubmissionSignal(page, streamMark)) return true;
    if (typeof page.sleep === 'function') await page.sleep(0.2);
    else if (typeof page.wait === 'function') await page.wait(0.2);
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return hasSubmissionSignal(page, streamMark);
}

export async function sendGeminiPrompt(page, text, opts = {}) {
  const streamMark = opts && Number(opts.streamMark) > 0 ? Number(opts.streamMark) : 0;
  const submitTimeoutMs = Number.isFinite(opts?.submitTimeoutMs) ? Number(opts.submitTimeoutMs) : 2500;
  const controlTimeoutMs = Number.isFinite(opts?.controlTimeoutMs) ? Number(opts.controlTimeoutMs) : 3000;
  await activateCurrentGeminiTab(page);
  const interactionState = await probeGeminiInteractionState(page);
  if (interactionState.visibilityState && interactionState.visibilityState !== 'visible') {
    return { ok: false, reason: 'hidden', dump: interactionState };
  }

  const filled = await fillGeminiComposer(page, text, { controlTimeoutMs });
  if (!filled) {
    const hasText = await composerHasText(page).catch(() => false);
    return { ok: false, reason: hasText ? 'control' : 'fill' };
  }

  await activateCurrentGeminiTab(page);
  await clickSendButton(page);
  if (await waitForSubmission(page, streamMark, submitTimeoutMs)) {
    return { ok: true, via: 'click' };
  }

  await activateCurrentGeminiTab(page);
  await submitGeminiComposer(page);
  if (await waitForSubmission(page, streamMark, submitTimeoutMs)) {
    return { ok: true, via: 'enter' };
  }

  const dump = await page.evaluate(`(() => {
    ${composerLocatorScript()}
    ${sendTargetLocatorScript()}
    const composer = findComposer();
    const sendTarget = findSendTarget();
    const container = document.querySelector('[data-test-id="send-button-container"]');
    const buttons = [...(container ? container.querySelectorAll('button, gem-icon-button') : [])].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    });
    return {
      url: location.href,
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      activeElement: document.activeElement?.tagName?.toLowerCase() || '',
      composerText: ((composer && (composer.innerText || composer.textContent)) || '').slice(0, 240),
      sendContainer: !!container,
      sendTargetFound: !!sendTarget,
      sendTargetRect: sendTarget?.rect || null,
      buttons,
    };
  })()`).catch(() => null);

  if (process.env.OPENCLI_VERBOSE) {
    console.error(`[gemini-agent] submit-failed ${JSON.stringify(unwrapEvaluateResult(dump))}`);
  }
  return { ok: false, reason: 'submit', dump: unwrapEvaluateResult(dump) };
}

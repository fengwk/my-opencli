/**
 * Export generated images through ChatGPT's native Chrome download UI.
 * Image bytes stay in Chrome; Node only receives the completed download receipt
 * and copies the receipt-proven file into the managed output directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { collectDownloadsToOutputDir, toNodeLocalPath } from './artifact-collect.js';
import { unwrapEvaluateResult } from './dom-helpers.js';

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  return '';
}

export function resolveImageOutputDir(value) {
  const raw = String(value || '').trim();
  if (!raw) return path.join(os.homedir(), 'Pictures', 'chatgpt-agent');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function isAllowed(predicate) {
  if (typeof predicate !== 'function') return true;
  try {
    return predicate() === true;
  } catch {
    return false;
  }
}

export function imageTargetsScript(messageIds) {
  return `(() => {
    const ids = new Set(${JSON.stringify(messageIds)});
    if (!ids.size) return { targets: [], reason: 'missing-message-ids' };
    const visible = (el) => {
      if (!el || el.hidden || el.hasAttribute('hidden') || el.closest('[inert], [aria-hidden="true"]')) return false;
      let node = el;
      while (node) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tokenMatch = (scope) => (scope.getAttribute('data-chatgpt-search-message-ids') || '')
      .trim().split(/[\\s,]+/).some((token) => ids.has(token));
    const main = document.querySelector('main') || document.querySelector('[role="main"]');
    if (!main) return { targets: [], reason: 'main-not-found' };
    const galleries = [...main.querySelectorAll('[data-testid="generated-image-gallery"]')];
    const railButtons = [...document.querySelectorAll('button[aria-label^="Show generated image "]')];
    const previewButtons = [...document.querySelectorAll('button[data-testid="generated-image-preview"]')];
    const targets = [];
    const seenScopes = new Set();
    for (const gallery of galleries) {
      const scope = gallery.closest('[data-chatgpt-search-message-ids]');
      if (!scope || !tokenMatch(scope) || scope.closest(
        'form[data-chatgpt-composer], [data-chatgpt-composer], [data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [data-chatgpt-search-unit-key*=":user"]'
      ) || !visible(gallery)) continue;
      if (seenScopes.has(scope)) continue;
      seenScopes.add(scope);
      const rails = [...scope.querySelectorAll('button[aria-label^="Show generated image "]')]
        .filter((button) => button.closest('[data-chatgpt-search-message-ids]') === scope && visible(button))
        .map((button) => ({ button, order: Number((button.getAttribute('aria-label') || '').match(/(\\d+)$/)?.[1]) }))
        .sort((a, b) => a.order - b.order);
      if (rails.length) {
        for (const rail of rails) {
          const preview = [...gallery.querySelectorAll('button[data-testid="generated-image-preview"]')]
            .find((button) => visible(button));
          targets.push({
            kind: 'rail',
            globalIndex: railButtons.indexOf(rail.button),
            previewGlobalIndex: previewButtons.indexOf(preview),
            order: rail.order,
          });
        }
        continue;
      }
      const previews = [...gallery.querySelectorAll('button[data-testid="generated-image-preview"]')]
        .filter((button) => visible(button));
      if (previews.length === 1 && galleries.filter((other) => other.closest('[data-chatgpt-search-message-ids]') === scope).length === 1) {
        targets.push({ kind: 'preview', globalIndex: previewButtons.indexOf(previews[0]), order: 1 });
      } else {
        return { targets: [], reason: 'ambiguous-gallery-without-rail' };
      }
    }
    return { targets, reason: targets.length ? '' : 'no-scoped-gallery' };
  })()`;
}

export function selectedImageMatchesScript(messageIds, target) {
  return `(() => {
    const ids = new Set(${JSON.stringify(messageIds)});
    const buttons = [...document.querySelectorAll('button[aria-label^="Show generated image "]')];
    const rail = buttons[${target.globalIndex}];
    if (!rail) return false;
    const scope = rail.closest('[data-chatgpt-search-message-ids]');
    const tokens = (scope?.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/[\\s,]+/);
    if (!tokens.some((token) => ids.has(token))) return false;
    if (rail.getAttribute('aria-pressed') !== 'true') return false;
    const source = rail.querySelector('img')?.currentSrc || rail.querySelector('img')?.src || '';
    if (!source) return false;
    const preview = [...scope.querySelectorAll('button[data-testid="generated-image-preview"]')]
      .find((button) => {
        const img = button.querySelector('img');
        return img && (img.currentSrc || img.src || '') === source;
      });
    return !!preview;
  })()`;
}

function dialogStateScript() {
  return `(() => {
    const visible = (el) => {
      if (!el || el.hidden || el.closest('[inert], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const allTriggers = [...document.querySelectorAll('[aria-label="Download"]')];
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((el) => visible(el) && el.querySelector('[aria-label="Download"]'));
    const trigger = dialog?.querySelector('[aria-label="Download"]');
    const menu = [...document.querySelectorAll('[role="menu"]')].find(visible);
    const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => ({
      index: [...document.querySelectorAll('[role="menuitem"]')].indexOf(el),
      text: (el.innerText || el.textContent || '').trim(),
      visible: visible(el),
    })) : [];
    const closeButtons = dialog ? [...dialog.querySelectorAll('button')].filter((button) => {
      const label = (button.getAttribute('aria-label') || '').trim();
      return visible(button) && (label === 'Close' || label === '关闭' || button.getAttribute('data-testid') === 'close-button');
    }) : [];
    return {
      dialog: !!dialog,
      triggerIndex: trigger ? allTriggers.indexOf(trigger) : -1,
      menu: !!menu,
      items,
      closeIndex: closeButtons.length === 1
        ? [...document.querySelectorAll('button')].indexOf(closeButtons[0]) : -1,
    };
  })()`;
}

async function evaluate(page, script) {
  return unwrapEvaluateResult(await page.evaluate(script));
}

async function collectReceipt(receipt, outputDir, index) {
  if (!receipt || receipt.downloaded !== true || receipt.state !== 'complete') {
    throw new Error('download-receipt-incomplete');
  }
  const filename = String(receipt.filename || '').trim();
  if (!filename) throw new Error('download-receipt-filename-missing');
  const mimeType = String(receipt.mime || '').toLowerCase();
  const ext = extFromMime(mimeType);
  if (!mimeType.startsWith('image/') || !ext) throw new Error('download-receipt-not-image');
  const sourcePath = toNodeLocalPath(filename);
  let sourceBytes;
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty-or-not-file');
    sourceBytes = fs.readFileSync(sourcePath);
  } catch {
    throw new Error('download-file-unreadable-or-empty');
  }
  if (!isImageBuffer(sourceBytes)) throw new Error('download-file-not-image');
  const [raw] = collectDownloadsToOutputDir([{
    filename,
    path: filename,
    downloaded: true,
    state: receipt.state,
    downloadId: receipt.id,
    originalFilename: filename,
    mimeType,
  }], outputDir);
  if (!raw?.collected || !raw.path) throw new Error('download-file-unavailable');
  let bytes;
  try {
    const stat = fs.statSync(raw.path);
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty-or-not-file');
    bytes = fs.readFileSync(raw.path);
  } catch {
    throw new Error('download-file-unreadable-or-empty');
  }
  if (!isImageBuffer(bytes)) throw new Error('download-file-not-image');
  return {
    kind: 'image-export',
    method: 'chrome-download',
    index,
    downloaded: true,
    path: raw.path,
    originalFilename: filename,
    downloadId: receipt.id,
    mimeType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function isImageBuffer(bytes) {
  const prefix = bytes.subarray(0, 12);
  const isPng = prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  const isGif = /^GIF8[79]a$/.test(prefix.subarray(0, 6).toString('ascii'));
  const isWebp = prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'WEBP';
  return isPng || isJpeg || isGif || isWebp;
}

async function downloadOne(page, target, messageIds, index, outputDir, remainingMs, canContinue) {
  const failed = (error, uncertain = false) => ({
    kind: 'image-export', method: 'chrome-download', index, downloaded: false, error, ...(uncertain ? { uncertain: true } : {}),
  });
  const actionAllowed = () => isAllowed(canContinue) && remainingMs() > 0;
  let viewerOpened = false;
  let waiter = null;
  try {
    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
    if (target.kind === 'rail') {
      const click = await page.click('button[aria-label^="Show generated image "]', { nth: target.globalIndex });
      if (!click || click.matches_n === 0) return failed('image-rail-selection-click-failed');
      let selected = false;
      for (let attempt = 0; attempt < 20 && actionAllowed(); attempt += 1) {
        selected = await evaluate(page, selectedImageMatchesScript(messageIds, target));
        if (selected) break;
        await page.sleep(Math.min(0.2, remainingMs() / 1000));
      }
      if (!selected) return failed('selected-image-preview-not-matched');
    }

    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
    const preview = await page.click(
      'button[data-testid="generated-image-preview"]',
      { nth: target.kind === 'rail' ? target.previewGlobalIndex : target.globalIndex },
    );
    if (!preview || preview.matches_n === 0) return failed('image-preview-click-failed');
    viewerOpened = true;

    let state = null;
    for (let attempt = 0; attempt < 20 && actionAllowed(); attempt += 1) {
      state = await evaluate(page, dialogStateScript());
      if (state?.dialog && state.triggerIndex >= 0) break;
      await page.sleep(Math.min(0.2, remainingMs() / 1000));
    }
    if (!state?.dialog || state.triggerIndex < 0) return failed('image-viewer-not-open');

    if (!state.menu) {
      if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
      await page.focus('[aria-label="Download"]', { nth: state.triggerIndex });
      await page.pressKey('Enter');
      state = await evaluate(page, dialogStateScript());
    }
    const matches = (state?.items || []).filter((item) => item.visible && item.text === 'Download image');
    if (!state?.menu || matches.length !== 1) return failed('exact-download-image-menuitem-not-found');
    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');

    const timeoutMs = Math.max(1, Math.floor(remainingMs()));
    // The waiter is armed synchronously, before the real Chrome/CDP click.
    waiter = page.waitForDownload('', timeoutMs);
    waiter = Promise.resolve(waiter).then((receipt) => ({ receipt }), (error) => ({ error }));
    let clickResult;
    try {
      clickResult = await page.click('[role="menuitem"]', { nth: matches[0].index });
    } catch (error) {
      await waiter;
      waiter = null;
      return failed(`image-download-click-failed: ${error?.message || error}`, true);
    }
    if (!clickResult) {
      await waiter;
      waiter = null;
      return failed('image-download-click-failed');
    }
    const waited = await waiter;
    waiter = null;
    if (waited.error) return failed(`image-download-wait-failed: ${waited.error?.message || waited.error}`, true);
    if (!waited.receipt || waited.receipt.downloaded !== true || waited.receipt.state !== 'complete') {
      return failed('download-receipt-incomplete', true);
    }
    return await collectReceipt(waited.receipt, outputDir, index);
  } catch (error) {
    if (waiter) await waiter;
    return failed(error?.message || String(error));
  } finally {
    if (viewerOpened) {
      try {
        const state = await evaluate(page, dialogStateScript());
        if (state?.closeIndex >= 0) await page.click('button', { nth: state.closeIndex });
      } catch { /* retain the completed receipt even if the viewer cannot close */ }
    }
  }
}

/**
 * Export generated images strictly within protocol messageIds. A single
 * conversation remount may retry missing indices; successes are retained and
 * never counted twice. The caller owns route validation and remaining budget.
 */
export async function exportNewImagesLikeOfficial(page, opts = {}) {
  const ids = Array.isArray(opts.messageIds)
    ? [...new Set(opts.messageIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const expectedCount = Math.max(1, Number(opts.expectedCount) || 1);
  const outputDir = resolveImageOutputDir(opts.outputDir);
  const remainingMs = typeof opts.remainingMs === 'function'
    ? opts.remainingMs
    : () => Number.MAX_SAFE_INTEGER;
  const continuePredicate = opts.canContinue;
  fs.mkdirSync(outputDir, { recursive: true });
  if (!ids.length) {
    return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: 'missing-message-ids' }];
  }

  const successful = new Map();
  let retryBlocked = false;
  const runAttempt = async () => {
    let discovery;
    try {
      discovery = await evaluate(page, imageTargetsScript(ids));
    } catch (error) {
      return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: `image-target-discovery-failed: ${error?.message || error}` }];
    }
    const targets = Array.isArray(discovery?.targets) ? discovery.targets : [];
    const results = [];
    for (let index = 0; index < Math.min(expectedCount, targets.length); index += 1) {
      if (successful.has(index)) continue;
      if (!isAllowed(continuePredicate) || remainingMs() <= 0) {
        results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: 'image-download-time-budget-exhausted' });
        continue;
      }
      const result = await downloadOne(page, targets[index], ids, index, outputDir, remainingMs, continuePredicate);
      results.push(result);
      if (result.downloaded) successful.set(index, result);
      if (result.uncertain) retryBlocked = true;
      if (index < Math.min(expectedCount, targets.length) - 1 && isAllowed(continuePredicate) && remainingMs() > 0) {
        await page.sleep(Math.min(0.4, remainingMs() / 1000));
      }
    }
    for (let index = targets.length; index < expectedCount; index += 1) {
      if (!successful.has(index)) {
        results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: discovery?.reason || 'image-target-unavailable' });
      }
    }
    return results;
  };

  let results = await runAttempt();
  if (successful.size < expectedCount && !retryBlocked && typeof opts.reloadConversation === 'function'
      && isAllowed(opts.canRetry) && remainingMs() > 0) {
    try {
      await opts.reloadConversation();
      results = await runAttempt();
    } catch (error) {
      results.push({ kind: 'image-export', method: 'chrome-download', downloaded: false, error: `image-remount-failed: ${error?.message || error}` });
    }
  }
  const final = [...successful.values()];
  const finalIndices = new Set(final.map((entry) => entry.index));
  for (const result of results) {
    if (!result.downloaded && !finalIndices.has(result.index)) {
      final.push(result);
      if (Number.isInteger(result.index)) finalIndices.add(result.index);
    }
  }
  return final.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
}

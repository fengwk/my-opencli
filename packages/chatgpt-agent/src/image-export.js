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
  if (!raw) {
    // Preserve the existing WSL/Windows default as well as explicit --op.
    if (shouldPreferWindowsPictures()) {
      const winPics = guessWindowsPicturesDir();
      if (winPics) {
        const dir = path.join(winPics, 'chatgpt-agent');
        try {
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        } catch { /* fall through */ }
      }
    }
    return path.join(os.homedir(), 'Pictures', 'chatgpt-agent');
  }
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function shouldPreferWindowsPictures() {
  const force = String(process.env.OPENCLI_UPLOAD_STAGE || process.env.OPENCLI_IMAGE_DIR_WIN || '').trim();
  if (force === '0' || force.toLowerCase() === 'false') return false;
  if (force === '1' || force.toLowerCase() === 'true') return fs.existsSync('/mnt/c/Users');
  if (process.env.WSL_DISTRO_NAME) return fs.existsSync('/mnt/c/Users');
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8')) && fs.existsSync('/mnt/c/Users');
  } catch {
    return false;
  }
}

function guessWindowsPicturesDir() {
  const usersRoot = '/mnt/c/Users';
  if (!fs.existsSync(usersRoot)) return null;
  const skip = new Set(['Public', 'Default', 'Default User', 'All Users', 'desktop.ini']);
  const names = fs.readdirSync(usersRoot).filter((n) => {
    try {
      return !skip.has(n) && fs.statSync(path.join(usersRoot, n)).isDirectory();
    } catch {
      return false;
    }
  });
  const prefer = process.env.WINDOWS_USER || process.env.USER || '';
  const ordered = [
    ...names.filter((n) => n.toLowerCase() === String(prefer).toLowerCase()),
    ...names,
  ];
  for (const n of ordered) {
    const pics = path.join(usersRoot, n, 'Pictures');
    if (fs.existsSync(pics)) return pics;
  }
  return null;
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
    const mainSelector = document.querySelector('main') ? 'main' : '[role="main"]';
    const main = document.querySelector(mainSelector);
    if (!main) return { targets: [], reason: 'main-not-found' };
    const galleries = [...main.querySelectorAll('[data-testid="generated-image-gallery"]')];
    const targets = [];
    const seenScopes = new Set();
    for (const gallery of galleries) {
      const scope = gallery.closest('[data-chatgpt-search-message-ids]');
      if (!scope || !tokenMatch(scope) || gallery.closest(
        'form[data-chatgpt-composer], [data-chatgpt-composer], [data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [data-chatgpt-search-unit-key*=":user"]'
      ) || !visible(gallery)) continue;
      if (seenScopes.has(scope)) continue;
      seenScopes.add(scope);
      const scopeKey = [...new Set((scope.getAttribute('data-chatgpt-search-message-ids') || '')
        .trim().split(/[\\s,]+/).filter((token) => ids.has(token)))].sort().join(',');
      const scopeSelector = mainSelector + ' [data-chatgpt-search-message-ids='
        + JSON.stringify(scope.getAttribute('data-chatgpt-search-message-ids')) + ']';
      if (document.querySelectorAll(scopeSelector).length !== 1
          || [...scope.querySelectorAll('[data-testid="generated-image-gallery"]')]
            .filter((other) => other.closest('[data-chatgpt-search-message-ids]') === scope).length !== 1) {
        return { targets: [], reason: 'ambiguous-gallery-scope' };
      }
      const previewSelector = scopeSelector + ' button[data-testid="generated-image-preview"]:not([aria-hidden="true"])';
      const rails = [...scope.querySelectorAll('[role="group"][aria-label="Generated images"] button[aria-label^="Show generated image "]')]
        .filter((button) => button.closest('[data-chatgpt-search-message-ids]') === scope && visible(button))
        .map((button) => ({ button, order: Number((button.getAttribute('aria-label') || '').match(/(\\d+)$/)?.[1]) }))
        .sort((a, b) => a.order - b.order);
      if (rails.length) {
        for (const rail of rails) {
          targets.push({
            key: scopeKey + ':' + rail.order,
            kind: 'rail',
            selector: scopeSelector + ' [role="group"][aria-label="Generated images"] button[aria-label='
              + JSON.stringify(rail.button.getAttribute('aria-label')) + ']',
            previewSelector,
            order: rail.order,
          });
        }
        continue;
      }
      const previews = [...gallery.querySelectorAll('button[data-testid="generated-image-preview"]')]
        .filter((button) => visible(button));
      if (previews.length === 1 && galleries.filter((other) => other.closest('[data-chatgpt-search-message-ids]') === scope).length === 1) {
        targets.push({ key: scopeKey + ':1', kind: 'preview', previewSelector, order: 1 });
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
    const rail = document.querySelector(${JSON.stringify(target.selector)});
    if (!rail) return false;
    const scope = rail.closest('[data-chatgpt-search-message-ids]');
    const tokens = (scope?.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/[\\s,]+/);
    if (!tokens.some((token) => ids.has(token))) return false;
    const scopeKey = [...new Set(tokens.filter((token) => ids.has(token)))].sort().join(',');
    const order = Number((rail.getAttribute('aria-label') || '').match(/(\\d+)$/)?.[1]);
    if (${JSON.stringify(target.key || '')} && scopeKey + ':' + order !== ${JSON.stringify(target.key || '')}) return false;
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
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((el) => visible(el) && el.querySelector('[aria-label="Download"]'));
    const trigger = dialog?.querySelector('[aria-label="Download"]');
    const menu = trigger?.getAttribute('aria-expanded') === 'true'
      ? [...document.querySelectorAll('[role="menu"]')].find(visible) : null;
    const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => ({
      index: [...menu.querySelectorAll('[role="menuitem"]')].indexOf(el),
      text: (el.innerText || el.textContent || '').trim(),
      visible: visible(el),
    })) : [];
    const closeButtons = dialog ? [...dialog.querySelectorAll('button')].filter((button) => {
      const label = (button.getAttribute('aria-label') || '').trim();
      return visible(button) && (label === 'Close viewer' || label === 'Close' || label === '关闭' || button.getAttribute('data-testid') === 'close-button');
    }) : [];
    const dialogSelector = dialog?.id ? '[role="dialog"][id=' + JSON.stringify(dialog.id) + ']' : '[role="dialog"]';
    const close = closeButtons.length === 1 ? closeButtons[0] : null;
    return {
      dialog: !!dialog,
      triggerSelector: trigger ? dialogSelector + ' [aria-label="Download"]' : '',
      menu: !!menu,
      menuSelector: menu?.id ? '[role="menu"][id=' + JSON.stringify(menu.id) + '] [role="menuitem"]' : '[role="menu"] [role="menuitem"]',
      items,
      closeSelector: close ? dialogSelector + (close.getAttribute('aria-label')
        ? ' button[aria-label=' + JSON.stringify(close.getAttribute('aria-label')) + ']'
        : ' button[data-testid="close-button"]') : '',
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
    ...raw,
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
  let downloadSubmitted = false;
  let waiter = null;
  try {
    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
    if (target.kind === 'rail') {
      const click = await page.click(target.selector);
      if (!(click?.matches_n > 0)) return failed('image-rail-selection-click-failed');
      let selected = false;
      for (let attempt = 0; attempt < 20 && actionAllowed(); attempt += 1) {
        selected = await evaluate(page, selectedImageMatchesScript(messageIds, target));
        if (selected) break;
        await page.sleep(Math.min(0.2, remainingMs() / 1000));
      }
      if (!selected) return failed('selected-image-preview-not-matched');
    }

    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
    const preview = await page.click(target.previewSelector);
    if (!(preview?.matches_n > 0)) return failed('image-preview-click-failed');
    viewerOpened = true;

    let state = null;
    for (let attempt = 0; attempt < 20 && actionAllowed(); attempt += 1) {
      state = await evaluate(page, dialogStateScript());
      if (state?.dialog && state.triggerSelector) break;
      await page.sleep(Math.min(0.2, remainingMs() / 1000));
    }
    if (!state?.dialog || !state.triggerSelector) return failed('image-viewer-not-open');

    if (!state.menu) {
      if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
      await page.focus(state.triggerSelector);
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
      downloadSubmitted = true;
      clickResult = await page.click(state.menuSelector, { nth: matches[0].index });
    } catch (error) {
      await waiter;
      waiter = null;
      return failed(`image-download-click-failed: ${error?.message || error}`, true);
    }
    if (!(clickResult?.matches_n > 0)) {
      await waiter;
      waiter = null;
      return failed('image-download-click-failed', true);
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
    return failed(error?.message || String(error), downloadSubmitted);
  } finally {
    if (viewerOpened) {
      try {
        const state = await evaluate(page, dialogStateScript());
        if (state?.closeSelector) {
          await page.click(state.closeSelector);
          // Wait for the viewer to release the underlying gallery before the
          // next image is selected; a completed file survives cleanup failure.
          for (let attempt = 0; attempt < 20 && actionAllowed(); attempt += 1) {
            if ((await evaluate(page, dialogStateScript()))?.dialog !== true) break;
            await page.sleep(Math.min(0.2, remainingMs() / 1000));
          }
        }
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
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const remainingMs = typeof opts.remainingMs === 'function'
    ? opts.remainingMs
    : () => Math.max(0, deadline - Date.now());
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
      // Protocol completion can precede the gallery controls mounting.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (!isAllowed(continuePredicate) || remainingMs() <= 0) break;
        discovery = await evaluate(page, imageTargetsScript(ids));
        if (discovery?.targets?.length >= expectedCount) break;
        if (attempt < 11) await page.sleep(Math.min(0.5, remainingMs() / 1000));
      }
    } catch (error) {
      return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: `image-target-discovery-failed: ${error?.message || error}` }];
    }
    const targets = Array.isArray(discovery?.targets) ? discovery.targets : [];
    if (targets.length > expectedCount || new Set(targets.map((t) => t.key)).size !== targets.length) {
      return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: 'ambiguous-image-targets' }];
    }
    const keys = new Set(targets.map((target) => target.key));
    if ([...successful.keys()].some((key) => !keys.has(key))) {
      // A remount may reorder indices, but must not replace already completed
      // image identities and then count newly discovered targets as extra images.
      return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: 'image-target-identity-changed' }];
    }
    const results = [];
    for (let index = 0; index < Math.min(expectedCount, targets.length); index += 1) {
      const key = targets[index].key;
      if (successful.has(key)) {
        successful.get(key).index = index;
        continue;
      }
      if (!isAllowed(continuePredicate) || remainingMs() <= 0) {
        results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: 'image-download-time-budget-exhausted' });
        continue;
      }
      const result = await downloadOne(page, targets[index], ids, index, outputDir, remainingMs, continuePredicate);
      results.push(result);
      if (result.downloaded) successful.set(key, result);
      if (result.uncertain) retryBlocked = true;
      if (index < Math.min(expectedCount, targets.length) - 1 && isAllowed(continuePredicate) && remainingMs() > 0) {
        await page.sleep(Math.min(0.4, remainingMs() / 1000));
      }
    }
    for (let index = targets.length; index < expectedCount; index += 1) {
      results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: discovery?.reason || 'image-target-unavailable' });
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

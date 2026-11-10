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
      if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      let node = el;
      while (node) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      // Virtualized galleries can report 0px layout height even after their
      // controls and full-size sources mount. The Page click API handles
      // scrolling/activation; layout size alone must not discard the target.
      return true;
    };
    const scopeTokens = (scope) => [...new Set((scope.getAttribute('data-chatgpt-search-message-ids') || '')
      .trim().split(/[\\s,]+/).filter((token) => ids.has(token)))].sort();
    const imageSource = (img) => {
      const url = img?.currentSrc || img?.src || '';
      // The control channel carries URL references only, never inline pixels.
      return /^(?:blob:|https?:\\/\\/)/i.test(url) ? url : '';
    };
    const tokenMatch = (scope) => scopeTokens(scope).length > 0;
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
      const matchedTokens = scopeTokens(scope);
      const scopeKey = matchedTokens.join(',');
      const rawScope = scope.getAttribute('data-chatgpt-search-message-ids') || '';
      // Use token conjunctions for whitespace scopes; comma legacy scopes are
      // resolved by exact value, never by a broad substring selector.
      const scopeSelector = mainSelector + ' ' + (rawScope.includes(',')
        ? '[data-chatgpt-search-message-ids=' + JSON.stringify(rawScope) + ']'
        : matchedTokens.map((token) =>
          '[data-chatgpt-search-message-ids~=' + JSON.stringify(token) + ']').join(''));
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
            sourceUrl: imageSource(rail.button.querySelector('img')),
          });
        }
        continue;
      }
      const previews = [...gallery.querySelectorAll('button[data-testid="generated-image-preview"]')]
        .filter((button) => visible(button));
      if (previews.length === 1 && galleries.filter((other) => other.closest('[data-chatgpt-search-message-ids]') === scope).length === 1) {
        const img = previews[0].querySelector('img');
        targets.push({
          key: scopeKey + ':1', kind: 'preview', previewSelector, order: 1,
          sourceUrl: imageSource(img),
        });
      } else {
        return { targets: [], reason: 'ambiguous-gallery-without-rail' };
      }
    }
    return { targets, reason: targets.length ? '' : 'no-scoped-gallery' };
  })()`;
}

export function viewerImageStateScript(messageIds, target) {
  return `(() => {
    const ids = new Set(${JSON.stringify(messageIds)});
    const target = ${JSON.stringify(target)};
    const control = document.querySelector(target.kind === 'rail' ? target.selector : target.previewSelector);
    const scope = control?.closest('[data-chatgpt-search-message-ids]');
    const tokens = (scope?.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/[\\s,]+/);
    if (scope && !tokens.some((token) => ids.has(token))) return { ready: false, reason: 'source-scope-missing' };
    if (scope) {
      const scopeKey = [...new Set(tokens.filter((token) => ids.has(token)))].sort().join(',');
      if (target.key !== scopeKey + ':' + target.order) return { ready: false, reason: 'source-identity-changed' };
    } else if (!target.sourceUrl) return { ready: false, reason: 'source-scope-missing' };
    // Gallery DOM can be unmounted after the viewer opens. Trust only the URL
    // captured while the exact current-turn target was still scoped.
    const source = target.sourceUrl || control?.querySelector('img')?.currentSrc || control?.querySelector('img')?.src || '';
    if (!source) return { ready: false, reason: 'source-unavailable' };
    const visible = (el) => {
      if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((el) => visible(el) && [...el.querySelectorAll('button,[role="button"]')]
        .some((button) => ['Download', '下载'].includes((button.getAttribute('aria-label') || '').trim())));
    if (!dialog) return { ready: false, reason: 'viewer-missing' };
    // The viewer rail spans history. It is NOT an output source: select only
    // the exact page-owned source proved by this turn's scoped gallery above.
    const thumbnails = [...dialog.querySelectorAll('button[data-image-thumbnail]')]
      .filter((button) => {
        const img = button.querySelector('img');
        return img && (img.currentSrc || img.src || '') === source;
      });
    if (thumbnails.length > 1) return { ready: false, reason: 'ambiguous-viewer-image' };
    const thumbnail = thumbnails[0];
    const dialogSelector = dialog.id ? '[role="dialog"][id=' + JSON.stringify(dialog.id) + ']' : '[role="dialog"]';
    const selector = thumbnail?.getAttribute('aria-label')
      ? dialogSelector + ' button[data-image-thumbnail][aria-label=' + JSON.stringify(thumbnail.getAttribute('aria-label')) + ']'
      : '';
    const images = [...dialog.querySelectorAll('img')].filter((img) =>
      !img.closest('button[data-image-thumbnail]') && visible(img)
      && img.complete && img.naturalWidth >= 128 && img.naturalHeight >= 128);
    const ready = images.length === 1 && (images[0].currentSrc || images[0].src || '') === source
      && (!thumbnail || thumbnail.getAttribute('aria-current') === 'true');
    return { ready, selector, reason: ready ? '' : 'viewer-image-not-matched' };
  })()`;
}

export function imageDialogStateScript() {
  return `(() => {
    const visible = (el) => {
      if (!el || el.hidden || el.closest('[inert], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter((el) => visible(el) && [...el.querySelectorAll('button,[role="button"]')]
        .some((button) => ['Download', '下载'].includes((button.getAttribute('aria-label') || '').trim())));
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const trigger = dialog && [...dialog.querySelectorAll('button,[role="button"]')]
      .find((button) => ['Download', '下载'].includes((button.getAttribute('aria-label') || '').trim()));
    const rawMenuId = (trigger?.getAttribute('aria-controls') || '').trim();
    const menuId = rawMenuId.toLowerCase() === 'null' ? '' : rawMenuId;
    const popup = trigger?.getAttribute('aria-haspopup');
    const expanded = trigger?.getAttribute('aria-expanded') === 'true';
    const controlled = expanded && menuId ? document.getElementById(menuId) : null;
    const visibleMenus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    const menu = controlled && visible(controlled) ? controlled
      : (!menuId && expanded && popup === 'menu' && visibleMenus.length === 1 ? visibleMenus[0] : null);
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
      blocked: !dialog && [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(visible),
      triggerSelector: trigger ? dialogSelector + ' [aria-label='
        + JSON.stringify(trigger.getAttribute('aria-label')) + ']' : '',
      triggerPopup: popup || '',
      triggerExpanded: expanded,
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

async function refreshScopedTarget(page, target, messageIds, remainingMs, canContinue) {
  let sawKeyWithoutSource = false;
  for (let attempt = 0; attempt < 4 && isAllowed(canContinue) && remainingMs() > 0; attempt += 1) {
    const discovery = await evaluate(page, imageTargetsScript(messageIds));
    const matches = (discovery?.targets || []).filter((item) => item.key === target.key);
    if (matches.length > 1) return { error: 'ambiguous-image-targets' };
    if (matches.length === 1 && matches[0].sourceUrl) return { target: matches[0] };
    if (matches.length === 1) sawKeyWithoutSource = true;
    if (attempt < 3 && remainingMs() > 0) {
      await page.sleep(Math.min(0.2, remainingMs() / 1000));
    }
  }
  return { error: sawKeyWithoutSource ? 'image-source-unavailable' : 'image-preview-target-unavailable' };
}

async function downloadOne(page, target, messageIds, index, outputDir, remainingMs, canContinue) {
  const failed = (error, uncertain = false) => ({
    kind: 'image-export', method: 'chrome-download', index, downloaded: false, error, ...(uncertain ? { uncertain: true } : {}),
  });
  const actionAllowed = () => isAllowed(canContinue) && remainingMs() > 0;
  let downloadSubmitted = false;
  let waiter = null;
  try {
    if (!actionAllowed()) return failed('image-download-time-budget-exhausted');
    let state = await evaluate(page, imageDialogStateScript());
    for (let openAttempt = 0; openAttempt < 2 && !state?.dialog && actionAllowed(); openAttempt += 1) {
      if (state?.blocked) return failed('image-viewer-blocked-by-dialog');
      // Resolve a fresh same-key preview immediately before each activation.
      // A missing virtualized node is rediscovered, never clicked stale.
      const refreshed = await refreshScopedTarget(page, target, messageIds, remainingMs, canContinue);
      if (!refreshed.target) return failed(refreshed.error || 'image-preview-target-unavailable');
      target = refreshed.target;
      let preview;
      try {
        preview = await page.click(target.previewSelector);
      } catch {
        preview = null;
      }
      if (!(preview?.matches_n > 0)) continue;
      const openDeadline = Date.now() + Math.min(10_000, remainingMs());
      while (actionAllowed() && Date.now() < openDeadline) {
        state = await evaluate(page, imageDialogStateScript());
        if (state?.dialog && state.triggerSelector) break;
        await page.sleep(Math.min(0.2, remainingMs() / 1000));
      }
    }
    if (!state?.dialog || !state.triggerSelector) return failed('image-viewer-not-open');

    let image = await evaluate(page, viewerImageStateScript(messageIds, target));
    if (!image?.ready && image?.selector && actionAllowed()) {
      await page.click(image.selector);
    }
    const readyDeadline = Date.now() + Math.min(30_000, remainingMs());
    while (!image?.ready && actionAllowed() && Date.now() < readyDeadline) {
      await page.sleep(Math.min(0.2, remainingMs() / 1000));
      image = await evaluate(page, viewerImageStateScript(messageIds, target));
    }
    if (!image?.ready) return failed(image?.reason || 'viewer-image-not-matched');
    state = await evaluate(page, imageDialogStateScript());
    if (!state?.dialog || !state.triggerSelector || !actionAllowed()) {
      return failed('image-download-trigger-unavailable');
    }
    // Arm once before the trigger: it may itself start a native download, or
    // reveal a menu whose exact image item starts it.
    const timeoutMs = Math.max(1, Math.floor(Math.min(60_000, remainingMs())));
    let settled = false;
    waiter = Promise.resolve(page.waitForDownload('', timeoutMs)).then(
      (receipt) => { settled = true; return { receipt }; },
      (error) => { settled = true; return { error }; },
    );
    try {
      downloadSubmitted = true;
      const triggerResult = await page.click(state.triggerSelector);
      if (!(triggerResult?.matches_n > 0)) {
        const drained = await waiter;
        waiter = null;
        return failed(`image-download-trigger-click-failed${drained.error ? `: ${drained.error?.message || drained.error}` : ''}`, true);
      }
    } catch (error) {
      await waiter;
      waiter = null;
      return failed(`image-download-trigger-click-failed: ${error?.message || error}`, true);
    }
    let waited;
    let menuSeenWithoutExactItem = false;
    const menuDeadline = Date.now() + Math.min(10_000, remainingMs());
    while (!settled && actionAllowed() && Date.now() < menuDeadline) {
      state = await evaluate(page, imageDialogStateScript());
      const matches = (state?.items || []).filter((item) => item.visible
        && ['Download image', '下载图片', '下载图像'].includes(item.text));
      if (state?.menu && matches.length === 1) {
        try {
          const clickResult = await page.click(state.menuSelector, { nth: matches[0].index });
          if (!(clickResult?.matches_n > 0)) {
            waited = await waiter;
            waiter = null;
            return failed('image-download-menuitem-click-failed', true);
          }
        } catch (error) {
          await waiter;
          waiter = null;
          return failed(`image-download-menuitem-click-failed: ${error?.message || error}`, true);
        }
        break;
      }
      if (state?.menu && matches.length !== 1) menuSeenWithoutExactItem = true;
      await page.sleep(Math.min(0.2, remainingMs() / 1000));
    }
    waited = waited || await waiter;
    waiter = null;
    if (waited.error) return failed(`image-download-wait-failed: ${waited.error?.message || waited.error}`, true);
    // A complete direct-trigger receipt remains valid even if the menu never
    // finished populating. Otherwise do not fail an intermediate empty menu.
    if (menuSeenWithoutExactItem
        && (!waited.receipt || waited.receipt.downloaded !== true || waited.receipt.state !== 'complete')) {
      return failed('exact-download-image-menuitem-not-found', true);
    }
    if (!waited.receipt || waited.receipt.downloaded !== true || waited.receipt.state !== 'complete') {
      return failed('download-receipt-incomplete', true);
    }
    return await collectReceipt(waited.receipt, outputDir, index);
  } catch (error) {
    if (waiter) await waiter;
    return failed(error?.message || String(error), downloadSubmitted);
  }
}

async function closeImageViewer(page, remainingMs) {
  try {
    let state = await evaluate(page, imageDialogStateScript());
    if (state?.menu && remainingMs() > 0) {
      await page.pressKey('Escape');
      state = await evaluate(page, imageDialogStateScript());
    }
    for (let attempt = 0; attempt < 2 && state?.dialog && remainingMs() > 0; attempt += 1) {
      if (!state.closeSelector) return false;
      await page.click(state.closeSelector);
      const deadline = Date.now() + Math.min(5_000, remainingMs());
      while (Date.now() < deadline && remainingMs() > 0) {
        state = await evaluate(page, imageDialogStateScript());
        if (!state?.dialog) break;
        await page.sleep(Math.min(0.2, remainingMs() / 1000));
      }
    }
    return !state?.dialog && !state?.blocked;
  } catch { /* keep completed files even if the page cannot clean up */ }
  return false;
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
  if (!await closeImageViewer(page, remainingMs)) {
    return [{ kind: 'image-export', method: 'chrome-download', downloaded: false, error: 'image-viewer-close-failed' }];
  }

  const successful = new Map();
  let retryBlocked = false;
  const runAttempt = async () => {
    let discovery;
    try {
      // Real remote conversations initially expose message placeholders, with
      // galleries appearing only after hydration/image loading. Give that
      // mount a bounded 30s before the one allowed remount resets its progress.
      const mountDeadline = Date.now() + Math.min(30_000, remainingMs());
      for (let attempt = 0; attempt < 60 && Date.now() < mountDeadline; attempt += 1) {
        if (!isAllowed(continuePredicate) || remainingMs() <= 0) break;
        discovery = await evaluate(page, imageTargetsScript(ids));
        if (discovery?.targets?.length >= expectedCount) break;
        if (attempt < 59) await page.sleep(Math.min(0.5, remainingMs() / 1000));
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
      let target = targets[index];
      try {
        const refreshed = await refreshScopedTarget(page, target, ids, remainingMs, continuePredicate);
        if (refreshed.target) {
          target = refreshed.target;
        } else {
          const viewer = await evaluate(page, imageDialogStateScript());
          if (!viewer?.dialog || !target.sourceUrl) {
            results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: refreshed.error || 'image-target-refresh-unavailable' });
            continue;
          }
        }
        if (!target.sourceUrl) {
          results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: 'image-source-unavailable' });
          continue;
        }
      } catch (error) {
        results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: `image-target-refresh-failed: ${error?.message || error}` });
        continue;
      }
      const result = await downloadOne(page, target, ids, index, outputDir, remainingMs, continuePredicate);
      results.push(result);
      if (result.downloaded) successful.set(key, result);
      if (result.uncertain) {
        // A late download from this click must not be mistaken for the next
        // image by a new filename-agnostic waiter. Stop the entire sequence.
        retryBlocked = true;
        break;
      }
      if (index < Math.min(expectedCount, targets.length) - 1 && isAllowed(continuePredicate) && remainingMs() > 0) {
        await page.sleep(Math.min(0.4, remainingMs() / 1000));
      }
    }
    for (let index = targets.length; index < expectedCount; index += 1) {
      results.push({ kind: 'image-export', method: 'chrome-download', index, downloaded: false, error: discovery?.reason || 'image-target-unavailable' });
    }
    return results;
  };

  try {
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
  } finally {
    await closeImageViewer(page, remainingMs);
  }
}

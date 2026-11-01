/**
 * Human-like file download for ChatGPT web.
 *
 * Supported download paths:
 *   1) Modern resource-row:
 *      <span class="group/resource-row relative">
 *        <button aria-label="Open preview of <file>"></button>
 *        ...
 *        <button type="button" aria-label="Download file"></button>
 *      </span>
 *      Focuses preview to reveal download button, clicks Download file without opening preview.
 *   2) Legacy flyout panel:
 *      File chip click opens flyout panel (section[data-testid="screen-threadFlyOut"]),
 *      then clicks header Download button and closes flyout.
 *   3) Legacy chip-direct:
 *      File chip click (behavior-btn or sandbox <a>) triggers download directly.
 *
 * All paths arm waitForDownload BEFORE any click to eliminate race conditions.
 * No silent backend-api fetch.
 */

import {
  fileChipSnippet as chipScript,
  resourceRowSnippet,
  unwrapEvaluateResult,
} from './dom-helpers.js';

export { chipScript, resourceRowSnippet };

const FILE_EXT = 'json|md|txt|csv|html|pdf|png|jpe?g|zip|py|js|ts|tsx|jsx|yml|yaml|xml|toml|svg|webp|gif|bin|tar|gz';
// Basename may include CJK, spaces, percent-encoding; ends with known extension.
const FILE_NAME_TAIL_RE = new RegExp(`([^/\\\\]+\\.(?:${FILE_EXT}))$`, 'i');

function tryDecodeURIComponent(value) {
  const raw = String(value || '');
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeFileName(value) {
  let name = String(value || '').trim();
  name = name.replace(/^sandbox:\/(?:mnt\/data\/)?/i, '');
  // Strip trailing markdown/URL delimiters only (keep legal filename chars like ).
  name = name.replace(/[)\]"'\\]+$/g, (tail) => {
    return /[)\]"'\\]/.test(tail) ? '' : tail;
  });
  // Literal first, then percent-decoded — first successful name wins.
  const candidates = [name];
  const decoded = tryDecodeURIComponent(name);
  if (decoded !== name) candidates.push(decoded);
  for (const c of candidates) {
    const base = (c.split(/[/\\]/).pop() || c).trim();
    const m = base.match(FILE_NAME_TAIL_RE);
    if (!m) continue;
    let name = m[1].trim();
    if (/%[0-9A-Fa-f]{2}/.test(name)) {
      const d = tryDecodeURIComponent(name);
      if (d !== name) {
        const dm = d.match(FILE_NAME_TAIL_RE);
        if (dm) name = dm[1].trim();
      }
    }
    return name;
  }
  return '';
}

/**
 * Only treat as downloadable when THIS turn has sandbox protocol evidence.
 * Do NOT trigger on bare filename mentions like `demo-hello.json` in normal prose.
 *
 * @param {{ files?: Array<{ name?: string, sandboxPath?: string }>, text?: string }} artifacts
 * @returns {string[]}
 */
export function collectExpectedFileNames(artifacts) {
  const names = new Set();

  for (const f of artifacts?.files || []) {
    const path = String(f?.sandboxPath || '');
    if (!/\/mnt\/data\//.test(path) && !/^sandbox:/i.test(path)) continue;
    const n = normalizeFileName(f?.name) || normalizeFileName(path);
    if (n) names.add(n);
  }

  const text = String(artifacts?.text || '');
  const sandboxRes = [
    /sandbox:\/(?:mnt\/data\/)?([^\s)\]"'<>]+)/gi,
    /\(sandbox:\/mnt\/data\/([^)]+)\)/gi,
  ];
  for (const re of sandboxRes) {
    for (const m of text.matchAll(re)) {
      const raw = m[1];
      const n = normalizeFileName(raw) || normalizeFileName(tryDecodeURIComponent(raw));
      if (n) names.add(n);
    }
  }

  return [...names];
}

/**
 * Merge sandbox paths mentioned only in text into files[] metadata.
 */
export function enrichFilesFromText(artifacts) {
  const files = [];
  for (const f of artifacts?.files || []) {
    const name = normalizeFileName(f.name) || normalizeFileName(f.sandboxPath);
    if (!name) continue;
    files.push({
      ...f,
      name,
      sandboxPath: f.sandboxPath && String(f.sandboxPath).includes(name)
        ? f.sandboxPath
        : `/mnt/data/${name}`,
    });
  }
  const text = String(artifacts?.text || '');
  for (const m of text.matchAll(/sandbox:\/(?:mnt\/data\/)?([^\s)\]"'<>]+)/gi)) {
    const fileName = normalizeFileName(m[1]) || normalizeFileName(tryDecodeURIComponent(m[1]));
    if (!fileName) continue;
    if (!files.some((f) => f.name === fileName)) {
      files.push({
        name: fileName,
        messageId: '',
        sandboxPath: `/mnt/data/${fileName}`,
        status: 'mentioned',
        downloadHint: null,
      });
    }
  }
  return { ...artifacts, files };
}

/**
 * @param {object} page IPage
 * @param {string[]} fileNames from THIS turn only (data-driven)
 * @param {{ timeoutMs?: number }} opts
 */
export async function downloadFilesViaDomClick(page, fileNames, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const results = [];
  const names = [...new Set((fileNames || []).map((n) => normalizeFileName(n) || n).filter(Boolean))];

  for (let fileIndex = 0; fileIndex < names.length; fileIndex += 1) {
    const name = names[fileIndex];
    const entry = {
      name,
      opened: false,
      clicked: false,
      downloaded: false,
    };

    try {
      // 1) First attempt: modern resource-row with dedicated Download file button
      const rawDirect = await page.evaluate(`(() => {
        ${resourceRowSnippet()}
        return findResourceRowDownload(${JSON.stringify(name)});
      })()`);
      const directInfo = unwrapEvaluateResult(rawDirect);

      if (directInfo?.found) {
        // Arm download waiter BEFORE clicking to eliminate race condition
        const waitPromise = typeof page.waitForDownload === 'function'
          ? page.waitForDownload(name, timeoutMs)
          : null;
        if (typeof page.sleep === 'function') {
          await page.sleep(0.1);
        }

        const rawClick = await page.evaluate(`(() => {
          ${resourceRowSnippet()}
          return clickResourceRowDownload(${JSON.stringify(name)});
        })()`);
        const clickRes = unwrapEvaluateResult(rawClick);

        entry.opened = true;
        entry.openMeta = clickRes;
        entry.clicked = !!clickRes?.ok;
        entry.clickMeta = { mode: 'resource-row', ...clickRes };

        if (!clickRes?.ok) {
          entry.error = clickRes?.reason || 'resource-row-click-failed';
          results.push(entry);
          continue;
        }

        // Wait strictly for this single download event; do not open preview, do not poll flyout
        const waitResult = waitPromise
          ? await waitPromise.catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
          : { downloaded: false, error: 'waitForDownload unavailable' };

        entry.downloaded = !!waitResult?.downloaded;
        entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
        entry.state = waitResult?.state || '';
        if (!entry.downloaded) {
          entry.error = waitResult?.error || 'download-not-completed';
        }
        results.push(entry);
        continue;
      }

      // 2) Fallback: legacy preview -> flyout panel or chip-direct link route
      const rawChip = await page.evaluate(`(() => {
        ${chipScript()}
        return findFileChip(${JSON.stringify(name)});
      })()`);
      const chip = unwrapEvaluateResult(rawChip);
      if (!chip?.found) {
        entry.error = 'no-file-chip';
        results.push(entry);
        continue;
      }

      // Arm waiter BEFORE clicking any chip that might directly trigger a download
      const waitPromise = typeof page.waitForDownload === 'function'
        ? page.waitForDownload(name, timeoutMs)
        : null;

      const rawOpenMeta = await page.evaluate(`(() => {
        ${chipScript()}
        return clickFileChip(${JSON.stringify(name)});
      })()`);
      const openMeta = unwrapEvaluateResult(rawOpenMeta);
      entry.opened = !!openMeta?.ok;
      entry.openMeta = openMeta;
      if (!openMeta?.ok) {
        entry.error = openMeta?.reason || 'chip-click-failed';
        results.push(entry);
        continue;
      }

      // Poll flyout (legacy previewable files)
      let panelState = { hasFlyout: false, hasDownload: false };
      for (let i = 0; i < 24; i += 1) {
        await page.sleep(0.25);
        const rawPanelState = await page.evaluate(`(() => {
          ${panelScript()}
          return inspectFlyout(${JSON.stringify(name)});
        })()`);
        panelState = unwrapEvaluateResult(rawPanelState) || { hasFlyout: false, hasDownload: false };
        if (panelState?.hasDownload) break;
        if (panelState?.hasFlyout && i < 20) continue;
      }

      let panelClicked = { ok: false, reason: 'no-flyout' };
      if (panelState?.hasDownload) {
        const rawPanelClicked = await page.evaluate(`(() => {
          ${panelScript()}
          return clickFlyoutDownload(${JSON.stringify(name)});
        })()`);
        panelClicked = unwrapEvaluateResult(rawPanelClicked) || { ok: false, reason: 'panel-click-failed' };
        entry.panel = panelClicked;
        entry.clicked = !!panelClicked?.ok;
        entry.clickMeta = { mode: 'panel', ...panelClicked };
      } else if (panelState?.hasFlyout) {
        entry.panel = { ok: false, reason: 'flyout-without-download', ...panelState };
        entry.clicked = false;
        entry.error = 'flyout-without-download';
      } else {
        // No flyout appeared: direct download from chip
        entry.clicked = true;
        entry.clickMeta = { mode: 'chip-direct', ...openMeta };
        entry.panel = { ok: false, reason: 'no-flyout' };
      }

      const waitResult = waitPromise
        ? await waitPromise.catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
        : { downloaded: false, error: 'waitForDownload unavailable' };

      entry.downloaded = !!waitResult?.downloaded;
      entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
      entry.state = waitResult?.state || '';
      if (!entry.downloaded && !entry.error) {
        entry.error = waitResult?.error || 'download-not-completed';
      }

      // Close legacy flyout if open
      const rawClosed = await page.evaluate(`(() => {
        ${panelScript()}
        return closeFlyout(${JSON.stringify(name)});
      })()`).catch(() => ({ ok: false }));
      const closed = unwrapEvaluateResult(rawClosed);
      entry.closed = !!closed?.ok;
      entry.closeMeta = closed;

      results.push(entry);
    } catch (e) {
      entry.error = String(e?.message || e);
      results.push(entry);
    }
  }

  return results;
}

/**
 * Click-to-download for visual export images in the last assistant turn.
 */
export async function downloadImagesViaDomClick(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const count = opts.count ?? 1;
  const results = [];

  for (let i = 0; i < count; i += 1) {
    const waitPromise = typeof page.waitForDownload === 'function'
      ? page.waitForDownload('', timeoutMs)
      : null;
    await page.sleep(0.1);

    const rawClickMeta = await page.evaluate(`(() => {
      ${imageDownloadScript()}
      return clickNextImageDownload(${i});
    })()`);
    const clickMeta = unwrapEvaluateResult(rawClickMeta);

    if (!clickMeta?.ok) {
      results.push({ index: i, clicked: false, downloaded: false, error: clickMeta?.reason || 'no-button' });
      break;
    }

    const waitResult = waitPromise
      ? await waitPromise.catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
      : { downloaded: false, error: 'waitForDownload unavailable' };

    results.push({
      index: i,
      clicked: true,
      downloaded: !!waitResult?.downloaded,
      path: waitResult?.filename || waitResult?.path || waitResult?.url || '',
      state: waitResult?.state || '',
      error: waitResult?.error,
    });
    await page.sleep(0.5);
  }

  return results;
}

function imageDownloadScript() {
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const lastAssistantRoot = () => {
      const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (isVisible(nodes[i])) return nodes[i];
      }
      return document.body;
    };
    const listImageDownloadButtons = () => {
      const root = lastAssistantRoot();
      if (!root) return [];
      const btns = [...root.querySelectorAll('button, a[download], [role="button"]')];
      const scored = [];
      for (const el of btns) {
        if (!isVisible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').trim();
        const text = ((el.innerText || el.textContent || '') + '').trim();
        const label = (aria + ' ' + text).replace(/\\s+/g, ' ').trim();
        const lower = label.toLowerCase();
        if (/生成下载|create file|download file|导出文件|sandbox|copy link|复制链接|share|分享|edit|编辑|regenerate|重新生成/i.test(lower)) {
          continue;
        }
        const isDl = /^(download|下载)$/i.test(label)
          || /\\bdownload\\b|下载图片|save image|保存图片|download image|download this image/i.test(lower)
          || el.hasAttribute('download');
        if (!isDl) continue;
        const nearImg = !!(
          el.closest('figure, picture, [class*="image"], [class*="Image"], [data-testid*="image"]')
          || el.parentElement?.querySelector('img')
          || el.closest('div')?.querySelector('img')
        );
        const imgSibling = el.closest('div, section, article')?.querySelector('img');
        const imgBig = imgSibling && (imgSibling.naturalWidth || imgSibling.width || 0) > 64;
        scored.push({
          el,
          nearImg: nearImg || !!imgBig,
          aria,
          text: text.slice(0, 40),
          score: (nearImg || imgBig ? 10 : 0) + (/^(download|下载)$/i.test(label) ? 5 : 0),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.some((s) => s.nearImg)) {
        return scored.filter((s) => s.nearImg);
      }
      return scored;
    };
    const clickNextImageDownload = (index) => {
      const list = listImageDownloadButtons();
      if (!list.length) return { ok: false, reason: 'no-image-download-button', count: 0 };
      if (index >= list.length) return { ok: false, reason: 'no-more-image-download-buttons', count: list.length };
      const item = list[index];
      item.el.click();
      return {
        ok: true,
        index,
        count: list.length,
        aria: item.aria || '',
        nearImg: item.nearImg,
      };
    };
  `;
}

function panelScript() {
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    };
    const findFlyout = (fileName) => {
      const byTestId = document.querySelector('section[data-testid="screen-threadFlyOut"]');
      if (byTestId) {
        const aria = (byTestId.getAttribute('aria-label') || '').trim();
        if (!fileName || !aria || aria === fileName || aria.includes(fileName) || (byTestId.innerText || '').includes(fileName)) {
          return byTestId;
        }
      }
      const stage = document.querySelector('[data-testid="stage-thread-flyout"], [data-stage-thread-flyout="true"]');
      if (stage) {
        const sec = stage.querySelector('section[data-testid="screen-threadFlyOut"], section[aria-label]');
        if (sec) return sec;
      }
      const flyouts = [...document.querySelectorAll('section[aria-label]')];
      return flyouts.find((s) => (s.getAttribute('aria-label') || '') === fileName)
        || flyouts.find((s) => (s.getAttribute('aria-label') || '').includes(fileName))
        || null;
    };

    const findDownloadButton = (root) => {
      if (!root) return null;
      const preferred = root.querySelector(
        'header button[aria-label="Download"], header button[aria-label="下载"], button[aria-label="Download"], button[aria-label="下载"]',
      );
      if (preferred) return preferred;
      return [...root.querySelectorAll('button')].find((b) => {
        const aria = (b.getAttribute('aria-label') || '').trim();
        const text = (b.innerText || b.textContent || '').trim();
        return aria === 'Download' || aria === '下载' || text === 'Download' || text === '下载';
      }) || null;
    };

    const inspectFlyout = (fileName) => {
      const root = findFlyout(fileName);
      if (!root) return { hasFlyout: false, hasDownload: false };
      const btn = findDownloadButton(root);
      return {
        hasFlyout: true,
        hasDownload: !!btn,
        flyoutAria: (root.getAttribute('aria-label') || '').slice(0, 60),
        downloadAria: btn ? (btn.getAttribute('aria-label') || '').trim() : '',
      };
    };

    const clickFlyoutDownload = (fileName) => {
      const root = findFlyout(fileName);
      if (!root) return { ok: false, reason: 'no-flyout' };
      const btn = findDownloadButton(root);
      if (!btn) return { ok: false, reason: 'no-download-button-in-flyout' };

      btn.scrollIntoView({ block: 'center', inline: 'center' });
      btn.focus?.();
      btn.click();
      return {
        ok: true,
        aria: (btn.getAttribute('aria-label') || '').trim(),
        tag: btn.tagName,
        flyout: (root.getAttribute('aria-label') || root.getAttribute('data-testid') || '').slice(0, 60),
      };
    };

    const closeFlyout = (fileName) => {
      const root = findFlyout(fileName)
        || document.querySelector('section[data-testid="screen-threadFlyOut"]');
      if (!root || !isVisible(root)) return { ok: false, reason: 'no-flyout-to-close' };

      let btn = root.querySelector('button[data-testid="close-button"], button[aria-label="Close"]');
      if (!btn || !isVisible(btn)) {
        btn = [...root.querySelectorAll('button')].find((b) => {
          if (!isVisible(b)) return false;
          const aria = (b.getAttribute('aria-label') || '').trim();
          const testid = b.getAttribute('data-testid') || '';
          return aria === 'Close' || aria === '关闭' || testid === 'close-button';
        }) || null;
      }
      if (!btn) return { ok: false, reason: 'no-close-button' };
      btn.click();
      return {
        ok: true,
        aria: (btn.getAttribute('aria-label') || '').trim(),
        testid: btn.getAttribute('data-testid') || '',
      };
    };
  `;
}

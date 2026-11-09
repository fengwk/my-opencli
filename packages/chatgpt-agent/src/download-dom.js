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
    // If the whole basename is wrapped, drop trailing wrappers; do not strip
    // internal punctuation from names like report(2024).json mid-string.
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
    // If we only matched a percent-encoded basename, decode to human name.
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

  // Protocol fileRefs that already carry sandbox paths
  for (const f of artifacts?.files || []) {
    const path = String(f?.sandboxPath || '');
    if (!/\/mnt\/data\//.test(path) && !/^sandbox:/i.test(path)) continue;
    const n = normalizeFileName(f?.name) || normalizeFileName(path);
    if (n) names.add(n);
  }

  // Stream text must contain sandbox protocol (literal first, then decoded).
  const text = String(artifacts?.text || '');
  const sandboxRes = [
    /sandbox:\/(?:mnt\/data\/)?([^\s)\]"'<>]+)/gi,
    /\(sandbox:\/mnt\/data\/([^)]+)\)/gi,
  ];
  for (const re of sandboxRes) {
    for (const m of text.matchAll(re)) {
      const raw = m[1];
      // 1) try as-is  2) try decodeURIComponent — first successful name wins per match
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
    let waitPromise = null;

    try {
      // 1) First attempt: modern resource-row with dedicated Download file button
      const rawDirect = await page.evaluate(`(() => {
        ${resourceRowSnippet()}
        return findResourceRowDownload(${JSON.stringify(name)});
      })()`);
      const directInfo = unwrapEvaluateResult(rawDirect);

      if (directInfo?.found) {
        // Arm download waiter BEFORE clicking to eliminate race condition. Catch-wrapped to avoid unhandled rejections.
        waitPromise = typeof page.waitForDownload === 'function'
          ? page.waitForDownload(name, timeoutMs).catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
          : Promise.resolve({ downloaded: false, error: 'waitForDownload unavailable' });

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
        }

        // Always await armed waiter to eliminate dangling promises
        const waitResult = await waitPromise;
        waitPromise = null;

        if (clickRes?.ok) {
          entry.downloaded = !!waitResult?.downloaded;
          entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
          entry.state = waitResult?.state || '';
          if (!entry.downloaded) {
            entry.error = waitResult?.error || 'download-not-completed';
          }
        }
        results.push(entry);
      } else {
        // 2) Fallback: legacy preview -> flyout panel or chip-direct link route
        const rawChip = await page.evaluate(`(() => {
          ${chipScript()}
          return findFileChip(${JSON.stringify(name)});
        })()`);
        const chip = unwrapEvaluateResult(rawChip);
        if (!chip?.found) {
          entry.error = 'no-file-chip';
          results.push(entry);
        } else {
          // Arm waiter BEFORE clicking any chip that might directly trigger a download. Catch-wrapped.
          waitPromise = typeof page.waitForDownload === 'function'
            ? page.waitForDownload(name, timeoutMs).catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
            : Promise.resolve({ downloaded: false, error: 'waitForDownload unavailable' });

          const rawOpenMeta = await page.evaluate(`(() => {
            ${chipScript()}
            return clickFileChip(${JSON.stringify(name)});
          })()`);
          const openMeta = unwrapEvaluateResult(rawOpenMeta);
          entry.opened = !!openMeta?.ok;
          entry.openMeta = openMeta;

          if (!openMeta?.ok) {
            entry.error = openMeta?.reason || 'chip-click-failed';
          } else {
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
          }

          // Always await armed waiter to eliminate dangling promises
          const waitResult = await waitPromise;
          waitPromise = null;

          if (entry.clicked) {
            entry.downloaded = !!waitResult?.downloaded;
            entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
            entry.state = waitResult?.state || '';
            if (!entry.downloaded && !entry.error) {
              entry.error = waitResult?.error || 'download-not-completed';
            }
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
        }
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      results.push(entry);
    } finally {
      if (waitPromise) {
        await waitPromise.catch(() => ({}));
        waitPromise = null;
      }
      // Fixed gap between files so multi-download is not a zero-interval click burst
      if (fileIndex < names.length - 1) {
        await page.sleep(0.4);
      }
    }
  }

  return results;
}

function panelScript() {
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      // Icon buttons may briefly report tiny size while animating; allow 1px.
      return r.width >= 1 && r.height >= 1;
    };
    // Real DOM (previewable files):
    //   div[data-testid="stage-thread-flyout"] > section[data-testid="screen-threadFlyOut"][aria-label=name]
    //   header button[aria-label="Download"] + button[data-testid="close-button"]
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
      // Prefer exact header control from DOM dump.
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

    const hasFlyoutDownload = (fileName) => {
      const info = inspectFlyout(fileName);
      return !!info.hasDownload;
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

    // Close flyout: data-testid="close-button" or aria-label="Close"
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

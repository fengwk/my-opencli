/**
 * Human-like file download for ChatGPT web.
 *
 * Facts from real DOM:
 *   1) Stream text may contain [name](sandbox:/mnt/data/name)
 *   2) Message has <button class="behavior-btn" aria-label="name.json">
 *   3) Some file types open a flyout: section[data-testid="screen-threadFlyOut"]
 *      with header button[aria-label="Download"]
 *   4) Not every file opens a preview — only when expanded, click panel Download.
 *
 * No silent backend-api fetch.
 */

import {
  fileChipSnippet as chipScript,
  panelScript,
  imageDownloadScript,
  unwrapEvaluateResult,
} from './dom-helpers.js';

export { chipScript, panelScript, imageDownloadScript };

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

    try {
      // 1) File chip must exist (behavior-btn or sandbox link)
      const rawChip = await page.evaluate(`(() => {
        ${chipScript()}
        return findFileChip(${JSON.stringify(name)});
      })()`);
      const chip = unwrapEvaluateResult(rawChip);
      if (!chip?.found) {
        entry.error = 'no-file-chip';
        results.push(entry);
      } else {
        // 2) Click chip first — may expand flyout (preview) or download directly.
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
        } else {
          // 3) Poll: flyout may animate open (stage-thread-flyout width).
          //    Only treat as "chip-direct" if NO flyout appears at all.
          let panelState = { hasFlyout: false, hasDownload: false };
          for (let i = 0; i < 24; i += 1) {
            await page.sleep(0.25);
            const rawPanelState = await page.evaluate(`(() => {
              ${panelScript()}
              return inspectFlyout(${JSON.stringify(name)});
            })()`);
            panelState = unwrapEvaluateResult(rawPanelState) || { hasFlyout: false, hasDownload: false };
            if (panelState?.hasDownload) break;
            // Flyout visible but Download not ready yet — keep waiting.
            if (panelState?.hasFlyout && i < 20) continue;
          }

          const waitPromise = typeof page.waitForDownload === 'function'
            ? page.waitForDownload('', timeoutMs)
            : null;
          await page.sleep(0.1);

          let panelClicked = { ok: false, reason: 'no-flyout' };
          if (panelState?.hasDownload) {
            const rawPanelClicked = await page.evaluate(`(() => {
              ${panelScript()}
              return clickFlyoutDownload(${JSON.stringify(name)});
            })()`);
            panelClicked = unwrapEvaluateResult(rawPanelClicked) || { ok: false, reason: 'panel-click-failed' };
            entry.panel = panelClicked;
            entry.clicked = !!panelClicked?.ok;
            entry.clickMeta = panelClicked?.ok
              ? panelClicked
              : { mode: 'panel-miss', ...panelClicked };
          } else if (panelState?.hasFlyout) {
            // Flyout open but no Download control — report, still try close later.
            entry.panel = { ok: false, reason: 'flyout-without-download', ...panelState };
            entry.clicked = false;
            entry.error = 'flyout-without-download';
          } else {
            // Truly no panel: non-preview file may download from chip alone.
            entry.clicked = true;
            entry.clickMeta = { mode: 'chip-direct', ...openMeta };
            entry.panel = { ok: false, reason: 'no-flyout' };
          }

          let waitResult = waitPromise
            ? await waitPromise.catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
            : { downloaded: false, error: 'waitForDownload unavailable' };

          entry.downloaded = !!waitResult?.downloaded;
          entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
          entry.state = waitResult?.state || '';
          if (!entry.downloaded) {
            entry.error = waitResult?.error || 'download-not-completed';
          }

          // Always try close if flyout is open (even when download failed).
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
    }

    // Fixed gap between files so multi-download is not a zero-interval click burst.
    if (fileIndex < names.length - 1) {
      await page.sleep(0.4);
    }
  }

  return results;
}

/**
 * Download generated images from the last assistant turn (human-like).
 * Data-driven: only call when THIS turn's protocol collected image pointers.
 * Clicks Download controls in the last assistant message; uses waitForDownload.
 *
 * @param {object} page
 * @param {{ timeoutMs?: number, expectedCount?: number }} opts
 */
export async function downloadImagesViaDomClick(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const expectedCount = Math.max(1, opts.expectedCount || 1);
  const results = [];

  // Brief settle for image tiles / download affordances to mount.
  await page.sleep(1.0);

  for (let i = 0; i < expectedCount; i += 1) {
    const entry = {
      kind: 'image',
      index: i,
      clicked: false,
      downloaded: false,
    };
    try {
      const waitPromise = typeof page.waitForDownload === 'function'
        ? page.waitForDownload('', timeoutMs)
        : null;

      const rawClickMeta = await page.evaluate(`(() => {
        ${imageDownloadScript()}
        return clickNextImageDownload(${i});
      })()`);
      const clickMeta = unwrapEvaluateResult(rawClickMeta);

      entry.clickMeta = clickMeta;
      entry.clicked = !!clickMeta?.ok;
      if (!clickMeta?.ok) {
        entry.error = clickMeta?.reason || 'image-download-click-failed';
        results.push(entry);
        // No more buttons — stop trying further indices.
        break;
      }

      let waitResult = waitPromise
        ? await waitPromise.catch((e) => ({ downloaded: false, error: String(e?.message || e) }))
        : { downloaded: false, error: 'waitForDownload unavailable' };

      entry.downloaded = !!waitResult?.downloaded;
      entry.path = waitResult?.filename || waitResult?.path || waitResult?.url || '';
      entry.state = waitResult?.state || '';
      if (!entry.downloaded) {
        entry.error = waitResult?.error || 'download-not-completed';
      }
      results.push(entry);
      await page.sleep(0.4);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      results.push(entry);
    }
  }

  return results;
}


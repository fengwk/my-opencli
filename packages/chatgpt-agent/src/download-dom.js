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

  for (const name of names) {
    const entry = {
      name,
      opened: false,
      clicked: false,
      downloaded: false,
    };

    try {
      // 1) File chip must exist (behavior-btn)
      const chip = await page.evaluate(`(() => {
        ${chipScript()}
        return findFileChip(${JSON.stringify(name)});
      })()`);
      if (!chip?.found) {
        entry.error = 'no-file-chip';
        results.push(entry);
        continue;
      }

      // 2) Click chip first — may expand flyout (preview) or download directly.
      const openMeta = await page.evaluate(`(() => {
        ${chipScript()}
        return clickFileChip(${JSON.stringify(name)});
      })()`);
      entry.opened = !!openMeta?.ok;
      entry.openMeta = openMeta;
      if (!openMeta?.ok) {
        entry.error = openMeta?.reason || 'chip-click-failed';
        results.push(entry);
        continue;
      }

      // 3) Poll: flyout may animate open (stage-thread-flyout width).
      //    Only treat as "chip-direct" if NO flyout appears at all.
      let panelState = { hasFlyout: false, hasDownload: false };
      for (let i = 0; i < 24; i += 1) {
        await page.sleep(0.25);
        panelState = await page.evaluate(`(() => {
          ${panelScript()}
          return inspectFlyout(${JSON.stringify(name)});
        })()`);
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
        panelClicked = await page.evaluate(`(() => {
          ${panelScript()}
          return clickFlyoutDownload(${JSON.stringify(name)});
        })()`);
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
      const closed = await page.evaluate(`(() => {
        ${panelScript()}
        return closeFlyout(${JSON.stringify(name)});
      })()`).catch(() => ({ ok: false }));
      entry.closed = !!closed?.ok;
      entry.closeMeta = closed;
      results.push(entry);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      results.push(entry);
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

      const clickMeta = await page.evaluate(`(() => {
        ${imageDownloadScript()}
        return clickNextImageDownload(${i});
      })()`);

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
    // Prefer Download / 下载 on image tiles. Avoid "生成下载文件" (sandbox file tool).
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
        // Not a file-export / code-interpreter affordance.
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
        // Pure icon buttons next to large imgs also count.
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
      // If any near-image control exists, drop non-image ones.
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

function chipScript() {
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // Only search inside the LAST assistant message turn (this reply), not history.
    const lastAssistantRoot = () => {
      const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (isVisible(nodes[i])) return nodes[i];
      }
      // Fallback: last conversation-turn assistant section
      const turns = [...document.querySelectorAll('section[data-turn="assistant"], section[data-testid*="conversation-turn"]')];
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (isVisible(turns[i]) && turns[i].querySelector('[data-message-author-role="assistant"], .markdown')) {
          return turns[i];
        }
      }
      return null;
    };
    const nameMatches = (label, fileName) => {
      if (!label || !fileName) return false;
      if (label === fileName || label.includes(fileName)) return true;
      // UI may show percent-encoded Chinese names while we hold decoded names.
      try {
        const dec = decodeURIComponent(label);
        if (dec === fileName || dec.includes(fileName)) return true;
      } catch (_) {}
      try {
        const enc = encodeURIComponent(fileName);
        if (label === enc || label.includes(enc)) return true;
      } catch (_) {}
      return false;
    };
    const chipsIn = (root, fileName) => {
      if (!root) return [];
      const out = [];
      for (const btn of root.querySelectorAll('button.behavior-btn, button[aria-label]')) {
        if (!isVisible(btn)) continue;
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const text = (btn.innerText || btn.textContent || '').trim();
        if (nameMatches(aria, fileName) || nameMatches(text, fileName)) out.push(btn);
      }
      return out;
    };
    const findFileChip = (fileName) => {
      const root = lastAssistantRoot();
      const chips = chipsIn(root, fileName);
      if (!chips.length) return { found: false, scope: root ? 'last-assistant' : 'none' };
      const btn = chips[chips.length - 1];
      return {
        found: true,
        aria: (btn.getAttribute('aria-label') || '').trim(),
        text: ((btn.innerText || btn.textContent || '') + '').trim().slice(0, 80),
        className: String(btn.className || '').slice(0, 60),
        scope: 'last-assistant',
      };
    };
    const clickFileChip = (fileName) => {
      const root = lastAssistantRoot();
      const chips = chipsIn(root, fileName);
      const best = chips[chips.length - 1];
      if (!best) return { ok: false, reason: 'chip-missing-in-last-assistant', scope: root ? 'last-assistant' : 'none' };
      best.scrollIntoView({ block: 'center', inline: 'center' });
      best.focus?.();
      best.click();
      return {
        ok: true,
        tag: best.tagName,
        aria: (best.getAttribute('aria-label') || '').trim(),
        className: String(best.className || '').slice(0, 60),
        scope: 'last-assistant',
      };
    };
  `;
}

function panelScript() {
  return `
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
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

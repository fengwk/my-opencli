/**
 * Human-like ChatGPT composer attachment upload.
 *
 * Primary (Playwright-like / OpenCLI extension):
 *   page.setFileInput → CDP intercept file chooser → DOM.setFileInputFiles
 *   (does NOT show the OS file manager when intercept works)
 *
 * Fallback (same as official clis/chatgpt uploadChatGPTImages):
 *   DataTransfer + React onChange on input[type=file]
 *   Still uses the page file input — not a silent backend upload API.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Path translation for the browser host that owns Chrome.
 *
 * - Native Linux Chrome: pass POSIX paths as-is (no Windows staging).
 * - WSL CLI + Windows Chrome: map /mnt/c -> C:\, and copy /home/... into
 *   C:\Users\<user>\Downloads\opencli-upload\ so CDP setFileInput can read them.
 *
 * Override:
 *   OPENCLI_UPLOAD_STAGE=0  force no staging
 *   OPENCLI_UPLOAD_STAGE=1  force staging when /mnt/c is available
 */
export function isWslEnv() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const v = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(v);
  } catch {
    return false;
  }
}

/** Whether we should copy files onto a Windows-visible drive for setFileInput. */
export function needsWindowsUploadStaging() {
  const force = String(process.env.OPENCLI_UPLOAD_STAGE || '').trim();
  if (force === '0' || force.toLowerCase() === 'false') return false;
  if (force === '1' || force.toLowerCase() === 'true') return fs.existsSync('/mnt/c/Users');
  // Default: only WSL talking to likely Windows Chrome.
  return isWslEnv() && fs.existsSync('/mnt/c/Users');
}

export function toBrowserLocalPath(absPath) {
  const p = path.resolve(absPath);
  // Only translate drive mounts when staging for Windows Chrome.
  if (needsWindowsUploadStaging() || process.env.OPENCLI_FORCE_WIN_PATH === '1') {
    const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (m) {
      return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    }
  }
  return p;
}

function windowsUserDownloadsDir() {
  const usersRoot = '/mnt/c/Users';
  if (!fs.existsSync(usersRoot)) return null;
  const skip = new Set(['Public', 'Default', 'Default User', 'All Users', 'desktop.ini']);
  let names = [];
  try {
    names = fs.readdirSync(usersRoot).filter((n) => {
      try {
        return !skip.has(n) && fs.statSync(path.join(usersRoot, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  const prefer = process.env.WINDOWS_USER || process.env.USER || '';
  const ordered = [
    ...names.filter((n) => n.toLowerCase() === String(prefer).toLowerCase()),
    ...names.filter((n) => fs.existsSync(path.join(usersRoot, n, 'Downloads'))),
  ];
  const pick = ordered[0] || names[0];
  if (!pick) return null;
  const dl = path.join(usersRoot, pick, 'Downloads');
  return fs.existsSync(dl) ? dl : null;
}

/**
 * Ensure a file is reachable by the browser host's setFileInput.
 * @returns {{ nodePath: string, browserPath: string, name: string, staged: boolean }}
 */
export function stageForBrowserUpload(nodePath) {
  const resolved = path.resolve(nodePath);
  const name = path.basename(resolved);

  // Linux Chrome / mac / pure native: no copy.
  if (!needsWindowsUploadStaging()) {
    return {
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved),
      name,
      staged: false,
    };
  }

  // Already on a Windows drive mount under WSL
  if (/^\/mnt\/[a-z]\//i.test(resolved)) {
    return {
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved),
      name,
      staged: false,
    };
  }

  const dl = windowsUserDownloadsDir();
  if (!dl) {
    return {
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved),
      name,
      staged: false,
    };
  }
  const stageDir = path.join(dl, 'opencli-upload');
  fs.mkdirSync(stageDir, { recursive: true });
  const dest = path.join(stageDir, name);
  let need = true;
  try {
    const a = fs.statSync(resolved);
    const b = fs.statSync(dest);
    // Copy when content likely changed (size or mtime differs either way).
    need = a.size !== b.size || a.mtimeMs !== b.mtimeMs;
  } catch {
    need = true;
  }
  if (need) fs.copyFileSync(resolved, dest);
  return {
    nodePath: dest,
    browserPath: toBrowserLocalPath(dest),
    name,
    staged: true,
  };
}

function mimeFromPath(filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

/**
 * @param {string|string[]|undefined} fileArg
 * @returns {{ ok: true, files: Array<{ nodePath: string, browserPath: string, name: string }> } | { ok: false, reason: string }}
 */
/**
 * Accept:
 *   - undefined / ''
 *   - single path string
 *   - comma-separated string
 *   - string[] from repeatable --file a --file b
 *   - mixed (array items may themselves be comma-separated)
 */
export function prepareLocalFiles(fileArg) {
  if (fileArg == null || fileArg === '') return { ok: true, files: [] };
  const raw = [];
  const push = (v) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    for (const part of String(v).split(',')) {
      const t = part.trim();
      if (t) raw.push(t);
    }
  };
  push(fileArg);

  const files = [];
  for (const item of raw) {
    const nodePath = path.resolve(item);
    if (!fs.existsSync(nodePath)) return { ok: false, reason: `File not found: ${nodePath}` };
    const st = fs.statSync(nodePath);
    if (!st.isFile()) return { ok: false, reason: `Not a file: ${nodePath}` };
    if (st.size > 100 * 1024 * 1024) {
      return { ok: false, reason: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    // Stage onto a Windows-visible path so setFileInput works (official path).
    const staged = stageForBrowserUpload(nodePath);
    files.push({
      // nodePath: path Node can still read for DataTransfer fallback
      nodePath: staged.nodePath,
      sourcePath: nodePath,
      browserPath: staged.browserPath,
      name: staged.name,
    });
  }
  return { ok: true, files };
}

async function dismissMenus(page) {
  // Escape may be swallowed by focus traps; also close + menu by re-click / blur.
  await page.evaluate(`(() => {
    const esc = () => {
      for (const target of [document.activeElement, document.body, document].filter(Boolean)) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      }
    };
    esc();
    // If plus menu still open (menuitem visible), click composer to dismiss.
    const menuOpen = [...document.querySelectorAll('[role="menuitem"], button')].some((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      return /add photos|添加照片|add files|google drive|onedrive|create image|生成图片/.test(t);
    });
    if (menuOpen) {
      const composer = document.querySelector(
        '#prompt-textarea, [data-testid="prompt-textarea"], .ProseMirror[contenteditable="true"]',
      );
      if (composer instanceof HTMLElement) composer.click();
      esc();
    }
  })()`).catch(() => null);
  await page.sleep(0.25);
}

/**
 * Upload attachments one-by-one (human-like).
 * Avoids bulk base64 payloads that blow the evaluate channel on multi large images.
 *
 * @param {object} page
 * @param {Array<{ nodePath: string, browserPath: string, name: string }>} preparedFiles
 */
export async function uploadComposerFiles(page, preparedFiles) {
  if (!preparedFiles?.length) return { ok: true, files: [] };

  const basenames = preparedFiles.map((f) => f.name);
  await dismissMenus(page);
  await ensureFileInputsMounted(page);

  const done = [];
  for (let i = 0; i < preparedFiles.length; i += 1) {
    const file = preparedFiles[i];
    const expectNames = [...done, file.name];
    if (process.env.OPENCLI_VERBOSE) {
      console.error(`[chatgpt-agent] upload-one ${i + 1}/${preparedFiles.length} name=${file.name}`);
    }

    let okOne = false;
    let lastErr = '';

    // 1) setFileInput single file (official CDP path)
    if (typeof page.setFileInput === 'function') {
      const isImage = String(mimeFromPath(file.nodePath)).startsWith('image/');
      const selectors = isImage
        ? ['#upload-photos', 'input[type="file"][accept*="image"]', '#upload-files', 'input[type="file"]']
        : ['#upload-files', 'form input[type="file"]', 'input[type="file"]'];
      for (const selector of selectors) {
        try {
          await page.setFileInput([file.browserPath], selector);
          okOne = true;
          if (process.env.OPENCLI_VERBOSE) {
            console.error(`[chatgpt-agent] setFileInput ok selector=${selector} name=${file.name}`);
          }
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // 2) DataTransfer single file (small evaluate payload)
    if (!okOne) {
      if (process.env.OPENCLI_VERBOSE) {
        console.error(`[chatgpt-agent] upload-one DataTransfer name=${file.name} (${lastErr || 'no setFileInput'})`);
      }
      const item = {
        name: file.name,
        mime: mimeFromPath(file.nodePath),
        base64: fs.readFileSync(file.nodePath).toString('base64'),
      };
      if (item.base64.length > 8 * 1024 * 1024) {
        await dismissMenus(page);
        return {
          ok: false,
          reason: `file too large for DataTransfer fallback: ${file.name} (${(item.base64.length / 1024 / 1024).toFixed(1)} MB b64). setFileInput failed: ${lastErr}`,
          files: done,
        };
      }
      const isImage = String(item.mime).startsWith('image/');
      const fallback = await page.evaluate(`(() => {
        const item = ${JSON.stringify(item)};
        const isImage = ${isImage ? 'true' : 'false'};
        const input = (isImage && document.querySelector('#upload-photos, input[type="file"][accept*="image"]'))
          || document.querySelector('#upload-files')
          || document.querySelector('form input[type="file"]')
          || document.querySelector('input[type="file"]');
        if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'file input not found' };
        const binary = atob(item.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const dt = new DataTransfer();
        // Keep already-selected files if browser exposes them (usually empty for security).
        try {
          if (input.files && input.files.length) {
            for (const f of Array.from(input.files)) dt.items.add(f);
          }
        } catch (_) {}
        dt.items.add(new File([bytes], item.name, { type: item.mime }));
        input.files = dt.files;
        const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
        if (propsKey && input[propsKey] && typeof input[propsKey].onChange === 'function') {
          const nativeEvent = new Event('change', { bubbles: true });
          input[propsKey].onChange({
            target: input,
            currentTarget: input,
            nativeEvent,
            preventDefault() {},
            stopPropagation() {},
            isDefaultPrevented() { return false; },
            isPropagationStopped() { return false; },
            persist() {},
          });
        } else {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, mode: 'datatransfer-one', inputId: input.id || '', count: dt.files.length };
      })()`).catch((err) => ({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (process.env.OPENCLI_VERBOSE) {
        console.error(`[chatgpt-agent] upload-one-fallback=${JSON.stringify(fallback)}`);
      }
      if (!fallback?.ok) {
        await dismissMenus(page);
        return {
          ok: false,
          reason: fallback?.reason || lastErr || `upload failed: ${file.name}`,
          files: done,
        };
      }
      okOne = true;
    }

    const ready = await waitForAttachmentPreview(page, expectNames, {
      // After Nth image, accept N previews/remove chips even if basename hidden.
      minCount: expectNames.length,
    });
    await dismissMenus(page);
    if (!ready) {
      return {
        ok: false,
        reason: `upload preview did not appear after ${file.name}`,
        files: done,
      };
    }
    done.push(file.name);
    // Brief gap between attachments (human-like).
    if (i + 1 < preparedFiles.length) await page.sleep(0.4);
  }

  await dismissMenus(page);
  return { ok: true, files: done, mode: 'sequential' };
}

async function ensureFileInputsMounted(page) {
  let probe = await page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')].map((el, i) => ({
      i, id: el.id || '', accept: el.accept || '', multiple: !!el.multiple,
    }));
    return { count: inputs.length, inputs };
  })()`).catch(() => ({ count: 0, inputs: [] }));

  if (!probe?.count) {
    await page.evaluate(`(() => {
      const plus = document.querySelector(
        '#composer-plus-btn, button[data-testid="composer-plus-btn"], button[aria-label="Add files and more"]',
      );
      if (plus) plus.click();
      return !!plus;
    })()`).catch(() => null);
    await page.sleep(0.35);
    await dismissMenus(page);
    probe = await page.evaluate(`(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')].map((el, i) => ({
        i, id: el.id || '', accept: el.accept || '', multiple: !!el.multiple,
      }));
      return { count: inputs.length, inputs };
    })()`).catch(() => ({ count: 0, inputs: [] }));
  }
  if (process.env.OPENCLI_VERBOSE) {
    console.error(`[chatgpt-agent] upload-probe=${JSON.stringify(probe)}`);
  }
  if (!probe?.count) {
    throw new Error('no input[type=file] in DOM');
  }
  return probe;
}

/** Filenames in composer, or visible image thumbnails (official-style). */
async function waitForAttachmentPreview(page, basenames, opts = {}) {
  const minCount = opts.minCount || basenames.length;
  for (let i = 0; i < 24; i += 1) {
    await page.sleep(0.5);
    const ok = await page.evaluate(`(() => {
      const names = ${JSON.stringify(basenames)};
      const minCount = ${minCount};
      const body = (document.body && (document.body.innerText || document.body.textContent)) || '';
      if (names.every((n) => body.includes(n))) return true;
      const form = document.querySelector('form');
      if (form) {
        const text = form.innerText || form.textContent || '';
        if (names.every((n) => text.includes(n))) return true;
      }
      // Image upload previews near composer (official waitForChatGPTUploadPreview)
      const composer = document.querySelector(
        '[aria-label="Chat with ChatGPT"], [placeholder="Ask anything"], #prompt-textarea, [data-testid="prompt-textarea"]',
      );
      let root = composer;
      for (let i = 0; i < 6 && root && root.parentElement; i += 1) root = root.parentElement;
      const scope = root || document.body;
      if (!scope) return false;
      const isVisibleMedia = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = node.getBoundingClientRect();
        const width = node.naturalWidth || node.videoWidth || rect.width || 0;
        const height = node.naturalHeight || node.videoHeight || rect.height || 0;
        return width > 24 && height > 24;
      };
      const previews = Array.from(scope.querySelectorAll('img[src], canvas, video')).filter(isVisibleMedia);
      const removeBtns = Array.from(scope.querySelectorAll('button')).filter((b) => {
        if (!(b instanceof HTMLElement)) return false;
        const a = (b.getAttribute('aria-label') || '') + (b.innerText || '');
        return /remove|删除|dismiss|close file|移除/i.test(a);
      });
      return previews.length >= minCount || removeBtns.length >= minCount;
    })()`).catch(() => false);
    if (ok) return true;
  }
  return false;
}

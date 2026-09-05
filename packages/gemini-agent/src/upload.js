/**
 * Gemini attachment upload via page.setFileInput.
 *
 * File inputs are often unmounted until the composer + control is opened.
 * Open that control by structure (`simplified-input-menu button`, uploader
 * test ids), never by localized labels.
 */

import fs from 'node:fs';
import path from 'node:path';
import { unwrapEvaluateResult } from './eval.js';

export function isWslEnv() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const v = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(v);
  } catch {
    return false;
  }
}

export function needsWindowsUploadStaging() {
  const force = String(process.env.OPENCLI_UPLOAD_STAGE || '').trim();
  if (force === '0' || force.toLowerCase() === 'false') return false;
  if (force === '1' || force.toLowerCase() === 'true') return fs.existsSync('/mnt/c/Users');
  return isWslEnv() && fs.existsSync('/mnt/c/Users');
}

export function toBrowserLocalPath(absPath) {
  const p = path.resolve(absPath);
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

export function stageForBrowserUpload(nodePath) {
  const resolved = path.resolve(nodePath);
  const name = path.basename(resolved);
  if (!needsWindowsUploadStaging()) {
    return {
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved),
      name,
      staged: false,
    };
  }
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
    const staged = stageForBrowserUpload(nodePath);
    files.push({
      nodePath: staged.nodePath,
      sourcePath: nodePath,
      browserPath: staged.browserPath,
      name: staged.name,
    });
  }
  return { ok: true, files };
}

function isSelectorNotFound(message) {
  return typeof message === 'string' && message.startsWith('No element found matching selector:');
}

async function probeFileInputs(page) {
  const raw = await page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')].map((el, i) => ({
      i,
      id: el.id || '',
      accept: el.accept || '',
      multiple: !!el.multiple,
    }));
    return { count: inputs.length, inputs };
  })()`).catch(() => ({ count: 0, inputs: [] }));
  return unwrapEvaluateResult(raw) || { count: 0, inputs: [] };
}

async function openUploadSurface(page) {
  await page.evaluate(`(() => {
    const byTestId = document.querySelector(
      '[data-test-id="local-images-files-uploader-button"], [data-testid="local-images-files-uploader-button"]',
    );
    if (byTestId instanceof HTMLElement) {
      byTestId.click();
      return 'testid';
    }
    const menu = document.querySelector('simplified-input-menu button, input-area-v2 simplified-input-menu button');
    if (menu instanceof HTMLElement) {
      menu.click();
      return 'plus';
    }
    return null;
  })()`).catch(() => null);
}

async function clickUploaderMenuItem(page) {
  await page.evaluate(`(() => {
    const byTestId = document.querySelector(
      '[data-test-id="local-images-files-uploader-button"], [data-testid="local-images-files-uploader-button"]',
    );
    if (byTestId instanceof HTMLElement) {
      byTestId.click();
      return true;
    }
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"]')].filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (items[0] instanceof HTMLElement) {
      items[0].click();
      return true;
    }
    return false;
  })()`).catch(() => false);
}

async function dismissMenus(page) {
  await page.evaluate(`(() => {
    for (const target of [document.activeElement, document.body, document].filter(Boolean)) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }
  })()`).catch(() => null);
  if (typeof page.sleep === 'function') await page.sleep(0.2);
}

async function waitForAttachmentPreview(page, names, { minCount = 1, timeoutMs = 12000 } = {}) {
  const aliases = names.flatMap((name) => {
    const full = String(name || '').trim();
    const stem = full.replace(/\.[^.]+$/, '');
    return [full, stem].filter(Boolean);
  });
  const start = Date.now();
  let healthyPolls = 0;
  while (Date.now() - start < timeoutMs) {
    const raw = await page.evaluate(`(() => {
      const names = ${JSON.stringify(aliases)};
      const root = document.querySelector('input-area-v2, input-container, chat-window') || document.body;
      const text = (root.innerText || root.textContent || '');
      const named = names.filter((name) => name && text.includes(name));
      const previews = [...root.querySelectorAll('uploader-file-preview')];
      const errorCount = previews.filter((preview) => (
        preview.querySelector('.gem-attachment-loading-error, [fonticonname="error"]')
      )).length;
      const loadingCount = previews.filter((preview) => (
        preview.querySelector('mat-progress-spinner, .gem-attachment-loading')
      )).length;
      return { named: named.length, count: previews.length, errorCount, loadingCount };
    })()`).catch(() => ({ named: 0, count: 0, errorCount: 0, loadingCount: 0 }));
    const result = unwrapEvaluateResult(raw) || {
      named: 0,
      count: 0,
      errorCount: 0,
      loadingCount: 0,
    };
    if (result.errorCount > 0) {
      return { ready: false, reason: 'attachment preview entered an upload-error state', ...result };
    }
    healthyPolls = result.count >= minCount ? healthyPolls + 1 : 0;
    if (healthyPolls >= 2) return { ready: true, ...result };
    if (typeof page.sleep === 'function') await page.sleep(0.35);
    else if (typeof page.wait === 'function') await page.wait(0.35);
  }
  return { ready: false, reason: 'attachment preview did not become ready before timeout' };
}

async function ensureFileInputsMounted(page) {
  let probe = await probeFileInputs(page);
  if (probe.count > 0) return probe;
  await openUploadSurface(page);
  if (typeof page.sleep === 'function') await page.sleep(0.4);
  probe = await probeFileInputs(page);
  if (probe.count > 0) return probe;
  await clickUploaderMenuItem(page);
  if (typeof page.sleep === 'function') await page.sleep(0.4);
  return probeFileInputs(page);
}

const FILE_INPUT_SELECTORS = [
  'images-files-uploader input[type="file"]',
  'input[type="file"][accept*="image"]',
  'input[type="file"]',
];

export async function uploadComposerFiles(page, preparedFiles) {
  if (!preparedFiles?.length) return { ok: true, files: [] };
  if (typeof page.setFileInput !== 'function') {
    return {
      ok: false,
      reason: 'page.setFileInput is not available on the active browser backend',
      files: [],
    };
  }

  await ensureFileInputsMounted(page);

  const done = [];
  for (let i = 0; i < preparedFiles.length; i += 1) {
    const file = preparedFiles[i];
    const expectNames = [...done, file.name];
    if (process.env.OPENCLI_VERBOSE) {
      console.error(`[gemini-agent] upload-one ${i + 1}/${preparedFiles.length} name=${file.name}`);
    }

    const selectorMisses = [];
    let okOne = false;
    for (const selector of FILE_INPUT_SELECTORS) {
      try {
        await page.setFileInput([file.browserPath], selector);
        okOne = true;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isSelectorNotFound(message)) {
          selectorMisses.push({ selector, message });
          continue;
        }
        await dismissMenus(page);
        return {
          ok: false,
          reason: `setFileInput failed for filename=${file.name} selector=${selector}: ${message}`,
          files: done,
        };
      }
    }

    if (!okOne) {
      await openUploadSurface(page);
      if (typeof page.sleep === 'function') await page.sleep(0.35);
      await clickUploaderMenuItem(page);
      if (typeof page.sleep === 'function') await page.sleep(0.35);
      for (const selector of FILE_INPUT_SELECTORS) {
        try {
          await page.setFileInput([file.browserPath], selector);
          okOne = true;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isSelectorNotFound(message)) {
            selectorMisses.push({ selector, message });
            continue;
          }
          await dismissMenus(page);
          return {
            ok: false,
            reason: `setFileInput failed for filename=${file.name} selector=${selector}: ${message}`,
            files: done,
          };
        }
      }
    }

    if (!okOne) {
      const tried = selectorMisses.map((m) => m.selector).join(', ');
      await dismissMenus(page);
      return {
        ok: false,
        reason: `setFileInput could not find a file input for filename=${file.name} (tried: ${tried})`,
        files: done,
      };
    }

    const preview = await waitForAttachmentPreview(page, expectNames, { minCount: expectNames.length });
    await dismissMenus(page);
    if (!preview.ready) {
      return {
        ok: false,
        reason: `${preview.reason || 'upload preview did not appear'} after ${file.name}`,
        files: done,
      };
    }
    done.push(file.name);
    if (i + 1 < preparedFiles.length && typeof page.sleep === 'function') await page.sleep(0.4);
  }

  await dismissMenus(page);
  return { ok: true, files: done, mode: 'sequential' };
}

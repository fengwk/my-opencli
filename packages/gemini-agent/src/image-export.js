/**
 * Export Gemini-generated images.
 *
 * Prefer Gemini's own generated-image download control and Browser Bridge's
 * download lifecycle. Cross-origin URL/canvas export remains a compatibility
 * fallback. Skip sparkle/avatar chrome by class, not labels.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { unwrapEvaluateResult } from './eval.js';
import {
  isLikelyGeneratedImageUrl,
  normalizeGeneratedImageUrl,
} from './protocol.js';

const GENERATED_IMAGE_DOWNLOAD_SELECTOR =
  '[data-test-id="download-generated-image-button"] button';

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.jpg';
}

export function resolveImageOutputDir(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (shouldPreferWindowsPictures()) {
      const winPics = guessWindowsPicturesDir();
      if (winPics) {
        const dir = path.join(winPics, 'gemini-agent');
        try {
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        } catch { /* fall through */ }
      }
    }
    return path.join(os.homedir(), 'Pictures', 'gemini-agent');
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

function nextAvailablePath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}${ext}`);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${baseName}_${index}${ext}`);
  }
  return candidate;
}

const SNAPSHOT_SCRIPT = `(() => {
  const skipClass = /sparkle-image|mavatar-image|user-icon/;
  const imgs = Array.from(document.querySelectorAll('main img, img.image'));
  const urls = [];
  const seen = new Set();
  for (const img of imgs) {
    if (!(img instanceof HTMLImageElement)) continue;
    const className = String(img.className || '');
    if (skipClass.test(className)) continue;
    const style = window.getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const src = img.currentSrc || img.src || '';
    if (!src) continue;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (className.includes('image') && (className.includes('loaded') || className.includes('animate'))) {
      if (!seen.has(src)) { seen.add(src); urls.push(src); }
      continue;
    }
    if (!img.complete || !img.naturalWidth) continue;
    if (w < 128 && h < 128) continue;
    if (!seen.has(src)) { seen.add(src); urls.push(src); }
  }
  return urls;
})()`;

export async function snapshotVisibleImageUrls(page) {
  try {
    const raw = await page.evaluate(SNAPSHOT_SCRIPT);
    const urls = unwrapEvaluateResult(raw);
    return Array.isArray(urls) ? urls.filter((u) => typeof u === 'string' && u) : [];
  } catch {
    return [];
  }
}

function buildExportScript(urls) {
  return `(async (targetUrls) => {
    const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read blob'));
      reader.readAsDataURL(blob);
    });
    const inferMime = (value, fallbackUrl) => {
      if (value) return value;
      const lower = String(fallbackUrl || '').toLowerCase();
      if (lower.includes('.png') || lower.includes('png')) return 'image/png';
      if (lower.includes('.webp')) return 'image/webp';
      if (lower.includes('.gif')) return 'image/gif';
      return 'image/jpeg';
    };
    const images = Array.from(document.querySelectorAll('main img, img.image'));
    const results = [];
    for (const targetUrl of targetUrls) {
      const img = images.find((node) => (node.currentSrc || node.src || '') === targetUrl);
      let dataUrl = '';
      let mimeType = 'image/jpeg';
      const width = img?.naturalWidth || img?.width || 0;
      const height = img?.naturalHeight || img?.height || 0;
      try {
        if (String(targetUrl).startsWith('data:')) {
          dataUrl = String(targetUrl);
          mimeType = (String(targetUrl).match(/^data:([^;]+);/i) || [])[1] || 'image/png';
        } else {
          const res = await fetch(String(targetUrl), { credentials: 'include' });
          if (res.ok) {
            const blob = await res.blob();
            mimeType = inferMime(blob.type, targetUrl);
            dataUrl = await blobToDataUrl(blob);
          }
        }
      } catch {}
      if (!dataUrl && img instanceof HTMLImageElement && img.complete && img.naturalWidth) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            dataUrl = canvas.toDataURL('image/png');
            mimeType = 'image/png';
          }
        } catch {}
      }
      if (/^data:[^;,]+;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) && String(mimeType).startsWith('image/')) {
        results.push({ url: String(targetUrl), dataUrl, mimeType, width, height });
      }
    }
    return results;
  })(${JSON.stringify(urls)})`;
}

export async function exportImageAssets(page, urls) {
  const list = (urls || []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  const raw = await page.evaluate(buildExportScript(list));
  const assets = unwrapEvaluateResult(raw);
  if (!Array.isArray(assets)) return [];
  return assets.filter((asset) => (
    asset
    && typeof asset.url === 'string'
    && typeof asset.dataUrl === 'string'
    && /^data:[^;,]+;base64,[A-Za-z0-9+/]+=*$/.test(asset.dataUrl)
    && typeof asset.mimeType === 'string'
    && asset.mimeType.startsWith('image/')
  ));
}

function buildDownloadTargetsScript(beforeUrls) {
  return `((beforeList) => {
    const before = new Set((beforeList || []).map((url) => String(url || '').trim()).filter(Boolean));
    const buttons = Array.from(document.querySelectorAll(${JSON.stringify(GENERATED_IMAGE_DOWNLOAD_SELECTOR)}));
    const targets = [];
    for (let nth = 0; nth < buttons.length; nth += 1) {
      const button = buttons[nth];
      if (!(button instanceof HTMLElement)) continue;
      const root = button.closest('single-image, generated-image');
      const img = root?.querySelector('img.image.loaded, img.image.animate.loaded, img.image');
      if (!(img instanceof HTMLImageElement)) continue;
      const src = String(img.currentSrc || img.src || '').trim();
      if (!src || before.has(src) || !img.complete || !img.naturalWidth) continue;
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0'
        || rect.width <= 0
        || rect.height <= 0
      ) continue;
      targets.push({
        nth,
        url: src,
        width: Number(img.naturalWidth) || 0,
        height: Number(img.naturalHeight) || 0,
      });
    }
    return { targets, buttonCount: buttons.length };
  })(${JSON.stringify(beforeUrls || [])})`;
}

export async function downloadTurnImagesViaDom(page, opts = {}) {
  if (typeof page.click !== 'function' || typeof page.waitForDownload !== 'function') return [];
  const beforeUrls = (opts.beforeUrls || []).map((url) => String(url || '').trim()).filter(Boolean);
  const pollIterations = Math.max(1, Number(opts.pollIterations) || 12);
  const downloadTimeoutMs = Math.max(1000, Number(opts.downloadTimeoutMs) || 45_000);
  let targets = [];

  for (let attempt = 0; attempt < pollIterations; attempt += 1) {
    const raw = await page.evaluate(buildDownloadTargetsScript(beforeUrls)).catch(() => null);
    const data = unwrapEvaluateResult(raw);
    targets = Array.isArray(data?.targets) ? data.targets : [];
    if (targets.length > 0) break;
    if (typeof page.sleep === 'function') await page.sleep(1);
  }
  if (!targets.length) return [];

  const perDownloadTimeoutMs = Math.max(
    1000,
    Math.floor(downloadTimeoutMs / Math.max(1, targets.length)),
  );
  const results = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const entry = {
      kind: 'image-export',
      index,
      clicked: false,
      downloaded: false,
      path: '',
      url: target.url || '',
      mimeType: '',
      width: Number(target.width) || 0,
      height: Number(target.height) || 0,
    };
    let waitPromise = null;
    try {
      waitPromise = page.waitForDownload('', perDownloadTimeoutMs).catch((err) => ({
        downloaded: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      await page.click(GENERATED_IMAGE_DOWNLOAD_SELECTOR, { nth: Number(target.nth) || 0 });
      entry.clicked = true;
      const waitResult = await waitPromise;
      entry.downloaded = !!waitResult?.downloaded;
      entry.path = waitResult?.filename || waitResult?.path || '';
      entry.mimeType = waitResult?.mime || '';
      entry.bytes = Number(waitResult?.totalBytes) || 0;
      entry.state = waitResult?.state || '';
      if (!entry.downloaded) entry.error = waitResult?.error || 'download-not-completed';
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      if (waitPromise) await waitPromise;
    }
    results.push(entry);
    if (typeof page.sleep === 'function') await page.sleep(0.5);
  }
  return results;
}

export async function exportTurnImages(page, opts = {}) {
  const beforeSet = new Set((opts.beforeUrls || []).map((url) => String(url || '').trim()).filter(Boolean));
  const protocolUrls = (opts.protocolUrls || [])
    .map((url) => normalizeGeneratedImageUrl(url))
    .filter((url) => (
      isLikelyGeneratedImageUrl(url)
      || /^blob:/i.test(url)
      || /^https?:\/\//i.test(url)
    ));
  const outputDir = resolveImageOutputDir(opts.outputDir);
  const settleMs = opts.settleMs ?? 1200;
  fs.mkdirSync(outputDir, { recursive: true });

  if (typeof page.sleep === 'function') await page.sleep(settleMs / 1000);

  const domDownloads = await downloadTurnImagesViaDom(page, {
    beforeUrls: [...beforeSet],
    downloadTimeoutMs: opts.downloadTimeoutMs,
    pollIterations: opts.pollIterations,
  });
  if (domDownloads.some((entry) => entry?.downloaded)) return domDownloads;

  let visible = [];
  for (let i = 0; i < 8; i += 1) {
    visible = (await snapshotVisibleImageUrls(page)).filter((u) => u && !beforeSet.has(u));
    if (visible.length) break;
    if (typeof page.sleep === 'function') await page.sleep(1);
  }

  const urls = [];
  const seen = new Set();
  for (const url of [...protocolUrls, ...visible]) {
    if (!url || seen.has(url) || beforeSet.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (!urls.length) return domDownloads;

  const assets = await exportImageAssets(page, urls);
  if (!assets.length) return domDownloads;

  const stamp = Date.now();
  const results = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const base64 = String(asset.dataUrl || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) continue;
    const suffix = assets.length > 1 ? `_${index + 1}` : '';
    const filePath = nextAvailablePath(outputDir, `gemini-agent_${stamp}${suffix}`, extFromMime(asset.mimeType));
    await saveBase64ToFile(base64, filePath);
    results.push({
      kind: 'image-export',
      index,
      downloaded: true,
      path: filePath,
      url: asset.url || '',
      mimeType: asset.mimeType || '',
      width: asset.width || 0,
      height: asset.height || 0,
    });
  }
  return results;
}

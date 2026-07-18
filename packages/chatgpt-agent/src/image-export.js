/**
 * Export generated ChatGPT images the same way as official clis/chatgpt image:
 *   visible DOM img URLs → page fetch/canvas → base64 → local files.
 * No backend-api poll, no chrome Download button.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import {
  getChatGPTImageAssets,
  getChatGPTVisibleImageUrls,
} from './host-chatgpt.js';

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
    // WSL + Windows Chrome only: write under Windows Pictures for Explorer visibility
    // and re-upload via setFileInput. Native Linux defaults to ~/Pictures/chatgpt-agent.
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

function nextAvailablePath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}${ext}`);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${baseName}_${index}${ext}`);
  }
  return candidate;
}

/**
 * Snapshot visible image URLs (call before send).
 * @param {object} page
 * @returns {Promise<string[]>}
 */
export async function snapshotVisibleImageUrls(page) {
  try {
    return await getChatGPTVisibleImageUrls(page);
  } catch {
    return [];
  }
}

/**
 * After protocol reports image pointers: export NEW visible images vs beforeUrls.
 *
 * @param {object} page
 * @param {{
 *   beforeUrls?: string[],
 *   expectedCount?: number,
 *   outputDir?: string,
 *   settleMs?: number,
 * }} opts
 */
export async function exportNewImagesLikeOfficial(page, opts = {}) {
  const beforeSet = new Set(opts.beforeUrls || []);
  const expectedCount = Math.max(1, opts.expectedCount || 1);
  const outputDir = resolveImageOutputDir(opts.outputDir);
  const settleMs = opts.settleMs ?? 1500;

  fs.mkdirSync(outputDir, { recursive: true });
  await page.sleep(settleMs / 1000);

  // Poll briefly for rendered <img> after protocol already saw sediment pointers.
  let urls = [];
  for (let i = 0; i < 12; i += 1) {
    const all = await snapshotVisibleImageUrls(page);
    urls = all.filter((u) => u && !beforeSet.has(u));
    if (urls.length >= expectedCount) break;
    if (urls.length > 0 && i >= 3) break; // at least one new image stable enough
    await page.sleep(1);
  }

  if (!urls.length) {
    return [{
      kind: 'image-export',
      downloaded: false,
      error: 'no-new-visible-image-urls',
      expectedCount,
    }];
  }

  // Prefer exporting ALL new visible images (multi-gen may outpace protocol count
  // if we settled early). Soft-cap only when clearly more than expected+2 noise.
  if (expectedCount > 0 && urls.length > expectedCount + 2) {
    urls = urls.slice(-Math.max(expectedCount, 3));
  }

  if (process.env.OPENCLI_VERBOSE) {
    console.error(
      `[chatgpt-agent] image-export newUrls=${urls.length} expected=${expectedCount}`,
    );
  }

  const assets = await getChatGPTImageAssets(page, urls);
  if (!assets?.length) {
    return [{
      kind: 'image-export',
      downloaded: false,
      error: 'image-asset-export-failed',
      urls,
    }];
  }

  const stamp = Date.now();
  const results = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const base64 = String(asset.dataUrl || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) {
      results.push({
        kind: 'image-export',
        index,
        downloaded: false,
        error: 'empty-data-url',
        url: asset.url || '',
      });
      continue;
    }
    const suffix = assets.length > 1 ? `_${index + 1}` : '';
    const ext = extFromMime(asset.mimeType);
    const filePath = nextAvailablePath(outputDir, `chatgpt-agent_${stamp}${suffix}`, ext);
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

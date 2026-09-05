/**
 * Export generated ChatGPT images the same way as official clis/chatgpt image:
 *   visible DOM img URLs → page fetch/canvas → base64 → local files.
 * No backend-api poll, no chrome Download button.
 *
 * Sparse transparent ChatGPT loading placeholders (e.g. a `data:image/png` canvas
 * mounted before the real asset finishes rendering) must never be persisted as a
 * successful download. When protocol image pointers exist but the first visual
 * attempt yields no valid asset, the dedicated automation page may be reloaded
 * once and the export pipeline re-run, gated by the caller's `canRetry` hook.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import {
  getChatGPTImageAssets,
  getChatGPTVisibleImageUrls,
  unwrapEvaluateResult,
} from './host-chatgpt.js';

const DEFAULT_POLL_ITERATIONS = 12;
const DEFAULT_POLL_STABLE_INDEX = 3;
const PLACEHOLDER_INSPECT_MAX_SIDE = 512;
const PLACEHOLDER_INSPECT_SAMPLE_GRID = 16;
const PLACEHOLDER_INSPECT_TIMEOUT_MS = 2000;
const PLACEHOLDER_MEAN_ALPHA_THRESHOLD = 8;
const PLACEHOLDER_NONTRANSPARENT_RATIO_THRESHOLD = 0.05;
const PLACEHOLDER_NONTRANSPARENT_ALPHA_FLOOR = 16;

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

// --- Sparse-placeholder detection (page-side canvas inspection) ------------------
//
// ChatGPT occasionally mounts a fully transparent 480x480 PNG canvas as a loading
// placeholder for the generated image. Refreshing the page in the browser reveals
// the genuine output; the placeholder is essentially alpha=0 with negligible RGB.
// Detection is done in the dedicated automation page: load the data URL into a
// temp Image, draw it into a bounded canvas (max side <= 512), and sample a
// 16x16 grid for mean alpha / non-transparent ratio. We fail open on any page /
// canvas / decode error so an unknown image is never silently dropped.

function buildPlaceholderInspectScript(dataUrl) {
  // The script is the only place page-context happens. It always resolves
  // with `{ inspected: bool, ... }` so the caller never has to handle a
  // thrown promise from page.evaluate.
  return `(async () => {
    const dataUrl = ${JSON.stringify(dataUrl)};
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;
        const cleanup = () => {
          img.onload = null;
          img.onerror = null;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };
        const settleResolve = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const settleReject = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        // Install handlers BEFORE assigning src. Data URLs often decode
        // synchronously, so a later onload assignment can miss the event.
        img.onload = settleResolve;
        img.onerror = () => settleReject(new Error('image-load-failed'));
        img.src = dataUrl;
        // Already complete (synchronous decode or cache hit): trust the
        // natural dimensions. Zero/NaN means the payload did not decode
        // into a real image — fail open instead of sampling a fake 1x1.
        if (img.complete) {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            settleReject(new Error('image-load-empty'));
          } else {
            settleResolve();
          }
          return;
        }
        timeoutId = setTimeout(
          () => settleReject(new Error('image-load-timeout')),
          ${PLACEHOLDER_INSPECT_TIMEOUT_MS},
        );
      });
      // Re-verify natural dimensions post-load; some browsers report
      // complete=true with zero dimensions before the pixels arrive.
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return { inspected: false, reason: 'image-load-empty' };
      }
      const maxSide = ${PLACEHOLDER_INSPECT_MAX_SIDE};
      const scale = Math.min(1, maxSide / Math.max(w, h));
      const cw = Math.max(1, Math.floor(w * scale));
      const ch = Math.max(1, Math.floor(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { inspected: false, reason: 'canvas-context-unavailable' };
      ctx.drawImage(img, 0, 0, cw, ch);

      const xCount = Math.min(cw, ${PLACEHOLDER_INSPECT_SAMPLE_GRID});
      const yCount = Math.min(ch, ${PLACEHOLDER_INSPECT_SAMPLE_GRID});
      const samples = xCount * yCount;
      let nonTransparent = 0;
      let totalAlpha = 0;
      for (let yi = 0; yi < yCount; yi += 1) {
        const y = Math.min(ch - 1, Math.floor((yi + 0.5) * ch / yCount));
        for (let xi = 0; xi < xCount; xi += 1) {
          const x = Math.min(cw - 1, Math.floor((xi + 0.5) * cw / xCount));
          const data = ctx.getImageData(x, y, 1, 1).data;
          const a = data[3];
          totalAlpha += a;
          if (a > ${PLACEHOLDER_NONTRANSPARENT_ALPHA_FLOOR}) nonTransparent += 1;
        }
      }
      return {
        inspected: true,
        width: cw,
        height: ch,
        meanAlpha: totalAlpha / samples,
        nonTransparentRatio: nonTransparent / samples,
        samples,
      };
    } catch (err) {
      return { inspected: false, reason: String((err && err.message) || err) };
    }
  })()`;
}

/**
 * Build a per-asset `inspectPlaceholder(dataUrl, mimeType)` closure bound to the
 * supplied page. The closure is fail-open: any page / canvas / decode error or
 * non-data-URL input yields `{ rejected: false }` so the asset is saved.
 *
 * @param {object} page  page object exposing `evaluate(script)`.
 * @returns {(dataUrl: string, mimeType?: string) => Promise<{ rejected: boolean, reason?: string, meanAlpha?: number, nonTransparentRatio?: number }>}
 */
export function makeInspectPlaceholder(page) {
  return async (dataUrl, _mimeType) => {
    if (typeof dataUrl !== 'string' || !/^data:image\/[a-z0-9.+-]+;/i.test(dataUrl)) {
      return { rejected: false, reason: 'not-data-url' };
    }
    let raw;
    try {
      raw = await page.evaluate(buildPlaceholderInspectScript(dataUrl));
    } catch (err) {
      return { rejected: false, reason: 'evaluation-error', error: err?.message || String(err) };
    }
    const result = unwrapEvaluateResult(raw);
    if (!result || !result.inspected) {
      return { rejected: false, reason: (result && result.reason) || 'inspection-failed' };
    }
    const meanAlpha = Number(result.meanAlpha);
    const nonTransparentRatio = Number(result.nonTransparentRatio);
    if (!Number.isFinite(meanAlpha) || !Number.isFinite(nonTransparentRatio)) {
      return { rejected: false, reason: 'invalid-stats' };
    }
    if (
      meanAlpha < PLACEHOLDER_MEAN_ALPHA_THRESHOLD
      && nonTransparentRatio < PLACEHOLDER_NONTRANSPARENT_RATIO_THRESHOLD
    ) {
      return {
        rejected: true,
        reason: 'sparse-alpha',
        meanAlpha,
        nonTransparentRatio,
      };
    }
    return { rejected: false, reason: 'looks-opaque-enough', meanAlpha, nonTransparentRatio };
  };
}

// --- Per-attempt pipeline (testable, no host-import side effects) -----------------

/**
 * Strict predicate evaluator for budget gates (canContinue / canRetry).
 * Fail-closed: returns true only when predicate is omitted or explicitly evaluates to true.
 * Returns false on undefined, falsy, non-boolean return values, or thrown exceptions.
 *
 * @param {(() => boolean) | null | undefined} predicate
 * @returns {boolean}
 */
export function isContinueAllowed(predicate) {
  if (predicate == null) return true;
  if (typeof predicate !== 'function') return false;
  try {
    return predicate() === true;
  } catch {
    return false;
  }
}

/**
 * Run the export pipeline once: settle → poll → fetch assets → save / reject.
 *
 * Errors from `fetchAssets` propagate to the caller (do not swallow them here).
 * The `inspectPlaceholder` dependency owns its own fail-open semantics.
 *
 * @param {{
 *   sleep: (seconds: number) => Promise<void>,
 *   snapshotUrls: () => Promise<string[]>,
 *   fetchAssets: (urls: string[]) => Promise<Array<{ url: string, dataUrl: string, mimeType: string, width: number, height: number }>>,
 *   saveBase64: (base64: string, filePath: string) => Promise<void>,
 *   inspectPlaceholder: (dataUrl: string, mimeType?: string) => Promise<{ rejected: boolean, reason?: string, meanAlpha?: number, nonTransparentRatio?: number }>,
 *   beforeSet: Set<string>,
 *   expectedCount: number,
 *   outputDir: string,
 *   settleMs: number,
 *   pollIterations?: number,
 *   pollStableIndex?: number,
 *   canContinue?: () => boolean,
 * }} deps
 * @returns {Promise<{ results: object[], hasValidDownload: boolean }>}
 */
export async function runImageExportAttempt(deps) {
  const {
    sleep,
    snapshotUrls,
    fetchAssets,
    saveBase64,
    inspectPlaceholder,
    beforeSet,
    expectedCount,
    outputDir,
    settleMs,
    pollIterations = DEFAULT_POLL_ITERATIONS,
    pollStableIndex = DEFAULT_POLL_STABLE_INDEX,
    canContinue,
  } = deps;

  await sleep(settleMs / 1000);

  let urls = [];
  for (let i = 0; i < pollIterations; i += 1) {
    if (!isContinueAllowed(canContinue)) break;
    let all = [];
    try {
      all = await snapshotUrls();
    } catch {
      all = [];
    }
    urls = (Array.isArray(all) ? all : []).filter((u) => u && !beforeSet.has(u));
    if (urls.length >= expectedCount) break;
    if (urls.length > 0 && i >= pollStableIndex) break;
    if (i < pollIterations - 1) {
      if (!isContinueAllowed(canContinue)) break;
      await sleep(1);
    }
  }

  if (!urls.length) {
    return {
      hasValidDownload: false,
      results: [{
        kind: 'image-export',
        downloaded: false,
        error: 'no-new-visible-image-urls',
        expectedCount,
      }],
    };
  }

  if (expectedCount > 0 && urls.length > expectedCount + 2) {
    urls = urls.slice(-Math.max(expectedCount, 3));
  }

  if (process.env.OPENCLI_VERBOSE) {
    console.error(
      `[chatgpt-agent] image-export newUrls=${urls.length} expected=${expectedCount}`,
    );
  }

  // No try/catch: let getChatGPTImageAssets errors propagate (preserve prior semantics).
  const assets = await fetchAssets(urls);
  if (!assets || !assets.length) {
    return {
      hasValidDownload: false,
      results: [{
        kind: 'image-export',
        downloaded: false,
        error: 'image-asset-export-failed',
        urls,
      }],
    };
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

    const placeholder = await inspectPlaceholder(asset.dataUrl, asset.mimeType);
    if (placeholder && placeholder.rejected) {
      results.push({
        kind: 'image-export',
        index,
        downloaded: false,
        error: 'sparse-placeholder-rejected',
        url: asset.url || '',
        mimeType: asset.mimeType || '',
        width: asset.width || 0,
        height: asset.height || 0,
        meanAlpha: placeholder.meanAlpha,
        nonTransparentRatio: placeholder.nonTransparentRatio,
        reason: placeholder.reason,
      });
      continue;
    }

    const suffix = assets.length > 1 ? `_${index + 1}` : '';
    const ext = extFromMime(asset.mimeType);
    const filePath = nextAvailablePath(outputDir, `chatgpt-agent_${stamp}${suffix}`, ext);
    await saveBase64(base64, filePath);
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

  return {
    hasValidDownload: results.some((r) => r && r.downloaded === true),
    results,
  };
}

/**
 * After protocol reports image pointers: export NEW visible images vs beforeUrls.
 *
 * Caller-owned retry policy: the caller passes a `reloadConversation` callback
 * (already validated as targeting a real conversation URL) and an optional
 * `canRetry` predicate. At most one reload happens when the first attempt
 * produced no valid download and `canRetry()` returns true. Reload failures
 * fall back to the first attempt's results.
 *
 * @param {object} page
 * @param {{
 *   beforeUrls?: string[],
 *   expectedCount?: number,
 *   outputDir?: string,
 *   settleMs?: number,
 *   pollIterations?: number,
 *   pollStableIndex?: number,
 *   canContinue?: () => boolean,
 *   reloadConversation?: () => Promise<void>,
 *   canRetry?: () => boolean,
 * }} opts
 */
export async function exportNewImagesLikeOfficial(page, opts = {}) {
  const beforeSet = new Set(opts.beforeUrls || []);
  const expectedCount = Math.max(1, opts.expectedCount || 1);
  const outputDir = resolveImageOutputDir(opts.outputDir);
  const settleMs = opts.settleMs ?? 1500;
  const pollIterations = opts.pollIterations ?? DEFAULT_POLL_ITERATIONS;
  const pollStableIndex = opts.pollStableIndex ?? DEFAULT_POLL_STABLE_INDEX;
  const canContinue = typeof opts.canContinue === 'function' ? opts.canContinue : null;
  const reloadConversation = typeof opts.reloadConversation === 'function'
    ? opts.reloadConversation
    : null;
  const canRetry = typeof opts.canRetry === 'function' ? opts.canRetry : null;

  fs.mkdirSync(outputDir, { recursive: true });

  const inspectPlaceholder = makeInspectPlaceholder(page);

  const baseDeps = {
    sleep: (seconds) => page.sleep(seconds),
    snapshotUrls: () => snapshotVisibleImageUrls(page),
    fetchAssets: (urls) => getChatGPTImageAssets(page, urls),
    saveBase64: (base64, filePath) => saveBase64ToFile(base64, filePath),
    inspectPlaceholder,
    beforeSet,
    expectedCount,
    outputDir,
    settleMs,
    pollIterations,
    pollStableIndex,
    canContinue,
  };

  const first = await runImageExportAttempt(baseDeps);

  const retryAllowed = !!reloadConversation && isContinueAllowed(canRetry);
  if (first.hasValidDownload || !retryAllowed) {
    return first.results;
  }

  if (process.env.OPENCLI_VERBOSE) {
    console.error(
      '[chatgpt-agent] image-export: no valid download, retrying after conversation reload',
    );
  }
  try {
    await reloadConversation();
  } catch (err) {
    if (process.env.OPENCLI_VERBOSE) {
      console.error(
        `[chatgpt-agent] image-export reload failed: ${err?.message || err}`,
      );
    }
    return first.results;
  }

  const second = await runImageExportAttempt(baseDeps);
  return second.results;
}

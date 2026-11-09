/**
 * Tests for chatgpt-agent's image-export pipeline.
 *
 * Behavior under test:
 *   1. A `data:image/...` candidate whose page-side canvas inspection reports
 *      `meanAlpha < 8` AND `nonTransparentRatio < 0.05` is rejected and the
 *      underlying `saveBase64ToFile` is never invoked.
 *   2. A valid data image (including fully opaque solid black) is saved.
 *   3. When page-side inspection itself fails (page.evaluate throws or returns
 *      an `inspected:false` envelope), the asset fails open and is saved.
 *   4. When the first attempt yields no valid download AND a `reloadConversation`
 *      + `canRetry` are supplied, the export pipeline runs once more and saves
 *      the subsequently available valid asset.
 *   5. No reload/retry is triggered when the first attempt already produced a
 *      valid downloaded asset.
 *   6. The `canRetry` gate prevents reload/retry when insufficient time remains.
 *
 * No live network or browser is required. The host imports are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const getChatGPTVisibleImageUrls = vi.fn();
const getChatGPTImageAssets = vi.fn();
const saveBase64ToFile = vi.fn(async () => undefined);
const unwrapEvaluateResult = vi.fn((payload) => {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
});

vi.mock('../src/host-chatgpt.js', () => ({
  getChatGPTVisibleImageUrls: (...args) => getChatGPTVisibleImageUrls(...args),
  getChatGPTImageAssets: (...args) => getChatGPTImageAssets(...args),
  unwrapEvaluateResult: (...args) => unwrapEvaluateResult(...args),
}));

vi.mock('@jackwener/opencli/utils', () => ({
  saveBase64ToFile: (...args) => saveBase64ToFile(...args),
}));

const {
  exportNewImagesLikeOfficial,
  isContinueAllowed,
  makeInspectPlaceholder,
  runImageExportAttempt,
  snapshotVisibleImageUrls,
} = await import('../src/image-export.js');

const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function tmpOutputDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cga-imgexp-'));
  temps.push(dir);
  return dir;
}

function makeFakePage() {
  return {
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(),
  };
}

const SPARSE_PLACEHOLDER_DATA_URL = 'data:image/png;base64,PLACEHOLDER_DATA';
const VALID_IMAGE_DATA_URL = 'data:image/png;base64,VALID_IMAGE_DATA';
const OPAQUE_BLACK_DATA_URL = 'data:image/png;base64,OPAQUE_BLACK_DATA';

function pageReturningInspection(envelope, { modern = false, modernUrls = [] } = {}) {
  return {
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async (script) => {
      if (typeof script === 'string' && script.includes('generated-image-gallery')) {
        return { modern, urls: modernUrls };
      }
      return envelope;
    }),
  };
}

function pageThrowingEvaluation(err = new Error('bridge disconnected')) {
  return {
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      throw err;
    }),
  };
}

const SPARSE_STATS = {
  inspected: true,
  width: 480,
  height: 480,
  meanAlpha: 2,
  nonTransparentRatio: 5 / 256,
  samples: 256,
};

const OPAQUE_STATS = {
  inspected: true,
  width: 480,
  height: 480,
  meanAlpha: 255,
  nonTransparentRatio: 1,
  samples: 256,
};

// --- Page-side inspector (fail-open semantics) -----------------------------------

describe('makeInspectPlaceholder', () => {
  // The HTTP/legacy source must not fall back to sending fetched image bytes.
  it('inspects an HTTP image by URL without sending its base64 back to the browser', async () => {
    const page = pageReturningInspection(OPAQUE_STATS);
    const hugeData = `data:image/png;base64,${'B'.repeat(2_000_000)}`;
    await makeInspectPlaceholder(page)(hugeData, 'image/png', 'https://chatgpt.com/image.png');
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('https://chatgpt.com/image.png');
    expect(script.length).toBeLessThan(10_000);
    expect(script).not.toContain(hugeData);
  });

  // Execute the generated lookup script: a digest finds the exact inline DOM
  // image while the request remains small even for multi-megabyte data URLs.
  it('resolves an inline image in the DOM by digest without retransmitting its contents', async () => {
    const hugeData = `data:image/png;base64,${'C'.repeat(2_000_000)}`;
    const canvasContext = {
      drawImage() {},
      getImageData: () => ({ data: [0, 0, 0, 255] }),
    };
    const page = {
      evaluate: vi.fn(async (script) => runInNewContext(script, {
        crypto: webcrypto,
        TextEncoder,
        Image: class {
          complete = true;
          naturalWidth = 1024;
          naturalHeight = 1536;
        },
        document: {
          querySelectorAll: () => [
            { src: 'data:image/png;base64,unrelated' }, { src: hugeData },
          ],
          createElement: () => ({ getContext: () => canvasContext }),
        },
        setTimeout,
        clearTimeout,
      })),
    };
    const result = await makeInspectPlaceholder(page)(hugeData, 'image/png', hugeData);
    const script = page.evaluate.mock.calls[0][0];
    expect(script.length).toBeLessThan(10_000);
    expect(script).not.toContain(hugeData);
    expect(result).toMatchObject({
      rejected: false, reason: 'looks-opaque-enough', originalWidth: 1024, originalHeight: 1536,
    });
  });

  // Real PNGs exceed the daemon's request limit: inspect the existing blob URL
  // rather than sending its multi-megabyte data URL back through page.evaluate.
  it('inspects the page-owned blob without re-uploading the image bytes', async () => {
    const page = pageReturningInspection({
      ...OPAQUE_STATS, originalWidth: 1024, originalHeight: 1536,
    });
    const inspect = makeInspectPlaceholder(page);
    const hugeData = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
    const result = await inspect(hugeData, 'image/png', 'blob:https://chatgpt.com/large');
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('blob:https://chatgpt.com/large');
    expect(script.length).toBeLessThan(10_000);
    expect(script).not.toContain(hugeData);
    expect(result).toMatchObject({ rejected: false, originalWidth: 1024, originalHeight: 1536 });
  });

  // A lazy rail's layout/natural sizes are not the size of its underlying PNG.
  it('returns original decoded dimensions separately from the inspection canvas', async () => {
    const inspect = makeInspectPlaceholder(pageReturningInspection({
      ...OPAQUE_STATS, originalWidth: 1024, originalHeight: 1536,
    }));
    expect(await inspect(VALID_IMAGE_DATA_URL, 'image/png')).toMatchObject({
      rejected: false, originalWidth: 1024, originalHeight: 1536,
    });
  });

  it('reports rejected=true for a sparse transparent inspection result', async () => {
    const page = pageReturningInspection(SPARSE_STATS);
    const inspect = makeInspectPlaceholder(page);
    const out = await inspect(SPARSE_PLACEHOLDER_DATA_URL, 'image/png');
    expect(out.rejected).toBe(true);
    expect(out.reason).toBe('sparse-alpha');
    expect(out.meanAlpha).toBe(2);
    expect(out.nonTransparentRatio).toBeCloseTo(5 / 256);
  });

  it('reports rejected=false for opaque black inspection result', async () => {
    const page = pageReturningInspection(OPAQUE_STATS);
    const inspect = makeInspectPlaceholder(page);
    const out = await inspect(OPAQUE_BLACK_DATA_URL, 'image/png');
    expect(out.rejected).toBe(false);
    expect(out.meanAlpha).toBe(255);
  });

  it('fails open when page.evaluate throws (e.g. bridge disconnected)', async () => {
    const page = pageThrowingEvaluation();
    const inspect = makeInspectPlaceholder(page);
    const out = await inspect(VALID_IMAGE_DATA_URL, 'image/png');
    expect(out.rejected).toBe(false);
    expect(out.reason).toBe('evaluation-error');
  });

  it('fails open when the page-side inspection reports inspected=false', async () => {
    const page = pageReturningInspection({ inspected: false, reason: 'image-load-failed' });
    const inspect = makeInspectPlaceholder(page);
    const out = await inspect(VALID_IMAGE_DATA_URL, 'image/png');
    expect(out.rejected).toBe(false);
    expect(out.reason).toBe('image-load-failed');
  });

  it('bypasses inspection for non-data URLs (fail open)', async () => {
    const page = pageReturningInspection(OPAQUE_STATS);
    const inspect = makeInspectPlaceholder(page);
    const out = await inspect('https://chatgpt.com/foo.png', 'image/png');
    expect(out.rejected).toBe(false);
    expect(out.reason).toBe('not-data-url');
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

// --- Per-attempt pipeline (snapshot → fetch → save / reject) ---------------------

describe('runImageExportAttempt', () => {
  const beforeSet = new Set(['https://chatgpt.com/old.png']);
  const outputDir = '/tmp/cga-imgexp-unused';

  // Sibling images may load after the fourth poll; do not accept a partial batch.
  it('waits for all expected images instead of stopping after one at poll 4', async () => {
    const urls = ['blob:one', 'blob:two', 'blob:three'];
    let polls = 0;
    const saveBase64 = vi.fn(async () => {});
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => (++polls < 6 ? urls.slice(0, 1) : urls),
      fetchAssets: async (found) => found.map((url) => ({
        url, dataUrl: VALID_IMAGE_DATA_URL, mimeType: 'image/png', width: 1024, height: 1536,
      })),
      saveBase64,
      inspectPlaceholder: async () => ({ rejected: false }),
      beforeSet,
      expectedCount: 3,
      outputDir,
      settleMs: 0,
      pollIterations: 8,
    });
    expect(polls).toBe(6);
    expect(result.results.filter((r) => r.downloaded)).toHaveLength(3);
    expect(new Set(saveBase64.mock.calls.map(([, file]) => file)).size).toBe(3);
  });

  // A permanently missing sibling still respects the caller's bounded wait.
  it('exhausts the polling budget when only one of three images loads', async () => {
    const snapshotUrls = vi.fn(async () => [VALID_IMAGE_DATA_URL]);
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls,
      fetchAssets: async () => [{
        url: VALID_IMAGE_DATA_URL, dataUrl: VALID_IMAGE_DATA_URL, mimeType: 'image/png',
      }],
      saveBase64: async () => {},
      inspectPlaceholder: async () => ({ rejected: false }),
      beforeSet,
      expectedCount: 3,
      outputDir,
      settleMs: 0,
      pollIterations: 6,
    });
    expect(snapshotUrls).toHaveBeenCalledTimes(6);
    expect(result.results.filter((r) => r.downloaded)).toHaveLength(1);
  });

  // Report the real asset size even when the DOM thumbnail is only 56px wide.
  it('uses decoded asset dimensions instead of side-rail layout dimensions', async () => {
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => ['blob:lazy'],
      fetchAssets: async () => [{
        url: 'blob:lazy', dataUrl: VALID_IMAGE_DATA_URL, mimeType: 'image/png', width: 56, height: 56,
      }],
      saveBase64: async () => {},
      inspectPlaceholder: async () => ({
        rejected: false, originalWidth: 1024, originalHeight: 1536,
      }),
      beforeSet,
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });
    expect(result.results[0]).toMatchObject({ downloaded: true, width: 1024, height: 1536 });
  });

  // Allowing lazy blob URLs must not admit an actual tiny thumbnail as an output.
  it('rejects lazy assets whose decoded dimensions are below the image minimum', async () => {
    const saveBase64 = vi.fn();
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => ['blob:tiny'],
      fetchAssets: async () => [{
        url: 'blob:tiny', dataUrl: VALID_IMAGE_DATA_URL, mimeType: 'image/png',
      }],
      saveBase64,
      inspectPlaceholder: async () => ({
        rejected: false, originalWidth: 56, originalHeight: 56,
      }),
      beforeSet,
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });
    expect(result.results[0]).toMatchObject({ downloaded: false, error: 'image-too-small' });
    expect(saveBase64).not.toHaveBeenCalled();
  });

  it('rejects a sparse placeholder and never calls saveBase64', async () => {
    const saveBase64 = vi.fn(async () => undefined);
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => [SPARSE_PLACEHOLDER_DATA_URL],
      fetchAssets: async () => [{
        url: SPARSE_PLACEHOLDER_DATA_URL,
        dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
        mimeType: 'image/png',
        width: 480,
        height: 480,
      }],
      saveBase64,
      inspectPlaceholder: async () => ({
        rejected: true,
        reason: 'sparse-alpha',
        meanAlpha: 2,
        nonTransparentRatio: 0.02,
      }),
      beforeSet,
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(result.hasValidDownload).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      downloaded: false,
      error: 'sparse-placeholder-rejected',
    });
    expect(result.results[0].meanAlpha).toBe(2);
    expect(saveBase64).not.toHaveBeenCalled();
  });

  it('saves an opaque black image and reports downloaded=true', async () => {
    const saveBase64 = vi.fn(async () => undefined);
    const result = await runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => [OPAQUE_BLACK_DATA_URL],
      fetchAssets: async () => [{
        url: OPAQUE_BLACK_DATA_URL,
        dataUrl: OPAQUE_BLACK_DATA_URL,
        mimeType: 'image/png',
        width: 480,
        height: 480,
      }],
      saveBase64,
      inspectPlaceholder: async () => ({ rejected: false }),
      beforeSet,
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(result.hasValidDownload).toBe(true);
    expect(result.results[0].downloaded).toBe(true);
    expect(saveBase64).toHaveBeenCalledTimes(1);
    const [base64Arg, filePathArg] = saveBase64.mock.calls[0];
    expect(typeof base64Arg).toBe('string');
    expect(base64Arg.length).toBeGreaterThan(0);
    expect(filePathArg.startsWith(outputDir + path.sep)).toBe(true);
    expect(filePathArg.endsWith('.png')).toBe(true);
  });

  it('propagates fetchAssets errors instead of swallowing them', async () => {
    await expect(runImageExportAttempt({
      sleep: async () => {},
      snapshotUrls: async () => [VALID_IMAGE_DATA_URL],
      fetchAssets: async () => {
        throw new Error('asset-export-failed');
      },
      saveBase64: vi.fn(),
      inspectPlaceholder: async () => ({ rejected: false }),
      beforeSet,
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    })).rejects.toThrow('asset-export-failed');
  });
});

// --- Top-level exportNewImagesLikeOfficial with controlled retry ------------------

describe('exportNewImagesLikeOfficial', () => {
  beforeEach(() => {
    getChatGPTVisibleImageUrls.mockReset();
    getChatGPTImageAssets.mockReset();
    saveBase64ToFile.mockReset();
    unwrapEvaluateResult.mockReset();
    unwrapEvaluateResult.mockImplementation((payload) => payload);
  });

  // Live three-image turns can lose one blob during fetch. A single reload
  // should complete the batch without duplicating the two already saved files.
  it('recovers a partial three-image fetch after reload and reuses saved files', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);
    const firstUrls = ['blob:first-a', 'blob:first-b', 'blob:first-c'];
    const nextUrls = ['blob:next-a', 'blob:next-b', 'blob:next-c'];
    const asset = (url, bytes) => ({
      url, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      mimeType: 'image/png', width: 1024, height: 1536,
    });
    getChatGPTVisibleImageUrls.mockResolvedValueOnce(firstUrls).mockResolvedValueOnce(nextUrls);
    getChatGPTImageAssets
      .mockResolvedValueOnce([asset(firstUrls[0], 'A'), asset(firstUrls[1], 'B')])
      .mockResolvedValueOnce(nextUrls.map((url, index) => asset(url, ['A', 'B', 'C'][index])));
    const reloadConversation = vi.fn(async () => {});
    const results = await exportNewImagesLikeOfficial(page, {
      expectedCount: 3, outputDir, settleMs: 0, pollIterations: 1,
      reloadConversation, canRetry: () => true,
    });
    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.downloaded)).toHaveLength(3);
    expect(results.map((r) => r.url)).toEqual(nextUrls);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(3); // Not 5: reuse the first two.
    expect(new Set(results.map((r) => r.path)).size).toBe(3);
  });

  // A failed recovery must not replace an earlier usable partial batch with zero.
  it('keeps partial downloads when the bounded reload cannot fetch any images', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);
    getChatGPTVisibleImageUrls
      .mockResolvedValueOnce(['blob:a', 'blob:b', 'blob:c'])
      .mockResolvedValueOnce([]);
    getChatGPTImageAssets.mockResolvedValueOnce([{
      url: 'blob:a', dataUrl: VALID_IMAGE_DATA_URL, mimeType: 'image/png', width: 1024, height: 1536,
    }]);
    const reloadConversation = vi.fn(async () => {});
    const results = await exportNewImagesLikeOfficial(page, {
      expectedCount: 3, outputDir, settleMs: 0, pollIterations: 1,
      reloadConversation, canRetry: () => true,
    });
    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.downloaded)).toHaveLength(1);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
  });

  // Retry can fetch only the previously missing sibling; keep the first subset.
  it('merges complementary partial downloads across the one reload', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);
    const first = ['blob:a', 'blob:b', 'blob:c'];
    const next = ['blob:next-a', 'blob:next-b', 'blob:next-c'];
    const asset = (url, text) => ({
      url, dataUrl: `data:image/png;base64,${Buffer.from(text).toString('base64')}`,
      mimeType: 'image/png', width: 1024, height: 1536,
    });
    getChatGPTVisibleImageUrls.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    getChatGPTImageAssets
      .mockResolvedValueOnce([asset(first[0], 'A'), asset(first[1], 'B')])
      .mockResolvedValueOnce([asset(next[2], 'C')]);
    const results = await exportNewImagesLikeOfficial(page, {
      expectedCount: 3, outputDir, settleMs: 0, pollIterations: 1,
      reloadConversation: async () => {}, canRetry: () => true,
    });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.downloaded)).toBe(true);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(3);
  });

  it('rejects an inspected sparse data placeholder and does not call saveBase64ToFile', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(SPARSE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([SPARSE_PLACEHOLDER_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: SPARSE_PLACEHOLDER_DATA_URL,
      dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      downloaded: false,
      error: 'sparse-placeholder-rejected',
      meanAlpha: 2,
    });
    expect(saveBase64ToFile).not.toHaveBeenCalled();
  });

  it('saves a valid opaque data image and reports downloaded=true', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([OPAQUE_BLACK_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: OPAQUE_BLACK_DATA_URL,
      dataUrl: OPAQUE_BLACK_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(results[0].downloaded).toBe(true);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
    const [, filePath] = saveBase64ToFile.mock.calls[0];
    expect(filePath.startsWith(outputDir + path.sep)).toBe(true);
    expect(filePath.endsWith('.png')).toBe(true);
  });

  it('fails open and still saves the asset when page-side evaluation throws', async () => {
    const outputDir = tmpOutputDir();
    const page = {
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        if (typeof script === 'string' && script.includes('generated-image-gallery')) {
          return { modern: false, urls: [] };
        }
        throw new Error('bridge disconnected during placeholder inspect');
      }),
    };
    getChatGPTVisibleImageUrls.mockResolvedValue([VALID_IMAGE_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: VALID_IMAGE_DATA_URL,
      dataUrl: VALID_IMAGE_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(results[0].downloaded).toBe(true);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
  });

  it('performs one controlled reload/retry that turns a sparse placeholder into a saved asset', async () => {
    const outputDir = tmpOutputDir();
    let inspectCount = 0;
    const page = {
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        if (typeof script === 'string' && script.includes('generated-image-gallery')) {
          return { modern: false, urls: [] };
        }
        inspectCount += 1;
        return inspectCount === 1 ? SPARSE_STATS : OPAQUE_STATS;
      }),
    };

    getChatGPTVisibleImageUrls
      .mockResolvedValueOnce([SPARSE_PLACEHOLDER_DATA_URL])
      .mockResolvedValueOnce([OPAQUE_BLACK_DATA_URL]);
    getChatGPTImageAssets
      .mockResolvedValueOnce([{
        url: SPARSE_PLACEHOLDER_DATA_URL,
        dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
        mimeType: 'image/png',
        width: 480,
        height: 480,
      }])
      .mockResolvedValueOnce([{
        url: OPAQUE_BLACK_DATA_URL,
        dataUrl: OPAQUE_BLACK_DATA_URL,
        mimeType: 'image/png',
        width: 480,
        height: 480,
      }]);

    const reloadConversation = vi.fn(async () => {});

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      reloadConversation,
      canRetry: () => true,
    });

    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(4); // 2 DOM queries + 2 placeholder inspections
    expect(getChatGPTVisibleImageUrls).toHaveBeenCalledTimes(2);
    expect(getChatGPTImageAssets).toHaveBeenCalledTimes(2);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
    expect(results[0].downloaded).toBe(true);
    expect(results[0].url).toBe(OPAQUE_BLACK_DATA_URL);
  });

  it('performs no reload when the first attempt already produced a valid download', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([OPAQUE_BLACK_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: OPAQUE_BLACK_DATA_URL,
      dataUrl: OPAQUE_BLACK_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const reloadConversation = vi.fn(async () => {});

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      reloadConversation,
      canRetry: () => true,
    });

    expect(results[0].downloaded).toBe(true);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
    expect(reloadConversation).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalledTimes(2); // 1 DOM query + 1 placeholder inspect
    expect(getChatGPTVisibleImageUrls).toHaveBeenCalledTimes(1);
    expect(getChatGPTImageAssets).toHaveBeenCalledTimes(1);
  });

  it('does not reload when canRetry returns false (insufficient remaining time)', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(SPARSE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([SPARSE_PLACEHOLDER_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: SPARSE_PLACEHOLDER_DATA_URL,
      dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const reloadConversation = vi.fn(async () => {});

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      reloadConversation,
      canRetry: () => false, // gate: ask.js wires `remainingMs() >= 25_000`
    });

    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('sparse-placeholder-rejected');
    expect(reloadConversation).not.toHaveBeenCalled();
    expect(saveBase64ToFile).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalledTimes(2); // 1 DOM query + 1 placeholder inspect
  });

  it('treats a throwing canRetry callback as disallowed (no reload, gate error swallowed)', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(SPARSE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([SPARSE_PLACEHOLDER_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: SPARSE_PLACEHOLDER_DATA_URL,
      dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const reloadConversation = vi.fn(async () => {});
    const canRetry = vi.fn(() => {
      throw new Error('gate blew up');
    });

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      reloadConversation,
      canRetry,
    });

    expect(canRetry).toHaveBeenCalledTimes(1);
    expect(reloadConversation).not.toHaveBeenCalled();
    expect(saveBase64ToFile).not.toHaveBeenCalled();
    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('sparse-placeholder-rejected');
  });

  it('does not reload when reloadConversation is missing', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(SPARSE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([SPARSE_PLACEHOLDER_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: SPARSE_PLACEHOLDER_DATA_URL,
      dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      canRetry: () => true,
    });

    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('sparse-placeholder-rejected');
    expect(saveBase64ToFile).not.toHaveBeenCalled();
  });

  it('returns the original rejection when reloadConversation throws', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(SPARSE_STATS);
    getChatGPTVisibleImageUrls.mockResolvedValue([SPARSE_PLACEHOLDER_DATA_URL]);
    getChatGPTImageAssets.mockResolvedValue([{
      url: SPARSE_PLACEHOLDER_DATA_URL,
      dataUrl: SPARSE_PLACEHOLDER_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const reloadConversation = vi.fn(async () => {
      throw new Error('page disconnected');
    });

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      reloadConversation,
      canRetry: () => true,
    });

    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('sparse-placeholder-rejected');
    expect(saveBase64ToFile).not.toHaveBeenCalled();
  });

  // When an image takes longer than the legacy 12 poll iterations to appear in the DOM (e.g. at poll 15),
  // passing an extended pollIterations (e.g. 30) allows exportNewImagesLikeOfficial to capture and save the asset.
  it('captures and downloads an image that appears after the legacy 12 poll iterations when pollIterations is expanded', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);

    let pollCount = 0;
    getChatGPTVisibleImageUrls.mockImplementation(async () => {
      pollCount += 1;
      if (pollCount >= 15) {
        return [OPAQUE_BLACK_DATA_URL];
      }
      return [];
    });

    getChatGPTImageAssets.mockResolvedValue([{
      url: OPAQUE_BLACK_DATA_URL,
      dataUrl: OPAQUE_BLACK_DATA_URL,
      mimeType: 'image/png',
      width: 480,
      height: 480,
    }]);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      pollIterations: 30,
    });

    expect(pollCount).toBe(15);
    expect(results[0].downloaded).toBe(true);
    expect(results[0].url).toBe(OPAQUE_BLACK_DATA_URL);
    expect(saveBase64ToFile).toHaveBeenCalledTimes(1);
  });

  // The canContinue predicate (e.g. remainingMs() >= 2000) halts polling early before user timeout expires.
  it('halts polling early when canContinue budget gate returns false', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);

    let pollCount = 0;
    getChatGPTVisibleImageUrls.mockImplementation(async () => {
      pollCount += 1;
      return [];
    });

    let gateCalls = 0;
    const canContinue = vi.fn(() => {
      gateCalls += 1;
      return gateCalls < 3;
    });

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      pollIterations: 60,
      canContinue,
    });

    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('no-new-visible-image-urls');
    expect(pollCount).toBeLessThanOrEqual(3);
    expect(saveBase64ToFile).not.toHaveBeenCalled();
  });

  // Verify backwards compatibility: default polling stops at DEFAULT_POLL_ITERATIONS (12) when unspecified.
  it('defaults to 12 poll iterations when pollIterations is not specified', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);

    let pollCount = 0;
    getChatGPTVisibleImageUrls.mockImplementation(async () => {
      pollCount += 1;
      return [];
    });

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
    });

    expect(pollCount).toBe(12);
    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('no-new-visible-image-urls');
  });

  // Budget gate fail-closed: returning undefined or non-boolean halts polling immediately.
  it('halts polling immediately when canContinue returns undefined (fail-closed)', async () => {
    const outputDir = tmpOutputDir();
    const page = pageReturningInspection(OPAQUE_STATS);

    let pollCount = 0;
    getChatGPTVisibleImageUrls.mockImplementation(async () => {
      pollCount += 1;
      return [];
    });

    const canContinue = vi.fn(() => undefined);

    const results = await exportNewImagesLikeOfficial(page, {
      beforeUrls: [],
      expectedCount: 1,
      outputDir,
      settleMs: 0,
      pollIterations: 60,
      canContinue,
    });

    expect(results[0].downloaded).toBe(false);
    expect(results[0].error).toBe('no-new-visible-image-urls');
    expect(pollCount).toBe(0);
    expect(canContinue).toHaveBeenCalledTimes(1);
    expect(saveBase64ToFile).not.toHaveBeenCalled();
  });
});

describe('snapshotVisibleImageUrls', () => {
  // Verifies that when modern extractor evaluates with modern: true, matching URLs are returned
  // and legacy host getChatGPTVisibleImageUrls is never called.
  it('returns modern URLs when modern extractor succeeds and does not call legacy host', async () => {
    const page = {
      evaluate: vi.fn(async () => ({ modern: true, urls: ['blob:https://chatgpt.com/asset-1'] })),
    };
    const urls = await snapshotVisibleImageUrls(page, ['msg-1']);
    expect(urls).toEqual(['blob:https://chatgpt.com/asset-1']);
    expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
  });

  // Verifies that when modern DOM is detected but yields no matches for the current turn,
  // it returns [] and does NOT fall back to legacy history extractor (prevents history leak).
  it('returns [] when modern is true but no matching URLs exist and never calls legacy host', async () => {
    const page = {
      evaluate: vi.fn(async () => ({ modern: true, urls: [] })),
    };
    const urls = await snapshotVisibleImageUrls(page, ['msg-current']);
    expect(urls).toEqual([]);
    expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
  });

  // Verifies unwrapEvaluateResult compatibility when page.evaluate returns { session, data } envelope.
  it('unwraps { session, data } envelopes returned from page.evaluate', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        session: 'tab-lease-session-1',
        data: { modern: true, urls: ['blob:https://chatgpt.com/unwrapped-asset'] },
      })),
    };
    const urls = await snapshotVisibleImageUrls(page, ['msg-2']);
    expect(urls).toEqual(['blob:https://chatgpt.com/unwrapped-asset']);
    expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
  });

  // Verifies explicit legacy fallback: legacy extractor is called ONLY when modern is explicitly false.
  it('calls legacy host getChatGPTVisibleImageUrls ONLY when modern is explicitly false', async () => {
    const page = {
      evaluate: vi.fn(async () => ({ modern: false, urls: [] })),
    };
    getChatGPTVisibleImageUrls.mockResolvedValueOnce(['https://chatgpt.com/legacy-img.png']);
    const urls = await snapshotVisibleImageUrls(page, ['msg-legacy']);
    expect(urls).toEqual(['https://chatgpt.com/legacy-img.png']);
    expect(getChatGPTVisibleImageUrls).toHaveBeenCalledTimes(1);
  });

  // Verifies fail-closed behavior: evaluation exceptions return [] and never call legacy host.
  it('fails closed and returns [] on evaluate exceptions without calling legacy host', async () => {
    const page = {
      evaluate: vi.fn(async () => {
        throw new Error('Bridge execution failed');
      }),
    };
    const urls = await snapshotVisibleImageUrls(page, ['msg-fail']);
    expect(urls).toEqual([]);
    expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
  });

  // Verifies fail-closed behavior on malformed evaluate return (null, empty object, or non-boolean modern).
  it('fails closed and returns [] on malformed evaluate payload without calling legacy host', async () => {
    const malformedPayloads = [null, undefined, {}, { modern: 'true' }, { modern: null }, { foo: 'bar' }];
    for (const payload of malformedPayloads) {
      const page = {
        evaluate: vi.fn(async () => payload),
      };
      const urls = await snapshotVisibleImageUrls(page, ['msg-malformed']);
      expect(urls).toEqual([]);
      expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
    }
  });

  // Verifies fail-closed behavior when page or page.evaluate is missing.
  it('returns [] when page or page.evaluate is invalid', async () => {
    expect(await snapshotVisibleImageUrls(null)).toEqual([]);
    expect(await snapshotVisibleImageUrls({})).toEqual([]);
    expect(getChatGPTVisibleImageUrls).not.toHaveBeenCalled();
  });
});

describe('isContinueAllowed', () => {
  it('returns true when predicate is omitted or null', () => {
    expect(isContinueAllowed(undefined)).toBe(true);
    expect(isContinueAllowed(null)).toBe(true);
  });

  it('returns true when predicate explicitly returns true', () => {
    expect(isContinueAllowed(() => true)).toBe(true);
  });

  it('returns false for undefined, false, truthy non-boolean, or thrown errors (fail-closed)', () => {
    expect(isContinueAllowed(() => false)).toBe(false);
    expect(isContinueAllowed(() => undefined)).toBe(false);
    expect(isContinueAllowed(() => null)).toBe(false);
    expect(isContinueAllowed(() => 1)).toBe(false);
    expect(isContinueAllowed(() => 'true')).toBe(false);
    expect(isContinueAllowed(() => { throw new Error('boom'); })).toBe(false);
    expect(isContinueAllowed('not-a-fn')).toBe(false);
  });
});

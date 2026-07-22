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

const getChatGPTVisibleImageUrls = vi.fn();
const getChatGPTImageAssets = vi.fn();
const saveBase64ToFile = vi.fn(async () => undefined);
const unwrapEvaluateResult = vi.fn((payload) => payload);

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
  makeInspectPlaceholder,
  runImageExportAttempt,
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

function pageReturningInspection(envelope) {
  return {
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async () => envelope),
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
    const page = pageThrowingEvaluation();
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
    const page = pageReturningInspection(null); // overridden per call below
    page.evaluate
      .mockResolvedValueOnce(SPARSE_STATS)
      .mockResolvedValueOnce(OPAQUE_STATS);

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
    expect(page.evaluate).toHaveBeenCalledTimes(2);
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
    expect(page.evaluate).toHaveBeenCalledTimes(1);
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
    expect(page.evaluate).toHaveBeenCalledTimes(1);
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
});

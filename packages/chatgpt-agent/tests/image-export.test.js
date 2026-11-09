import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportNewImagesLikeOfficial, resolveImageOutputDir } from '../src/image-export.js';

const tempDirs = [];
const MESSAGE_IDS = ['message-current'];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeOutputDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-native-images-'));
  tempDirs.push(dir);
  return dir;
}

function pngAt(filePath) {
  fs.writeFileSync(filePath, Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
  ]));
  return filePath;
}

function makePage({ targets, receipts, clickFailure = null, waiterFailure = null } = {}) {
  let menuOpen = false;
  let viewerOpen = false;
  let targetRun = 0;
  const page = {
    actions: [],
    waitForDownload: vi.fn((_pattern, timeoutMs) => {
      page.actions.push({ type: 'wait', timeoutMs });
      const receipt = receipts?.shift();
      return waiterFailure ? Promise.reject(new Error(waiterFailure))
        : Promise.resolve(receipt);
    }),
    click: vi.fn(async (selector, options) => {
      page.actions.push({ type: 'click', selector, options });
      if (clickFailure && selector.includes('menuitem')) throw new Error(clickFailure);
      if (selector.includes('menuitem')) menuOpen = false;
      if (selector.includes('generated-image-preview')) viewerOpen = true;
      if (selector.includes('Close viewer')) viewerOpen = false;
      // Page SDK returns locator metadata; only the CLI envelope adds `clicked`.
      return { matches_n: 1, click_method: 'cdp' };
    }),
    focus: vi.fn(async (selector, options) => {
      page.actions.push({ type: 'focus', selector, options });
      return { focused: true };
    }),
    pressKey: vi.fn(async (key) => {
      page.actions.push({ type: 'key', key });
      menuOpen = true;
    }),
    sleep: vi.fn(async () => {}),
    evaluate: vi.fn(async (script) => {
      if (script.includes("const ids = new Set(") && script.includes("const galleries =")) {
        const current = targets?.runs ? targets.runs[targetRun] || [] : targets || [];
        targetRun += 1;
        return { targets: current };
      }
      if (script.includes('const rail = document.querySelector(')) return true;
      if (script.includes('triggerSelector:')) {
        return {
          dialog: viewerOpen,
          triggerSelector: '[role="dialog"] [aria-label="Download"]',
          menu: menuOpen,
          menuSelector: '[role="menu"] [role="menuitem"]',
          items: menuOpen
            ? [
              { index: 0, text: 'Download 3 images in this series', visible: true },
              { index: 1, text: 'Download image', visible: true },
            ]
            : [],
          closeSelector: '[role="dialog"] button[aria-label="Close viewer"]',
        };
      }
      throw new Error(`Unexpected page.evaluate script: ${script.slice(0, 100)}`);
    }),
  };
  return page;
}

function receipt(filename, id = 1001) {
  return {
    downloaded: true,
    state: 'complete',
    filename,
    id,
    mime: 'image/png',
    totalBytes: 12,
  };
}

const threeRailTargets = [
  { key: 'message-current:1', kind: 'rail', selector: 'button[aria-label="Show generated image 1"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 1 },
  { key: 'message-current:2', kind: 'rail', selector: 'button[aria-label="Show generated image 2"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 2 },
  { key: 'message-current:3', kind: 'rail', selector: 'button[aria-label="Show generated image 3"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 3 },
];

describe('native Chrome generated-image export', () => {
  it('fails closed without current-turn message IDs', async () => {
    const page = makePage({ targets: threeRailTargets });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: [],
      expectedCount: 1,
      outputDir: makeOutputDir(),
    });
    expect(results[0]).toMatchObject({
      kind: 'image-export', method: 'chrome-download', downloaded: false, error: 'missing-message-ids',
    });
    expect(page.click).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('selects rail order and uses the exact Download image item with waiter armed first', async () => {
    const outputDir = makeOutputDir();
    const downloadsDir = makeOutputDir();
    const paths = [1, 2, 3].map((n) => pngAt(path.join(downloadsDir, `Rain-Soaked Moon Gate ${n}.png`)));
    const page = makePage({
      targets: threeRailTargets,
      receipts: paths.map((file, i) => receipt(file, 500 + i)),
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS,
      expectedCount: 3,
      outputDir,
      remainingMs: () => 60_000,
      canContinue: () => true,
    });

    expect(results).toHaveLength(3);
    expect(results.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(results.every((item) => item.downloaded && item.method === 'chrome-download')).toBe(true);
    expect(results.map((item) => path.basename(item.path))).toEqual([
      'Rain-Soaked_Moon_Gate_1.png',
      'Rain-Soaked_Moon_Gate_2.png',
      'Rain-Soaked_Moon_Gate_3.png',
    ]);
    expect(results[0]).toMatchObject({ originalFilename: paths[0], downloadId: 500, bytes: 12 });

    const actions = page.actions;
    const finalClicks = actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem'));
    const armIndices = actions.map((action, i) => action.type === 'wait' ? i : -1).filter((i) => i >= 0);
    const clickIndices = actions.map((action, i) => action.type === 'click' && action.selector.includes('menuitem') ? i : -1)
      .filter((i) => i >= 0);
    expect(finalClicks).toHaveLength(3);
    expect(armIndices.every((arm, i) => arm < clickIndices[i])).toBe(true);
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('Show generated image')).map((a) => a.selector))
      .toEqual(threeRailTargets.map((target) => target.selector));
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem')).map((a) => a.options.nth))
      .toEqual([1, 1, 1]);
    expect(results.map((item) => item.sha256)).toHaveLength(3);
  });

  it('does not return success after a final menu click failure or waiter rejection', async () => {
    const outputDir = makeOutputDir();
    const file = pngAt(path.join(outputDir, 'download.png'));
    const failedClick = makePage({
      targets: [threeRailTargets[0]],
      receipts: [receipt(file)],
      clickFailure: 'CDP click failed',
    });
    const clickResult = await exportNewImagesLikeOfficial(failedClick, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir, remainingMs: () => 1000,
    });
    expect(clickResult[0]).toMatchObject({ downloaded: false, error: expect.stringContaining('image-download-click-failed') });
    expect(failedClick.waitForDownload).toHaveBeenCalledTimes(1);

    const rejectedWaiter = makePage({
      targets: [threeRailTargets[0]],
      waiterFailure: 'download timed out',
    });
    const reloadConversation = vi.fn(async () => {});
    const waitResult = await exportNewImagesLikeOfficial(rejectedWaiter, {
      messageIds: MESSAGE_IDS,
      expectedCount: 1,
      outputDir,
      remainingMs: () => 1000,
      reloadConversation,
      canRetry: () => true,
    });
    expect(waitResult[0]).toMatchObject({
      downloaded: false, uncertain: true, error: expect.stringContaining('image-download-wait-failed'),
    });
    expect(reloadConversation).not.toHaveBeenCalled();
  });

  it('rejects missing receipts, unavailable files, and non-image files', async () => {
    const outputDir = makeOutputDir();
    const targets = [threeRailTargets[0]];
    const missing = await exportNewImagesLikeOfficial(makePage({ targets, receipts: [{ downloaded: true, state: 'complete' }] }), {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir,
    });
    expect(missing[0]).toMatchObject({ downloaded: false, error: 'download-receipt-filename-missing' });

    const absent = await exportNewImagesLikeOfficial(makePage({ targets, receipts: [receipt(path.join(outputDir, 'absent.png'))] }), {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir,
    });
    expect(absent[0]).toMatchObject({ downloaded: false, error: 'download-file-unreadable-or-empty' });

    const nonImage = path.join(outputDir, 'not-an-image.png');
    fs.writeFileSync(nonImage, 'not an image');
    const invalid = await exportNewImagesLikeOfficial(makePage({ targets, receipts: [receipt(nonImage)] }), {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir,
    });
    expect(invalid[0]).toMatchObject({ downloaded: false, error: 'download-file-not-image' });
  });

  it('remounts once, retains the first successful file, and skips it on retry', async () => {
    const outputDir = makeOutputDir();
    const downloadsDir = makeOutputDir();
    const firstFile = pngAt(path.join(downloadsDir, 'first.png'));
    const secondFile = pngAt(path.join(downloadsDir, 'second.png'));
    const reloadConversation = vi.fn(async () => {});
    const page = makePage({
      targets: { runs: [
        ...Array.from({ length: 12 }, () => [threeRailTargets[0]]),
        threeRailTargets.slice(0, 2),
      ] },
      receipts: [receipt(firstFile, 1), receipt(secondFile, 2)],
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS,
      expectedCount: 2,
      outputDir,
      remainingMs: () => 60_000,
      reloadConversation,
      canRetry: () => true,
    });
    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(results.filter((item) => item.downloaded).map((item) => item.index)).toEqual([0, 1]);
    expect(page.waitForDownload).toHaveBeenCalledTimes(2);
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('Show generated image')).map((a) => a.selector))
      .toEqual(threeRailTargets.slice(0, 2).map((target) => target.selector));
  });

  it('preserves output-dir resolution and does not use any Base64 / host image fetch path', async () => {
    expect(resolveImageOutputDir('~/Pictures/custom')).toBe(path.join(os.homedir(), 'Pictures/custom'));
    expect(resolveImageOutputDir('/tmp/explicit')).toBe('/tmp/explicit');
    const source = fs.readFileSync(new URL('../src/image-export.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/getChatGPTImageAssets|saveBase64|base64/i);
  });

  // A depleted outer turn budget must prevent both clicks and download waiters.
  it('does not touch the download UI after the caller timeout expires', async () => {
    const page = makePage({ targets: threeRailTargets });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 3, outputDir: makeOutputDir(), remainingMs: () => 0,
    });
    expect(results.some((item) => item.downloaded)).toBe(false);
    expect(page.click).not.toHaveBeenCalled();
    expect(page.waitForDownload).not.toHaveBeenCalled();
  });

  // Replacing a previously completed target on remount must not inflate success
  // count by downloading a different image under the same array position.
  it('preserves files but rejects changed target identities after remount', async () => {
    const dir = makeOutputDir();
    const file = pngAt(path.join(dir, 'original.png'));
    const page = makePage({
      targets: { runs: [
        ...Array.from({ length: 12 }, () => [threeRailTargets[0]]),
        [{ ...threeRailTargets[0], key: 'different:1' }, threeRailTargets[1]],
      ] },
      receipts: [receipt(file)],
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 2, outputDir: makeOutputDir(),
      reloadConversation: async () => {}, canRetry: () => true,
    });
    expect(results.filter((item) => item.downloaded)).toHaveLength(1);
    expect(results.some((item) => item.error === 'image-target-identity-changed')).toBe(true);
    expect(page.waitForDownload).toHaveBeenCalledTimes(1);
  });
});

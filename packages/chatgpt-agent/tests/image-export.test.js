import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportNewImagesLikeOfficial, resolveImageOutputDir } from '../src/image-export.js';

const tempDirs = [];
const MESSAGE_IDS = ['message-current'];

afterEach(() => {
  vi.useRealTimers();
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

function makePage({ targets, receipts, clickFailure = null, waiterFailure = null, previewNoOps = 0,
  initialViewer = false, closeNoOps = 0,
  direct = false, menuDelay = 0, menuItemDelay = 0, menuItems = null } = {}) {
  let menuOpen = false;
  let menuCountdown = 0;
  let menuItemCountdown = 0;
  let pendingReceipt;
  let viewerOpen = initialViewer;
  let selectedViewer = 0;
  let targetRun = 0;
  const page = {
    actions: [],
    menuEmptyStates: 0,
    waitForDownload: vi.fn((_pattern, timeoutMs) => {
      page.actions.push({ type: 'wait', timeoutMs });
      const receipt = receipts?.shift();
      if (waiterFailure) return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(waiterFailure)), 15);
      });
      return new Promise((resolve) => { pendingReceipt = () => resolve(receipt); });
    }),
    click: vi.fn(async (selector, options) => {
      page.actions.push({ type: 'click', selector, options });
      if (clickFailure && selector.includes('menuitem')) {
        pendingReceipt?.();
        throw new Error(clickFailure);
      }
      if (selector.includes('menuitem')) {
        menuOpen = false;
        pendingReceipt?.();
      }
      if (selector.includes('aria-label=') && selector.includes('Download')) {
        if (direct) pendingReceipt?.();
        else {
          menuOpen = true;
          menuCountdown = menuDelay;
          menuItemCountdown = menuItemDelay;
        }
      }
      if (selector.includes('generated-image-preview')) {
        if (previewNoOps > 0) previewNoOps -= 1;
        else viewerOpen = true;
      }
      if (selector.includes('Close viewer')) {
        if (closeNoOps > 0) closeNoOps -= 1;
        else viewerOpen = false;
      }
      if (selector.includes('data-image-thumbnail')) {
        selectedViewer = Number(selector.match(/Generated image (\d+)/)[1]) - 12;
      }
      // Page SDK returns locator metadata; only the CLI envelope adds `clicked`.
      return { matches_n: 1, click_method: 'cdp' };
    }),
    focus: vi.fn(async (selector, options) => {
      page.actions.push({ type: 'focus', selector, options });
      return { focused: true };
    }),
    pressKey: vi.fn(async (key) => { page.actions.push({ type: 'key', key }); }),
    sleep: vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 0))),
    evaluate: vi.fn(async (script) => {
      if (script.includes("const ids = new Set(") && script.includes("const galleries =")) {
        const current = targets?.runs ? targets.runs[targetRun] || [] : targets || [];
        targetRun += 1;
        return { targets: current };
      }
      if (script.includes('const target = ')) {
        const target = JSON.parse(script.match(/const target = (.*);/)[1]);
        return {
          ready: viewerOpen && selectedViewer === target.order,
          selector: viewerSelectors[target.order - 1],
          reason: 'viewer-image-not-matched',
        };
      }
      if (script.includes('triggerSelector:')) {
        if (menuCountdown > 0) menuCountdown -= 1;
        const showMenu = menuOpen && menuCountdown === 0;
        if (showMenu && menuItemCountdown > 0) {
          menuItemCountdown -= 1;
          page.menuEmptyStates += 1;
        }
        const showItems = showMenu && menuItemCountdown === 0;
        return {
          dialog: viewerOpen,
          triggerSelector: viewerOpen ? '[role="dialog"] [aria-label="Download"]' : '',
          menu: showMenu,
          menuSelector: '[role="menu"] [role="menuitem"]',
          items: showItems
            ? menuItems || [
              { index: 0, text: 'Download 3 images in this series', visible: true },
              { index: 1, text: 'Download image', visible: true },
            ]
            : [],
          closeSelector: viewerOpen ? '[role="dialog"] button[aria-label="Close viewer"]' : '',
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
  { key: 'message-current:1', kind: 'rail', selector: 'button[aria-label="Show generated image 1"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 1, sourceUrl: 'blob:current-1' },
  { key: 'message-current:2', kind: 'rail', selector: 'button[aria-label="Show generated image 2"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 2, sourceUrl: 'blob:current-2' },
  { key: 'message-current:3', kind: 'rail', selector: 'button[aria-label="Show generated image 3"]', previewSelector: 'button[data-testid="generated-image-preview"]', order: 3, sourceUrl: 'blob:current-3' },
];
const viewerSelectors = [13, 14, 15].map((n) =>
  `[role="dialog"] button[data-image-thumbnail][aria-label="Generated image ${n}"]`);

describe('native Chrome generated-image export', () => {
  // A close click may be swallowed by a pending menu/mount transition. Retry
  // only the close UI, and never discover or download behind an open viewer.
  it('confirms an existing viewer closed before discovering the current turn', async () => {
    vi.useFakeTimers();
    const dir = makeOutputDir();
    const page = makePage({
      targets: [threeRailTargets[0]], initialViewer: true, closeNoOps: 1,
      receipts: [receipt(pngAt(path.join(dir, 'reopened.png')))],
    });
    page.sleep.mockImplementation(async (seconds) => { vi.advanceTimersByTime(seconds * 1000); });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(results[0].downloaded).toBe(true);
    const closeClicks = page.actions.filter((a) => a.type === 'click' && a.selector.includes('Close viewer'));
    expect(closeClicks).toHaveLength(3); // two confirmed preflight attempts + final cleanup
    expect(page.waitForDownload).toHaveBeenCalledTimes(1);
  });

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
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('data-image-thumbnail')).map((a) => a.selector))
      .toEqual(viewerSelectors);
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('generated-image-preview'))).toHaveLength(1);
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem')).map((a) => a.options.nth))
      .toEqual([1, 1, 1]);
    expect(results.map((item) => item.sha256)).toHaveLength(3);
  });

  // Some viewers download directly from the trigger. The waiter must already
  // be armed, and the trigger must never be clicked again to hunt for a menu.
  it('accepts a direct trigger receipt without requiring a menu', async () => {
    const dir = makeOutputDir();
    const page = makePage({
      targets: [threeRailTargets[0]], direct: true,
      receipts: [receipt(pngAt(path.join(dir, 'direct.png')))],
    });
    const result = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(result[0].downloaded).toBe(true);
    const waitIndex = page.actions.findIndex((action) => action.type === 'wait');
    const triggerIndices = page.actions.map((action, i) => action.type === 'click'
      && action.selector.includes('aria-label') && action.selector.includes('Download') ? i : -1).filter((i) => i >= 0);
    expect(waitIndex).toBeGreaterThan(-1);
    expect(triggerIndices).toHaveLength(1);
    expect(waitIndex).toBeLessThan(triggerIndices[0]);
    expect(page.actions.some((action) => action.type === 'click' && action.selector.includes('menuitem'))).toBe(false);
  });

  // A delayed menu is observed after one trigger activation, while the original
  // waiter remains armed for the eventual exact image item.
  it('waits for a delayed menu and clicks only its exact image item', async () => {
    const dir = makeOutputDir();
    const page = makePage({
      targets: [threeRailTargets[0]], menuDelay: 3,
      receipts: [receipt(pngAt(path.join(dir, 'delayed.png')))],
    });
    const result = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(result[0].downloaded).toBe(true);
    expect(page.actions.filter((action) => action.type === 'click'
      && action.selector.includes('aria-label') && action.selector.includes('Download'))).toHaveLength(1);
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem'))).toHaveLength(1);
  });

  // React can mount the menu before populating its items. Keep polling under the
  // original bounded waiter instead of treating an empty intermediate state as final.
  it('waits for exact menu items to populate after the menu itself mounts', async () => {
    const dir = makeOutputDir();
    const page = makePage({
      targets: [threeRailTargets[0]], menuItemDelay: 3,
      receipts: [receipt(pngAt(path.join(dir, 'populated.png')))],
    });
    const result = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(result[0].downloaded).toBe(true);
    expect(page.menuEmptyStates).toBeGreaterThan(0);
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem'))).toHaveLength(1);
  });

  // A virtualized rerender can replace the preview selector and blob URL while
  // retaining logical scope/order; refresh must replace the stale selector.
  it('refreshes a same-identity target before activating its preview', async () => {
    const dir = makeOutputDir();
    const oldTarget = { ...threeRailTargets[0], selector: 'stale-rail', previewSelector: 'button[data-testid="generated-image-preview"].stale' };
    const freshTarget = { ...threeRailTargets[0], selector: 'fresh-rail', previewSelector: 'button[data-testid="generated-image-preview"].fresh', sourceUrl: 'blob:refreshed' };
    const page = makePage({
      targets: { runs: [[oldTarget], [freshTarget], [freshTarget]] },
      receipts: [receipt(pngAt(path.join(dir, 'fresh.png')))],
    });
    const result = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(result[0].downloaded).toBe(true);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === freshTarget.previewSelector)).toBe(true);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === oldTarget.previewSelector)).toBe(false);
  });

  // A preview can disappear between initial discovery and the click. Poll for
  // the same logical key and retry with the returned live selector, never stale.
  it('rediscoveries a missing preview before activating the reappeared same-key target', async () => {
    const dir = makeOutputDir();
    const stale = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].stale' };
    const fresh = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].fresh', sourceUrl: 'blob:reappeared' };
    const page = makePage({
      targets: { runs: [[stale], [stale], [], [fresh]] },
      receipts: [receipt(pngAt(path.join(dir, 'reappeared.png')))],
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(results[0].downloaded).toBe(true);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === fresh.previewSelector)).toBe(true);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === stale.previewSelector)).toBe(false);
  });

  // If the preview never reappears in the current mount, fail without a stale
  // click and let the existing single conversation remount retry it once.
  it('leaves a missing preview to the single remount retry without stale activation', async () => {
    const dir = makeOutputDir();
    const stale = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].stale' };
    const fresh = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].fresh', sourceUrl: 'blob:after-remount' };
    const reloadConversation = vi.fn(async () => {});
    const page = makePage({
      targets: { runs: [[stale], [stale], [], [], [], [], [fresh], [fresh], [fresh]] },
      receipts: [receipt(pngAt(path.join(dir, 'after-remount.png')))],
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
      reloadConversation, canRetry: () => true,
    });
    expect(reloadConversation).toHaveBeenCalledTimes(1);
    expect(results[0].downloaded).toBe(true);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === stale.previewSelector)).toBe(false);
    expect(page.actions.some((action) => action.type === 'click' && action.selector === fresh.previewSelector)).toBe(true);
  });

  // A bulk/series label is not an image receipt action. Its unconfirmed waiter
  // marks the sequence uncertain and prevents any next image attribution.
  it('rejects series-only menu labels and stops after the one uncertain trigger', async () => {
    const page = makePage({
      targets: threeRailTargets,
      waiterFailure: 'download timed out',
      menuItems: [{ index: 0, text: 'Download 3 images in this series', visible: true }],
    });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 3, outputDir: makeOutputDir(),
    });
    expect(results[0]).toMatchObject({ downloaded: false, uncertain: true });
    expect(page.waitForDownload).toHaveBeenCalledTimes(1);
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem'))).toHaveLength(0);
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
    expect(clickResult[0]).toMatchObject({ downloaded: false, error: expect.stringContaining('image-download-menuitem-click-failed') });
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

  // A timed-out click can still produce a late Chrome event. Starting the
  // next blank-pattern waiter would risk attributing that file to another image.
  it('stops the image sequence after an unconfirmed download', async () => {
    const page = makePage({ targets: threeRailTargets, waiterFailure: 'download timed out' });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 3, outputDir: makeOutputDir(),
    });
    expect(results[0]).toMatchObject({ downloaded: false, uncertain: true });
    expect(page.waitForDownload).toHaveBeenCalledTimes(1);
    expect(page.actions.filter((a) => a.type === 'click' && a.selector.includes('menuitem'))).toHaveLength(1);
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
        ...Array.from({ length: 13 }, () => [threeRailTargets[0]]),
        threeRailTargets.slice(0, 2),
        threeRailTargets.slice(0, 2),
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
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('data-image-thumbnail')).map((a) => a.selector))
      .toEqual(viewerSelectors.slice(0, 2));
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

  // During virtualization/mount the first preview activation can be a no-op.
  // Only the preview may be retried, with no repeated generation or download.
  it('retries one ignored preview activation before arming a single download', async () => {
    vi.useFakeTimers();
    const dir = makeOutputDir();
    const stale = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].stale' };
    const fresh = { ...threeRailTargets[0], previewSelector: 'button[data-testid="generated-image-preview"].fresh', sourceUrl: 'blob:retry-fresh' };
    const page = makePage({
      targets: { runs: [[stale], [stale], [stale], [fresh]] },
      receipts: [receipt(pngAt(path.join(dir, 'image.png')))],
      previewNoOps: 1,
    });
    page.sleep.mockImplementation(async (seconds) => { vi.advanceTimersByTime(seconds * 1000); });
    const results = await exportNewImagesLikeOfficial(page, {
      messageIds: MESSAGE_IDS, expectedCount: 1, outputDir: makeOutputDir(),
    });
    expect(results[0].downloaded).toBe(true);
    expect(page.actions.filter((a) => a.type === 'click' && a.selector.includes('generated-image-preview'))).toHaveLength(2);
    expect(page.actions.filter((a) => a.type === 'click' && a.selector.includes('generated-image-preview'))
      .map(({ selector }) => selector)).toEqual([stale.previewSelector, fresh.previewSelector]);
    expect(page.waitForDownload).toHaveBeenCalledTimes(1);
  });

  // Replacing a previously completed target on remount must not inflate success
  // count by downloading a different image under the same array position.
  it('preserves files but rejects changed target identities after remount', async () => {
    const dir = makeOutputDir();
    const file = pngAt(path.join(dir, 'original.png'));
    const page = makePage({
      targets: { runs: [
        ...Array.from({ length: 14 }, () => [threeRailTargets[0]]),
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

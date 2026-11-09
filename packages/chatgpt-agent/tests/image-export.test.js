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
      if (script.includes('const rail = buttons[')) return true;
      if (script.includes('const allTriggers =')) {
        return {
          dialog: true,
          triggerIndex: 0,
          menu: menuOpen,
          items: menuOpen
            ? [{ index: 0, text: 'Download image', visible: true }]
            : [],
          closeIndex: 0,
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
  { kind: 'rail', globalIndex: 0, previewGlobalIndex: 0, order: 1 },
  { kind: 'rail', globalIndex: 1, previewGlobalIndex: 0, order: 2 },
  { kind: 'rail', globalIndex: 2, previewGlobalIndex: 0, order: 3 },
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
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('Show generated image')).map((a) => a.options.nth))
      .toEqual([0, 1, 2]);
    expect(actions.filter((action) => action.type === 'click' && action.selector.includes('menuitem')).map((a) => a.options.nth))
      .toEqual([0, 0, 0]);
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
        [threeRailTargets[0]],
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
    expect(page.actions.filter((action) => action.type === 'click' && action.selector.includes('Show generated image')).map((a) => a.options.nth))
      .toEqual([0, 1]);
  });

  it('preserves output-dir resolution and does not use any Base64 / host image fetch path', async () => {
    expect(resolveImageOutputDir('~/Pictures/custom')).toBe(path.join(os.homedir(), 'Pictures/custom'));
    expect(resolveImageOutputDir('/tmp/explicit')).toBe('/tmp/explicit');
    const source = fs.readFileSync(new URL('../src/image-export.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/getChatGPTImageAssets|saveBase64|base64/i);
  });
});

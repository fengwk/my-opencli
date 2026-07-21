/**
 * Tests for uploadComposerFiles — the native CDP-only upload path.
 *
 * Behavior under test:
 *   1. Successful native upload: page.setFileInput is called with [browserPath] and a selector.
 *      No fallback evaluate / base64 path runs; the success path is reported.
 *   2. Selector-not-found advances to the next selector (CDP DOM.querySelector returned no node).
 *   3. Non-selector failure (attach/transport/CDP/path/chooser) stops after the first call.
 *      The reason preserves filename, selector, and the exact underlying error.
 *   4. No fallback evaluate / DataTransfer / base64 path is ever attempted.
 *   5. Multi-file uploads remain sequential with a sleep gap between files.
 *
 * Tests mock page.setFileInput and page.evaluate to keep this fully deterministic and
 * isolated from any real browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  prepareLocalFiles,
  uploadComposerFiles,
} = await import('../src/upload-dom.js');

const temps = [];
let originalVerbose;

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  originalVerbose = process.env.OPENCLI_VERBOSE;
  delete process.env.OPENCLI_VERBOSE;
});

/**
 * Build a fake `page` for uploadComposerFiles.
 *
 *   - setFileInput is provided by the test (override per-case)
 *   - evaluate dispatches by the script content:
 *       * `names.every(...)` → waitForAttachmentPreview body check → returns `previewOk`
 *         (default true). Each subsequent iteration uses the same response so the loop exits
 *         on the first call when true, or exhausts when false.
 *       * `querySelectorAll('input[type="file"]')` → ensureFileInputsMounted probe →
 *         returns `probe` (default count=1, so no plus-button click is attempted).
 *       * everything else → returns undefined (dismissMenus + plus-click ignored).
 *   - sleep is tracked so we can assert sequential ordering
 */
function fakePage({
  setFileInput,
  previewOk = true,
  probe = { count: 1, inputs: [{ i: 0, id: 'upload-photos' }] },
} = {}) {
  const evaluate = vi.fn(async (script) => {
    if (typeof script !== 'string') return undefined;
    if (script.includes('names.every(')) return !!previewOk;
    if (script.includes("querySelectorAll('input[type=\"file\"]')")) return probe;
    return undefined;
  });
  const sleep = vi.fn(async () => {});
  return {
    setFileInput,
    evaluate,
    sleep,
  };
}

function tmpFileWithContent(name, content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cga-upload-'));
  temps.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function prepared(nodePath) {
  return [{
    nodePath,
    sourcePath: nodePath,
    browserPath: nodePath, // tests run on a Linux node path
    name: path.basename(nodePath),
  }];
}

describe('uploadComposerFiles — native CDP only', () => {
  it('completes a successful native upload through the first selector', async () => {
    const setFileInput = vi.fn(async () => undefined);
    const page = fakePage({ setFileInput });
    const file = tmpFileWithContent('a.png');

    const result = await uploadComposerFiles(page, prepared(file));

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(['a.png']);
    expect(setFileInput).toHaveBeenCalledTimes(1);
    expect(setFileInput).toHaveBeenCalledWith([file], '#upload-photos');
    // The DataTransfer / base64 fallback must not run at all.
    expect(page.evaluate).not.toHaveBeenCalledWith(expect.stringMatching(/DataTransfer/));
    expect(page.evaluate).not.toHaveBeenCalledWith(expect.stringMatching(/atob/));
  });

  it('treats selector-not-found as recoverable and advances to the next selector', async () => {
    const setFileInput = vi.fn();
    // Image selector list: #upload-photos, input[type="file"][accept*="image"], #upload-files, input[type="file"]
    setFileInput
      .mockRejectedValueOnce(new Error('No element found matching selector: #upload-photos'))
      .mockRejectedValueOnce(new Error('No element found matching selector: input[type="file"][accept*="image"]'))
      .mockResolvedValueOnce(undefined); // success on #upload-files

    const page = fakePage({ setFileInput });
    const file = tmpFileWithContent('a.jpg', 'jpg-bytes');

    const result = await uploadComposerFiles(page, prepared(file));

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(['a.jpg']);
    expect(setFileInput).toHaveBeenCalledTimes(3);
    expect(setFileInput.mock.calls.map((c) => c[1])).toEqual([
      '#upload-photos',
      'input[type="file"][accept*="image"]',
      '#upload-files',
    ]);
  });

  it('stops on the first non-selector failure and preserves filename/selector/error detail', async () => {
    const setFileInput = vi.fn(async () => {
      throw new Error('Page.fileChooserOpened not received within 8s — the input may not have opened a file chooser');
    });
    const page = fakePage({ setFileInput });
    const file = tmpFileWithContent('a.png');

    const result = await uploadComposerFiles(page, prepared(file));

    expect(result.ok).toBe(false);
    expect(setFileInput).toHaveBeenCalledTimes(1); // only the first selector is tried
    expect(setFileInput).toHaveBeenCalledWith([file], '#upload-photos');
    // Filename + selector + exact underlying error must all be present.
    expect(result.reason).toContain('a.png');
    expect(result.reason).toContain('#upload-photos');
    expect(result.reason).toContain(
      'Page.fileChooserOpened not received within 8s — the input may not have opened a file chooser',
    );
    expect(result.files).toEqual([]);
  });

  it('reports all selector attempts when every selector misses', async () => {
    const setFileInput = vi.fn(async (_files, selector) => {
      throw new Error(`No element found matching selector: ${selector}`);
    });
    const page = fakePage({ setFileInput });
    const file = tmpFileWithContent('a.png');

    const result = await uploadComposerFiles(page, prepared(file));

    expect(result.ok).toBe(false);
    // Image selectors: 4 candidates; setFileInput is called exactly once per selector.
    expect(setFileInput).toHaveBeenCalledTimes(4);
    const tried = result.reason.match(/\(tried: ([^)]+)\)/);
    expect(tried).not.toBeNull();
    expect(tried[1].split(', ').sort()).toEqual([
      '#upload-files',
      '#upload-photos',
      'input[type="file"]',
      'input[type="file"][accept*="image"]',
    ]);
    expect(result.reason).toContain('a.png');
    expect(result.files).toEqual([]);
  });

  it('never calls page.evaluate with File/DataTransfer/atob/typed-array payload as a fallback', async () => {
    const setFileInput = vi.fn();
    setFileInput
      .mockRejectedValueOnce(new Error('No element found matching selector: #upload-photos'))
      .mockRejectedValueOnce(new Error('No element found matching selector: input[type="file"][accept*="image"]'))
      .mockRejectedValueOnce(new Error('No element found matching selector: #upload-files'))
      .mockRejectedValueOnce(new Error('No element found matching selector: input[type="file"]'));
    const page = fakePage({ setFileInput });
    const file = tmpFileWithContent('a.png');

    await uploadComposerFiles(page, prepared(file));

    // Look at every evaluate call: none of them should carry a DataTransfer / File / atob payload.
    const calls = page.evaluate.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [script] of calls) {
      const src = typeof script === 'string' ? script : '';
      expect(src).not.toMatch(/DataTransfer/);
      expect(src).not.toMatch(/new File\(/);
      expect(src).not.toMatch(/\batob\(/);
      expect(src).not.toMatch(/Uint8Array/);
    }
  });

  it('runs multiple files sequentially with a sleep gap and stops at the first hard failure', async () => {
    const setFileInput = vi.fn();
    // First file: success on first selector. Second file: fails with a transport error
    // (must stop, not skip / retry / fallback).
    setFileInput
      .mockResolvedValueOnce(undefined) // a.png attempt 1 — succeeds
      .mockRejectedValueOnce(new Error('Runtime.evaluate failed: -32000 Not allowed')); // b.png fails
    const page = fakePage({ setFileInput });
    const fileA = tmpFileWithContent('a.png');
    const fileB = tmpFileWithContent('b.png');

    const result = await uploadComposerFiles(page, [
      { nodePath: fileA, sourcePath: fileA, browserPath: fileA, name: 'a.png' },
      { nodePath: fileB, sourcePath: fileB, browserPath: fileB, name: 'b.png' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.files).toEqual(['a.png']); // first file completed
    // 1st file: 1 selector (success). 2nd file: only first selector tried (non-selector failure short-circuits).
    expect(setFileInput).toHaveBeenCalledTimes(2);
    expect(setFileInput.mock.calls.map((c) => c[1])).toEqual([
      '#upload-photos',         // a.png success
      '#upload-photos',         // b.png attempt 1 — fails (transport)
    ]);
    expect(result.reason).toContain('b.png');
    expect(result.reason).toContain('#upload-photos');
    expect(result.reason).toContain('-32000');
    // Inter-file gap is preserved between files.
    const sleepArgs = page.sleep.mock.calls.map((c) => c[0]);
    expect(sleepArgs).toContain(0.4);
  });

  it('returns a clean error when page.setFileInput is not available', async () => {
    const page = fakePage({ setFileInput: undefined });
    // Drop setFileInput entirely.
    delete page.setFileInput;
    const file = tmpFileWithContent('a.png');

    const result = await uploadComposerFiles(page, prepared(file));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('page.setFileInput is not available');
    expect(result.files).toEqual([]);
  });
});

describe('prepareLocalFiles — preconditions', () => {
  it('rejects non-existent local paths before any page interaction', () => {
    const out = prepareLocalFiles('/this/path/does/not/exist-9f7c.png');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/File not found/);
  });

  it('returns the staged fields needed for native setFileInput only', () => {
    const file = tmpFileWithContent('hello.png', 'hello-bytes');
    const out = prepareLocalFiles(file);
    expect(out.ok).toBe(true);
    expect(out.files).toHaveLength(1);
    const [entry] = out.files;
    // browserPath is the only thing setFileInput uses; nodePath + sourcePath are present
    // for diagnostics and must point at an existing local file (no base64 payload anywhere).
    expect(typeof entry.browserPath).toBe('string');
    expect(typeof entry.nodePath).toBe('string');
    expect(typeof entry.sourcePath).toBe('string');
    expect(fs.existsSync(entry.nodePath)).toBe(true);
  });
});

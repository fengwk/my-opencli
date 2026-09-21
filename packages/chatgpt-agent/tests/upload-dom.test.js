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
  DEFAULT_MAX_SIZE_BYTES,
  IMAGE_MAX_SIZE_BYTES,
  MAX_ATTACHMENT_COUNT,
  SPREADSHEET_MAX_SIZE_BYTES,
  getMaxFileSize,
  prepareLocalFiles,
  uploadComposerFiles,
} = await import('../src/upload-dom.js');

const temps = [];
let originalVerbose;
let originalUploadStage;

afterEach(() => {
  if (originalUploadStage !== undefined) {
    process.env.OPENCLI_UPLOAD_STAGE = originalUploadStage;
  } else {
    delete process.env.OPENCLI_UPLOAD_STAGE;
  }
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  originalVerbose = process.env.OPENCLI_VERBOSE;
  delete process.env.OPENCLI_VERBOSE;
  originalUploadStage = process.env.OPENCLI_UPLOAD_STAGE;
  // Force no Windows staging so tests creating large sparse files never copy fixtures.
  process.env.OPENCLI_UPLOAD_STAGE = '0';
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

function tmpSparseFile(name, sizeBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cga-sparse-'));
  temps.push(dir);
  const filePath = path.join(dir, name);
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
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

  // Verifies that passing >20 attachment paths is rejected upfront before staging or checking filesystem existence.
  it('rejects >20 parsed attachment entries before staging without inspecting filesystem', () => {
    // 21 non-existent dummy paths: if existence were checked or staging were attempted, it would fail with "File not found"
    const paths = Array.from({ length: 21 }, (_, i) => `/nonexistent/path/item-${i + 1}.png`);
    const out = prepareLocalFiles(paths);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Too many attachments/i);
    expect(out.reason).toContain('21');
    expect(out.reason).toContain('20');
    expect(out.reason).not.toMatch(/File not found/);
  });

  // Verifies that >20 attachment entries passed via a single comma-separated string are rejected before staging.
  it('rejects >20 attachment entries passed as comma-separated paths before staging', () => {
    const items = Array.from({ length: 25 }, (_, i) => `/nonexistent/item-${i}.txt`).join(',');
    const out = prepareLocalFiles(items);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Too many attachments/i);
    expect(out.reason).toContain('25');
  });

  // Verifies that exactly 20 valid attachments are accepted without exceeding the count limit.
  it('accepts exactly 20 valid attachments', () => {
    const files = Array.from({ length: 20 }, (_, i) => tmpFileWithContent(`file-${i}.txt`, 'test'));
    const out = prepareLocalFiles(files);
    expect(out.ok).toBe(true);
    expect(out.files).toHaveLength(20);
  });

  // Verifies the exact 20 MiB boundary for image files: 20 MiB is allowed, 20 MiB + 1 byte is rejected.
  it('enforces 20 MiB boundary for image files using sparse files', () => {
    const limit = IMAGE_MAX_SIZE_BYTES;
    const okImg = tmpSparseFile('photo.png', limit);
    const okRes = prepareLocalFiles(okImg);
    expect(okRes.ok).toBe(true);

    const tooBigImg = tmpSparseFile('large.jpg', limit + 1);
    const errRes = prepareLocalFiles(tooBigImg);
    expect(errRes.ok).toBe(false);
    expect(errRes.reason).toMatch(/File too large/i);
    expect(errRes.reason).toContain('20 MiB');
  });

  // Verifies that the 20 MiB image limit applies across all supported image extensions case-insensitively.
  it('applies 20 MiB limit across supported image extensions case-insensitively', () => {
    const limit = IMAGE_MAX_SIZE_BYTES;
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.PNG', '.JPG']) {
      const file = tmpSparseFile(`img${ext}`, limit + 1);
      const res = prepareLocalFiles(file);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/File too large/i);
    }
  });

  // Verifies the exact 50 MiB boundary for CSV and spreadsheet files: 50 MiB is allowed, 50 MiB + 1 byte is rejected.
  it('enforces 50 MiB boundary for CSV and spreadsheet files using sparse files', () => {
    const limit = SPREADSHEET_MAX_SIZE_BYTES;
    const okCsv = tmpSparseFile('table.csv', limit);
    const okRes = prepareLocalFiles(okCsv);
    expect(okRes.ok).toBe(true);

    const tooBigCsv = tmpSparseFile('big_table.csv', limit + 1);
    const errRes = prepareLocalFiles(tooBigCsv);
    expect(errRes.ok).toBe(false);
    expect(errRes.reason).toMatch(/File too large/i);
    expect(errRes.reason).toContain('50 MiB');
  });

  // Verifies that the 50 MiB limit applies across all spreadsheet extensions (.csv, .tsv, .xls, .xlsx).
  it('applies 50 MiB limit across spreadsheet extensions (.csv, .tsv, .xls, .xlsx)', () => {
    const limit = SPREADSHEET_MAX_SIZE_BYTES;
    for (const ext of ['.csv', '.tsv', '.xls', '.xlsx']) {
      const file = tmpSparseFile(`data${ext}`, limit + 1);
      const res = prepareLocalFiles(file);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/File too large/i);
    }
  });

  // Verifies the exact 512 MiB boundary for general files (.pdf, .bin, etc.): 512 MiB is allowed, 512 MiB + 1 byte is rejected.
  it('enforces 512 MiB boundary for all other files using sparse files', () => {
    const limit = DEFAULT_MAX_SIZE_BYTES;
    const okDoc = tmpSparseFile('doc.pdf', limit);
    const okRes = prepareLocalFiles(okDoc);
    expect(okRes.ok).toBe(true);

    const tooBigDoc = tmpSparseFile('huge.pdf', limit + 1);
    const errRes = prepareLocalFiles(tooBigDoc);
    expect(errRes.ok).toBe(false);
    expect(errRes.reason).toMatch(/File too large/i);
    expect(errRes.reason).toContain('512 MiB');
  });

  // Verifies that document token limits (~2M tokens) are left service-side and text files within 512 MiB are not read or tokenized locally.
  it('leaves 2M-token document limit service-side without tokenizing or reading content', () => {
    const textFile = tmpSparseFile('large_text.txt', 100 * 1024 * 1024);
    const res = prepareLocalFiles(textFile);
    expect(res.ok).toBe(true);
  });

  // Verifies that relative paths are accepted internally and resolved via path.resolve for backward compatibility.
  it('resolves relative paths via path.resolve for backward compatibility', () => {
    const file = tmpFileWithContent('relative-test.txt', 'relative');
    const relativePath = path.relative(process.cwd(), file);
    const out = prepareLocalFiles(relativePath);
    expect(out.ok).toBe(true);
    expect(out.files[0].sourcePath).toBe(path.resolve(relativePath));
  });

  // Verifies getMaxFileSize helper correctly routes file types to their size limits.
  it('returns correct max file size for various file paths', () => {
    expect(getMaxFileSize('photo.png')).toBe(IMAGE_MAX_SIZE_BYTES);
    expect(getMaxFileSize('photo.JPEG')).toBe(IMAGE_MAX_SIZE_BYTES);
    expect(getMaxFileSize('sheet.csv')).toBe(SPREADSHEET_MAX_SIZE_BYTES);
    expect(getMaxFileSize('sheet.xlsx')).toBe(SPREADSHEET_MAX_SIZE_BYTES);
    expect(getMaxFileSize('doc.pdf')).toBe(DEFAULT_MAX_SIZE_BYTES);
    expect(getMaxFileSize('README')).toBe(DEFAULT_MAX_SIZE_BYTES);
  });
});

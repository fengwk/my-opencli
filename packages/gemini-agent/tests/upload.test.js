import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareLocalFiles, uploadComposerFiles } from '../src/upload.js';

const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpFile(name, content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-upload-'));
  temps.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function tmpSparseFile(name, sizeInBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-upload-sparse-'));
  temps.push(dir);
  const filePath = path.join(dir, name);
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, Math.floor(sizeInBytes));
  fs.closeSync(fd);
  return filePath;
}

describe('prepareLocalFiles', () => {
  it('resolves existing files and rejects missing paths', () => {
    const filePath = tmpFile('notes.txt', 'hello');
    const ok = prepareLocalFiles(filePath);
    expect(ok.ok).toBe(true);
    expect(ok.files[0].name).toBe('notes.txt');

    const missing = prepareLocalFiles(path.join(dirOf(filePath), 'nope.txt'));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/File not found/);
  });

  // Rejects directories to satisfy that only regular files can be attached.
  it('rejects directory paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-dir-'));
    temps.push(dir);
    const result = prepareLocalFiles(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Not a file/);
  });

  // Contract requirement: at most 10 parsed attachment entries per turn; reject >10 before staging.
  it('rejects more than 10 parsed attachment entries before staging', () => {
    const elevenFiles = Array.from({ length: 11 }, (_, i) => tmpFile(`doc-${i + 1}.txt`, 'x'));
    const arrayResult = prepareLocalFiles(elevenFiles);
    expect(arrayResult.ok).toBe(false);
    expect(arrayResult.reason).toMatch(/Too many attachments/i);
    expect(arrayResult.reason).toMatch(/11 files/);
    expect(arrayResult.reason).toMatch(/10/);

    const commaResult = prepareLocalFiles(elevenFiles.join(','));
    expect(commaResult.ok).toBe(false);
    expect(commaResult.reason).toMatch(/Too many attachments/i);

    // Verify rejection happens before staging/existence checking by passing 11 non-existent paths
    const nonExistent = Array.from({ length: 11 }, (_, i) => `/tmp/does-not-exist-${i}.txt`);
    const preStageResult = prepareLocalFiles(nonExistent);
    expect(preStageResult.ok).toBe(false);
    expect(preStageResult.reason).toMatch(/Too many attachments/i);
  });

  // Contract requirement: accept up to 10 parsed attachment entries.
  it('accepts up to 10 valid attachment entries', () => {
    const tenFiles = Array.from({ length: 10 }, (_, i) => tmpFile(`doc-${i + 1}.txt`, 'content'));
    const result = prepareLocalFiles(tenFiles);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(10);
  });

  // Contract requirement: ordinary files larger than 100 MiB must be rejected.
  it('rejects ordinary files larger than 100 MiB', () => {
    const sparsePdf = tmpSparseFile('report.pdf', 101 * 1024 * 1024);
    const result = prepareLocalFiles(sparsePdf);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/File too large/i);
    expect(result.reason).toMatch(/100 MB/);
  });

  // Contract requirement: unknown extensions remain in the 100 MiB class.
  it('rejects unknown file extensions larger than 100 MiB', () => {
    const customFile = tmpSparseFile('data.customext', 101 * 1024 * 1024);
    const result = prepareLocalFiles(customFile);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/File too large/i);
  });

  // Contract requirement: ordinary files within 100 MiB are accepted.
  it('accepts ordinary files within 100 MiB', () => {
    const prevStage = process.env.OPENCLI_UPLOAD_STAGE;
    process.env.OPENCLI_UPLOAD_STAGE = '0';
    try {
      const validDoc = tmpSparseFile('book.pdf', 100 * 1024 * 1024);
      const result = prepareLocalFiles(validDoc);
      expect(result.ok).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('book.pdf');
    } finally {
      if (prevStage === undefined) {
        delete process.env.OPENCLI_UPLOAD_STAGE;
      } else {
        process.env.OPENCLI_UPLOAD_STAGE = prevStage;
      }
    }
  });

  // Contract requirement: common video files up to 2 GiB are permitted, even when >100 MiB.
  it('accepts common video files larger than 100 MiB up to 2 GiB', () => {
    const prevStage = process.env.OPENCLI_UPLOAD_STAGE;
    process.env.OPENCLI_UPLOAD_STAGE = '0';
    try {
      const videoMp4 = tmpSparseFile('screencast.mp4', 500 * 1024 * 1024);
      const resMp4 = prepareLocalFiles(videoMp4);
      expect(resMp4.ok).toBe(true);
      expect(resMp4.files).toHaveLength(1);
      expect(resMp4.files[0].name).toBe('screencast.mp4');

      const videoMkv = tmpSparseFile('clip.mkv', 150 * 1024 * 1024);
      const resMkv = prepareLocalFiles(videoMkv);
      expect(resMkv.ok).toBe(true);
      expect(resMkv.files).toHaveLength(1);
      expect(resMkv.files[0].name).toBe('clip.mkv');
    } finally {
      if (prevStage === undefined) {
        delete process.env.OPENCLI_UPLOAD_STAGE;
      } else {
        process.env.OPENCLI_UPLOAD_STAGE = prevStage;
      }
    }
  });

  // Contract requirement: video files exceeding 2 GiB must be rejected.
  it('rejects video files larger than 2 GiB', () => {
    const prevStage = process.env.OPENCLI_UPLOAD_STAGE;
    process.env.OPENCLI_UPLOAD_STAGE = '0';
    try {
      const hugeVideo = tmpSparseFile('giant-movie.mp4', 2 * 1024 * 1024 * 1024 + 1024 * 1024);
      const result = prepareLocalFiles(hugeVideo);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/File too large/i);
      expect(result.reason).toMatch(/2 GB/);
    } finally {
      if (prevStage === undefined) {
        delete process.env.OPENCLI_UPLOAD_STAGE;
      } else {
        process.env.OPENCLI_UPLOAD_STAGE = prevStage;
      }
    }
  });
});

function dirOf(filePath) {
  return path.dirname(filePath);
}

describe('uploadComposerFiles', () => {
  it('uses setFileInput with a file input selector and does not evaluate DataTransfer', async () => {
    const filePath = tmpFile('brief.md', '# brief');
    const prepared = prepareLocalFiles(filePath);
    const setFileInput = vi.fn(async () => {});
    const evaluate = vi.fn(async (script) => {
      if (typeof script !== 'string') return undefined;
      if (script.includes("querySelectorAll('uploader-file-preview')")) {
        return { named: 1, count: 1, errorCount: 0, loadingCount: 0 };
      }
      if (script.includes('input[type="file"]')) return { count: 1, inputs: [{ i: 0, id: '' }] };
      return undefined;
    });
    const page = { setFileInput, evaluate, sleep: vi.fn(async () => {}) };
    const result = await uploadComposerFiles(page, prepared.files);
    expect(result.ok).toBe(true);
    expect(setFileInput).toHaveBeenCalled();
    expect(setFileInput.mock.calls[0][0]).toEqual([prepared.files[0].browserPath]);
    expect(String(setFileInput.mock.calls[0][1])).toContain('input[type="file"]');
    expect(evaluate.mock.calls.some(([script]) => String(script).includes('DataTransfer'))).toBe(false);
    expect(evaluate.mock.calls.filter(([script]) => (
      String(script).includes("querySelectorAll('uploader-file-preview')")
    ))).toHaveLength(2);
  });

  it('accepts a healthy preview while Gemini continues processing a large attachment', async () => {
    const filePath = tmpFile('long-image-name.jpg', 'image');
    const prepared = prepareLocalFiles(filePath);
    const page = {
      setFileInput: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        if (String(script).includes("querySelectorAll('uploader-file-preview')")) {
          return { named: 0, count: 1, errorCount: 0, loadingCount: 1 };
        }
        if (String(script).includes('input[type="file"]')) {
          return { count: 1, inputs: [{ i: 0, id: '' }] };
        }
        return undefined;
      }),
      sleep: vi.fn(async () => {}),
    };

    await expect(uploadComposerFiles(page, prepared.files)).resolves.toMatchObject({
      ok: true,
      files: ['long-image-name.jpg'],
    });
  });

  it('rejects a structurally detected Gemini upload-error preview', async () => {
    const filePath = tmpFile('broken.txt', 'content');
    const prepared = prepareLocalFiles(filePath);
    const page = {
      setFileInput: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        if (String(script).includes("querySelectorAll('uploader-file-preview')")) {
          return { named: 1, count: 1, errorCount: 1, loadingCount: 0 };
        }
        if (String(script).includes('input[type="file"]')) {
          return { count: 1, inputs: [{ i: 0, id: '' }] };
        }
        return undefined;
      }),
      sleep: vi.fn(async () => {}),
    };

    const result = await uploadComposerFiles(page, prepared.files);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('upload-error state'),
    });
  });
});

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

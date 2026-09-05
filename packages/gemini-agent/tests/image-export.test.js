import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  downloadTurnImagesViaDom,
  exportTurnImages,
  resolveImageOutputDir,
} from '../src/image-export.js';

const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OPENCLI_UPLOAD_STAGE;
  delete process.env.OPENCLI_IMAGE_DIR_WIN;
});

describe('resolveImageOutputDir', () => {
  it('defaults to ~/Pictures/gemini-agent and expands ~/', () => {
    process.env.OPENCLI_UPLOAD_STAGE = '0';
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-op-'));
    temps.push(custom);
    expect(resolveImageOutputDir('')).toBe(path.join(os.homedir(), 'Pictures', 'gemini-agent'));
    expect(resolveImageOutputDir('~/tmp/gemini-out')).toBe(path.join(os.homedir(), 'tmp', 'gemini-out'));
    expect(resolveImageOutputDir(custom)).toBe(path.resolve(custom));
  });
});

describe('generated image download', () => {
  it('arms Browser Bridge download wait before clicking the structural Gemini control', async () => {
    const order = [];
    const scripts = [];
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-image-download-'));
    temps.push(outputDir);
    const page = {
      sleep: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        scripts.push(String(script));
        return {
          targets: [{
            nth: 2,
            url: 'https://lh3.googleusercontent.com/gg/rendered=s1024-rj',
            width: 1024,
            height: 434,
          }],
          buttonCount: 3,
        };
      }),
      waitForDownload: vi.fn(async () => {
        order.push('wait');
        return {
          downloaded: true,
          filename: '/tmp/Gemini_Generated_Image.jpg',
          mime: 'image/jpeg',
          totalBytes: 1234,
          state: 'complete',
        };
      }),
      click: vi.fn(async (selector, opts) => {
        order.push('click');
        expect(selector).toBe('[data-test-id="download-generated-image-button"] button');
        expect(opts).toEqual({ nth: 2 });
      }),
    };

    const result = await exportTurnImages(page, {
      beforeUrls: ['https://lh3.googleusercontent.com/gg/older=s1024-rj'],
      protocolUrls: ['https://lh3.googleusercontent.com/gg-dl/full-size'],
      outputDir,
      settleMs: 0,
    });

    expect(order).toEqual(['wait', 'click']);
    expect(result).toEqual([
      expect.objectContaining({
        kind: 'image-export',
        clicked: true,
        downloaded: true,
        path: '/tmp/Gemini_Generated_Image.jpg',
        mimeType: 'image/jpeg',
        width: 1024,
        height: 434,
      }),
    ]);
    expect(scripts.join('\n')).toContain('[data-test-id=\\"download-generated-image-button\\"] button');
    expect(scripts.join('\n')).not.toMatch(/aria-label|gemtooltip/);
  });

  it('returns no DOM downloads when Browser Bridge lacks the download lifecycle API', async () => {
    await expect(downloadTurnImagesViaDom({
      evaluate: vi.fn(),
      click: vi.fn(),
    })).resolves.toEqual([]);
  });
});

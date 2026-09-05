import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectDownloadsToOutputDir } from '../src/artifact-collect.js';

const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectDownloadsToOutputDir', () => {
  it('copies a completed generated-image download into the managed output directory', () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-download-source-'));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-download-output-'));
    temps.push(sourceDir, outputDir);
    const source = path.join(sourceDir, 'Gemini_Generated_Image.jpg');
    fs.writeFileSync(source, 'image-bytes');

    const [result] = collectDownloadsToOutputDir([{
      kind: 'image-export',
      downloaded: true,
      path: source,
    }], outputDir);

    expect(result).toMatchObject({
      kind: 'image-export',
      downloaded: true,
      collected: true,
      collectedFrom: source,
      bytes: 11,
    });
    expect(result.path).toBe(path.join(outputDir, 'Gemini_Generated_Image.jpg'));
    expect(fs.readFileSync(result.path, 'utf8')).toBe('image-bytes');
  });
});

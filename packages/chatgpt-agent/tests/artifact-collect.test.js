import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectDownloadEntry, collectDownloadsToOutputDir } from '../src/artifact-collect.js';

const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('artifact-collect', () => {
  // Browser downloads finish outside --op; collect them into the managed directory.
  it('copies a completed download into the managed output directory', () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-src-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-out-'));
    temps.push(srcDir, outDir);
    const source = path.join(srcDir, 'report.json');
    fs.writeFileSync(source, '{"ok":true}\n', 'utf8');

    const collected = collectDownloadEntry({
      name: 'report.json',
      downloaded: true,
      path: source,
    }, outDir);

    expect(collected.downloaded).toBe(true);
    expect(collected.collected).toBe(true);
    expect(collected.collectedFrom).toBe(source);
    expect(collected.path.startsWith(outDir + path.sep)).toBe(true);
    expect(fs.readFileSync(collected.path, 'utf8')).toContain('"ok":true');
  });

  it('leaves non-file entries unchanged', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-out-'));
    temps.push(outDir);
    const entry = { downloaded: false, error: 'no-file-chip' };
    expect(collectDownloadsToOutputDir([entry], outDir)).toEqual([entry]);
  });
});

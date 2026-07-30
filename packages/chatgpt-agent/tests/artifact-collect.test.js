import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectDownloadEntry,
  collectDownloadsToOutputDir,
  toNodeLocalPath,
} from '../src/artifact-collect.js';

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
    expect(collected.bytes).toBe(fs.statSync(source).size);
    expect(collected.path.startsWith(outDir + path.sep)).toBe(true);
    expect(fs.readFileSync(collected.path, 'utf8')).toContain('"ok":true');
  });

  // Windows Chrome reports C:\...; WSL Node must remap before copy.
  it('collects Windows Chrome download paths via WSL mount mapping', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-out-'));
    temps.push(outDir);

    // Prefer a real file under /mnt/c when available; otherwise unit-test mapping only.
    const winProbe = '/mnt/c/Users';
    if (!fs.existsSync(winProbe)) {
      expect(toNodeLocalPath('C:\\Users\\fengwk\\Downloads\\a.json')).toBe(
        '/mnt/c/Users/fengwk/Downloads/a.json',
      );
      return;
    }

    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-src-'));
    temps.push(srcDir);
    const source = path.join(srcDir, 'win-report.json');
    fs.writeFileSync(source, '{"wsl":true}\n', 'utf8');

    // Simulate Chrome reporting a Windows path that maps to an existing node path.
    // Use a synthetic Windows path only when source is already under /mnt/c.
    const underMount = source.startsWith('/mnt/c/');
    if (!underMount) {
      // Still verify pure mapping helper.
      expect(toNodeLocalPath(
        'C:\\Users\\fengwk\\Downloads\\jimeng-demo.mp4',
        { path: { sep: '/', join: (...parts) => parts.join('/').replace(/\/+/g, '/'), normalize: (p) => p } },
      )).toBe('/mnt/c/Users/fengwk/Downloads/jimeng-demo.mp4');
      // And collect still works for posix absolute paths.
      const collected = collectDownloadEntry({
        name: 'win-report.json',
        downloaded: true,
        path: source,
      }, outDir);
      expect(collected.collected).toBe(true);
      expect(collected.path.startsWith(outDir + path.sep)).toBe(true);
      return;
    }

    const drive = source.match(/^\/mnt\/([a-z])\//i)?.[1]?.toUpperCase() || 'C';
    const rest = source.replace(/^\/mnt\/[a-z]\//i, '').replace(/\//g, '\\');
    const windowsPath = `${drive}:\\${rest}`;
    const collected = collectDownloadEntry({
      name: 'win-report.json',
      downloaded: true,
      path: windowsPath,
    }, outDir);
    expect(collected.collected).toBe(true);
    expect(collected.collectedFrom).toBe(source);
    expect(collected.path.startsWith(outDir + path.sep)).toBe(true);
    expect(fs.readFileSync(collected.path, 'utf8')).toContain('"wsl":true');
  });

  it('maps Windows paths to node-local paths under POSIX', () => {
    expect(toNodeLocalPath(
      'C:\\Users\\fengwk\\Downloads\\jimeng-demo.mp4',
      { path: { sep: '/', join: (...parts) => parts.join('/').replace(/\/+/g, '/'), normalize: (p) => p } },
    )).toBe('/mnt/c/Users/fengwk/Downloads/jimeng-demo.mp4');
    expect(toNodeLocalPath('/tmp/already-posix.mp4')).toBe('/tmp/already-posix.mp4');
    expect(toNodeLocalPath('')).toBe('');
  });

  it('leaves non-file entries unchanged', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-out-'));
    temps.push(outDir);
    const entry = { downloaded: false, error: 'no-file-chip' };
    expect(collectDownloadsToOutputDir([entry], outDir)).toEqual([entry]);
  });
});

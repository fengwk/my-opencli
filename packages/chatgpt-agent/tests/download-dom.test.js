import { describe, expect, it } from 'vitest';
import { collectExpectedFileNames, enrichFilesFromText } from './download-dom.js';

describe('download-dom helpers', () => {
  it('pulls file names only from sandbox protocol links', () => {
    const names = collectExpectedFileNames({
      text: '请查收 [下载 hello.json](sandbox:/mnt/data/hello.json)',
      files: [],
    });
    expect(names).toEqual(['hello.json']);
  });

  // Bare filename in prose must NOT trigger download.
  it('ignores bare filename mentions without sandbox protocol', () => {
    const names = collectExpectedFileNames({
      text: '记得，就是刚才那个可下载的 `demo-hello.json` 文件。',
      files: [],
    });
    expect(names).toEqual([]);
  });

  it('accepts Chinese filenames in sandbox links', () => {
    const names = collectExpectedFileNames({
      text: '[下载 测试结果.json](sandbox:/mnt/data/测试结果.json)',
      files: [],
    });
    expect(names).toEqual(['测试结果.json']);
  });

  // Prefer decode only when needed; first successful name is enough.
  it('decodes percent-encoded sandbox basenames', () => {
    const encoded = encodeURIComponent('测试结果.json');
    const names = collectExpectedFileNames({
      text: `[下载](sandbox:/mnt/data/${encoded})`,
      files: [],
    });
    expect(names).toEqual(['测试结果.json']);
  });

  it('accepts filenames with spaces', () => {
    const names = collectExpectedFileNames({
      text: '[下载 docker notes.md](sandbox:/mnt/data/docker notes.md)',
      files: [],
    });
    expect(names).toEqual(['docker notes.md']);
  });

  it('enriches files metadata from text sandbox links', () => {
    const out = enrichFilesFromText({
      text: '[下载 hello.json](sandbox:/mnt/data/hello.json)',
      files: [{ name: 'demo-hello', sandboxPath: '/mnt/data/demo-hello', status: 'x' }],
    });
    expect(out.files.map((f) => f.name)).toEqual(['hello.json']);
  });
});

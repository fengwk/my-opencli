import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isWslEnv,
  needsWindowsUploadStaging,
  stageReferenceUploadAliases,
  stageForBrowserUpload,
  toBrowserLocalPath,
} from '../src/upload-paths.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('jimeng-agent/upload-paths — browser-visible path handling', () => {
  it('maps a mounted Windows drive path to a Windows browser path', () => {
    expect(toBrowserLocalPath('/mnt/c/Users/fengwk/Documents/角色.png', {
      needsWindowsUploadStaging: true,
    })).toBe('C:\\Users\\fengwk\\Documents\\角色.png');
  });

  it('keeps POSIX paths when staging is disabled', () => {
    const source = '/home/alice/assets/角色.png';
    expect(toBrowserLocalPath(source, { needsWindowsUploadStaging: false }))
      .toBe(source);
  });

  it('does not stage files already on a mounted Windows drive', () => {
    const result = stageForBrowserUpload('/mnt/c/Users/fengwk/Documents/IP/test.mp4', {
      needsWindowsUploadStaging: true,
    });
    expect(result).toEqual({
      sourcePath: '/mnt/c/Users/fengwk/Documents/IP/test.mp4',
      nodePath: '/mnt/c/Users/fengwk/Documents/IP/test.mp4',
      browserPath: 'C:\\Users\\fengwk\\Documents\\IP\\test.mp4',
      name: 'test.mp4',
      staged: false,
    });
  });

  it('stages a non-mounted file once and returns its browser-visible path', () => {
    const sourceDir = tempDir('jimeng-upload-source-');
    const downloads = tempDir('jimeng-upload-downloads-');
    const source = path.join(sourceDir, 'voice.mp3');
    fs.writeFileSync(source, 'audio-bytes');

    const result = stageForBrowserUpload(source, {
      needsWindowsUploadStaging: true,
      windowsDownloadsDir: downloads,
      toBrowserLocalPath: undefined,
    });

    const expectedNodePath = path.join(downloads, 'opencli-upload', 'voice.mp3');
    expect(result.sourcePath).toBe(source);
    expect(result.nodePath).toBe(expectedNodePath);
    expect(result.name).toBe('voice.mp3');
    expect(result.staged).toBe(true);
    expect(fs.readFileSync(expectedNodePath, 'utf8')).toBe('audio-bytes');
  });

  it('recognizes explicit staging overrides without depending on host detection', () => {
    expect(needsWindowsUploadStaging({
      env: { OPENCLI_UPLOAD_STAGE: '0' },
      fs: { existsSync: () => true },
    })).toBe(false);
    expect(needsWindowsUploadStaging({
      env: { OPENCLI_UPLOAD_STAGE: '1' },
      fs: { existsSync: (candidate) => candidate === '/mnt/c/Users' },
    })).toBe(true);
  });

  it('uses WSL markers before reading /proc/version', () => {
    const fsImpl = {
      readFileSync: () => {
        throw new Error('should not read /proc');
      },
    };
    expect(isWslEnv({ WSL_DISTRO_NAME: 'Ubuntu' }, fsImpl)).toBe(true);
  });

  it('copies label-named aliases into one disposable directory and cleans it up', () => {
    const sourceDir = tempDir('jimeng-alias-source-');
    const aliasRoot = tempDir('jimeng-alias-root-');
    const image = path.join(sourceDir, '人物三视图.png');
    const video = path.join(sourceDir, '动作参考.mp4');
    fs.writeFileSync(image, 'image-bytes');
    fs.writeFileSync(video, 'video-bytes');

    const result = stageReferenceUploadAliases([
      {
        label: '图片1',
        filename: '人物三视图.png',
        nodePath: image,
        browserPath: image,
        staged: false,
      },
      {
        label: '视频1',
        filename: '动作参考.mp4',
        nodePath: video,
        browserPath: video,
        staged: false,
      },
    ], {
      needsWindowsUploadStaging: false,
      referenceAliasRoot: aliasRoot,
    });

    expect(result.assets.map((asset) => asset.uploadFilename)).toEqual(['图片1.png', '视频1.mp4']);
    expect(result.assets.map((asset) => path.basename(asset.nodePath))).toEqual(['图片1.png', '视频1.mp4']);
    expect(fs.readFileSync(result.assets[0].nodePath, 'utf8')).toBe('image-bytes');
    expect(fs.readFileSync(result.assets[1].nodePath, 'utf8')).toBe('video-bytes');
    expect(result.assets.every((asset) => asset.browserPath === asset.nodePath)).toBe(true);

    result.cleanup();
    result.cleanup();
    expect(fs.existsSync(result.directory)).toBe(false);
  });

  it('honors an explicit environment alias root for a nonstandard browser filesystem namespace', () => {
    const sourceDir = tempDir('jimeng-alias-env-source-');
    const aliasRoot = tempDir('jimeng-alias-env-root-');
    const source = path.join(sourceDir, 'reference.png');
    fs.writeFileSync(source, 'image-bytes');

    const result = stageReferenceUploadAliases([{
      label: '图片1',
      filename: 'reference.png',
      nodePath: source,
      browserPath: source,
      staged: false,
    }], {
      env: {
        OPENCLI_UPLOAD_STAGE: '0',
        OPENCLI_JIMENG_UPLOAD_ALIAS_ROOT: aliasRoot,
      },
    });

    expect(result.directory.startsWith(aliasRoot + path.sep)).toBe(true);
    expect(result.assets[0].uploadFilename).toBe('图片1.png');
    result.cleanup();
    expect(fs.existsSync(result.directory)).toBe(false);
  });
});

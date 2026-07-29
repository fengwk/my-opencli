/**
 * Browser-visible local paths for OpenCLI file inputs.
 *
 * Windows Chrome cannot consume WSL POSIX paths through CDP. Files already
 * mounted under /mnt/<drive> are translated to drive paths; other WSL files
 * are staged in the Windows Downloads directory before upload.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isWslEnv(env = process.env, fsImpl = fs) {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(fsImpl.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function needsWindowsUploadStaging(options = {}) {
  const env = options.env ?? process.env;
  const fsImpl = options.fs ?? fs;
  const forced = String(env.OPENCLI_UPLOAD_STAGE ?? '').trim().toLowerCase();
  if (forced === '0' || forced === 'false') return false;
  if (forced === '1' || forced === 'true') return fsImpl.existsSync('/mnt/c/Users');
  return isWslEnv(env, fsImpl) && fsImpl.existsSync('/mnt/c/Users');
}

export function toBrowserLocalPath(filePath, options = {}) {
  const pathImpl = options.path ?? path;
  const staging = options.needsWindowsUploadStaging ?? needsWindowsUploadStaging(options);
  const resolved = pathImpl.resolve(filePath);
  if (staging) {
    const mountedDrive = resolved.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (mountedDrive) {
      return `${mountedDrive[1].toUpperCase()}:\\${mountedDrive[2].replace(/\//g, '\\')}`;
    }
  }
  return resolved;
}

function windowsDownloadsDir(options) {
  if (options.windowsDownloadsDir !== undefined) return options.windowsDownloadsDir;

  const fsImpl = options.fs ?? fs;
  const env = options.env ?? process.env;
  const usersRoot = '/mnt/c/Users';
  if (!fsImpl.existsSync(usersRoot)) return null;

  const excluded = new Set(['Public', 'Default', 'Default User', 'All Users', 'desktop.ini']);
  let names;
  try {
    names = fsImpl.readdirSync(usersRoot).filter((name) => {
      try {
        return !excluded.has(name) && fsImpl.statSync(path.join(usersRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }

  const preferred = String(env.WINDOWS_USER ?? env.USER ?? '').toLowerCase();
  const candidates = [
    ...names.filter((name) => name.toLowerCase() === preferred),
    ...names.filter((name) => fsImpl.existsSync(path.join(usersRoot, name, 'Downloads'))),
  ];
  const selected = candidates[0] ?? names[0];
  if (!selected) return null;
  const downloads = path.join(usersRoot, selected, 'Downloads');
  return fsImpl.existsSync(downloads) ? downloads : null;
}

/**
 * Return a browser-readable path without changing the source reference.
 *
 * @returns {{
 *   sourcePath: string,
 *   nodePath: string,
 *   browserPath: string,
 *   name: string,
 *   staged: boolean,
 * }}
 */
export function stageForBrowserUpload(sourcePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  const pathImpl = options.path ?? path;
  const resolved = pathImpl.resolve(sourcePath);
  const name = pathImpl.basename(resolved);
  const staging = options.needsWindowsUploadStaging ?? needsWindowsUploadStaging(options);

  if (!staging) {
    return {
      sourcePath: resolved,
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved, { ...options, needsWindowsUploadStaging: false }),
      name,
      staged: false,
    };
  }

  if (/^\/mnt\/[a-z]\//i.test(resolved)) {
    return {
      sourcePath: resolved,
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved, { ...options, needsWindowsUploadStaging: true }),
      name,
      staged: false,
    };
  }

  const downloads = windowsDownloadsDir(options);
  if (!downloads) {
    return {
      sourcePath: resolved,
      nodePath: resolved,
      browserPath: toBrowserLocalPath(resolved, { ...options, needsWindowsUploadStaging: true }),
      name,
      staged: false,
    };
  }

  const stagingDir = pathImpl.join(downloads, 'opencli-upload');
  fsImpl.mkdirSync(stagingDir, { recursive: true });
  const stagedPath = pathImpl.join(stagingDir, name);

  let needsCopy = true;
  try {
    const sourceStat = fsImpl.statSync(resolved);
    const stagedStat = fsImpl.statSync(stagedPath);
    needsCopy = sourceStat.size !== stagedStat.size || sourceStat.mtimeMs !== stagedStat.mtimeMs;
  } catch {
    needsCopy = true;
  }
  if (needsCopy) fsImpl.copyFileSync(resolved, stagedPath);

  return {
    sourcePath: resolved,
    nodePath: stagedPath,
    browserPath: toBrowserLocalPath(stagedPath, { ...options, needsWindowsUploadStaging: true }),
    name,
    staged: true,
  };
}

/**
 * Copy prepared browser-readable files into one disposable directory whose
 * basenames match Jimeng's public @ labels. Jimeng derives its mention names
 * from uploaded filenames, so `人物.png` must become `图片1.png` for `@图片1`.
 *
 * The returned cleanup is idempotent and owns only the unique directory it
 * created. Call it after the browser has finished processing the references.
 */
export function stageReferenceUploadAliases(assets, options = {}) {
  if (!Array.isArray(assets)) {
    throw new TypeError('assets must be an array');
  }
  if (assets.length === 0) {
    return {
      assets: [],
      cleanup: () => {},
      directory: null,
    };
  }

  const fsImpl = options.fs ?? fs;
  const pathImpl = options.path ?? path;
  const staging = options.needsWindowsUploadStaging ?? needsWindowsUploadStaging(options);
  const root = resolveReferenceAliasRoot(options, staging, pathImpl);
  fsImpl.mkdirSync(root, { recursive: true });
  const directory = fsImpl.mkdtempSync(pathImpl.join(root, 'jimeng-agent-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fsImpl.rmSync(directory, { recursive: true, force: true });
  };

  try {
    const names = new Set();
    const aliased = assets.map((asset, index) => {
      if (!asset || typeof asset.nodePath !== 'string' || typeof asset.label !== 'string') {
        throw new TypeError(`asset ${index} must contain nodePath and label strings`);
      }
      const extension = pathImpl.extname(asset.filename || asset.nodePath);
      if (!extension) {
        throw new TypeError(`asset ${index} has no filename extension for its upload alias`);
      }
      const uploadFilename = `${asset.label}${extension}`;
      if (names.has(uploadFilename)) {
        throw new TypeError(`duplicate temporary upload filename '${uploadFilename}'`);
      }
      names.add(uploadFilename);

      const nodePath = pathImpl.join(directory, uploadFilename);
      fsImpl.copyFileSync(asset.nodePath, nodePath);
      const browserPathFor = options.toBrowserLocalPath ?? toBrowserLocalPath;
      return {
        ...asset,
        nodePath,
        browserPath: browserPathFor(nodePath, {
          ...options,
          path: pathImpl,
          needsWindowsUploadStaging: staging,
        }),
        uploadFilename,
        staged: true,
      };
    });
    return {
      assets: aliased,
      cleanup,
      directory,
    };
  } catch (err) {
    try {
      cleanup();
    } catch {
      // Preserve the original copy/validation failure.
    }
    throw err;
  }
}

function resolveReferenceAliasRoot(options, staging, pathImpl) {
  const env = options.env ?? process.env;
  const configuredRoot = options.referenceAliasRoot ?? env.OPENCLI_JIMENG_UPLOAD_ALIAS_ROOT;
  if (configuredRoot !== undefined && configuredRoot !== null) {
    if (typeof configuredRoot !== 'string' || configuredRoot.trim() === '') {
      throw new TypeError('referenceAliasRoot must be a non-empty absolute path in the Node filesystem namespace');
    }
    return pathImpl.resolve(configuredRoot);
  }
  if (staging) {
    const downloads = windowsDownloadsDir(options);
    if (!downloads) {
      throw new Error('Could not locate a Windows-visible temporary directory for Jimeng reference aliases');
    }
    return pathImpl.join(downloads, 'opencli-upload');
  }
  const osImpl = options.os ?? os;
  return pathImpl.join(osImpl.tmpdir(), 'opencli-upload');
}

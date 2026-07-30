/**
 * Collect browser/local download paths into a managed output directory.
 * Used so Hub (or --op) owns the final artifact location instead of Chrome Downloads.
 *
 * On WSL + Windows Chrome, waitForDownload reports `C:\Users\...\file.ext`.
 * Node cannot open that path until it is remapped to `/mnt/c/Users/.../file.ext`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeBaseName(filePath, fallback = 'artifact.bin') {
  const base = path.basename(String(filePath || '').trim().replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return fallback;
  return base.replace(/[^\w.\-()+@\u4e00-\u9fff]+/g, '_');
}

function nextAvailable(dir, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${parsed.name}_${i}${parsed.ext}`);
  }
  return candidate;
}

/**
 * Convert a Windows path reported by Chrome downloads into a Node-readable path.
 * In WSL: `C:\\Users\\a\\x.mp4` -> `/mnt/c/Users/a/x.mp4`.
 * @param {string} rawPath
 * @param {{ path?: typeof path, wslMountRoot?: string }} [options]
 * @returns {string}
 */
export function toNodeLocalPath(rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return '';
  const pathMod = options.path ?? path;
  const mountRoot = options.wslMountRoot ?? '/mnt';
  const windowsPath = rawPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (windowsPath && pathMod.sep === '/') {
    return pathMod.normalize(pathMod.join(
      mountRoot,
      windowsPath[1].toLowerCase(),
      windowsPath[2].replace(/\\/g, '/'),
    ));
  }
  return rawPath;
}

function isUsableLocalPath(candidate, pathMod = path) {
  if (!isNonEmptyString(candidate)) return false;
  if (pathMod.isAbsolute(candidate)) return true;
  // Windows absolute path while Node is running under POSIX (WSL).
  return /^[a-zA-Z]:[\\/]/.test(candidate);
}

/**
 * Copy a completed download into outputDir when the source is a local file.
 * @param {object} entry download result entry
 * @param {string} outputDir managed output directory
 * @returns {object} entry with path rewritten when collected
 */
export function collectDownloadEntry(entry, outputDir) {
  if (!entry || typeof entry !== 'object') return entry;
  if (!isNonEmptyString(outputDir)) return entry;

  const rawSourcePath = String(entry.path || entry.filename || '').trim();
  if (!isUsableLocalPath(rawSourcePath)) return entry;

  const sourcePath = toNodeLocalPath(rawSourcePath);
  if (!sourcePath || !fs.existsSync(sourcePath)) return entry;

  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return entry;
  }
  if (!stat.isFile()) return entry;

  fs.mkdirSync(outputDir, { recursive: true });
  const target = nextAvailable(outputDir, safeBaseName(sourcePath));
  // Already inside target dir with same real path — keep as-is.
  try {
    if (fs.realpathSync(sourcePath) === fs.realpathSync(path.dirname(target)) + path.sep + path.basename(sourcePath)
      && path.dirname(sourcePath) === outputDir) {
      return {
        ...entry,
        path: sourcePath,
        collected: true,
        collectedFrom: sourcePath,
        bytes: stat.size,
      };
    }
  } catch {
    // ignore realpath issues and copy
  }
  if (path.resolve(sourcePath) === path.resolve(target)) {
    return {
      ...entry,
      path: sourcePath,
      collected: true,
      collectedFrom: sourcePath,
      bytes: stat.size,
    };
  }
  fs.copyFileSync(sourcePath, target);
  let bytes = stat.size;
  try {
    bytes = fs.statSync(target).size;
  } catch {
    // keep source size
  }
  return {
    ...entry,
    path: target,
    collected: true,
    collectedFrom: sourcePath,
    bytes,
  };
}

/**
 * @param {object[]} entries
 * @param {string} outputDir
 * @returns {object[]}
 */
export function collectDownloadsToOutputDir(entries, outputDir) {
  if (!Array.isArray(entries) || !isNonEmptyString(outputDir)) {
    return Array.isArray(entries) ? entries : [];
  }
  return entries.map((entry) => collectDownloadEntry(entry, outputDir));
}

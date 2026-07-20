/**
 * Collect browser/local download paths into a managed output directory.
 * Used so Hub (or --op) owns the final artifact location instead of Chrome Downloads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeBaseName(filePath, fallback = 'artifact.bin') {
  const base = path.basename(String(filePath || '').trim());
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
 * Copy a completed download into outputDir when the source is a local file.
 * @param {object} entry download result entry
 * @param {string} outputDir managed output directory
 * @returns {object} entry with path rewritten when collected
 */
export function collectDownloadEntry(entry, outputDir) {
  if (!entry || typeof entry !== 'object') return entry;
  if (!isNonEmptyString(outputDir)) return entry;
  const sourcePath = String(entry.path || entry.filename || '').trim();
  if (!sourcePath || !path.isAbsolute(sourcePath)) return entry;
  if (!fs.existsSync(sourcePath)) return entry;
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
      return { ...entry, path: sourcePath, collected: true, collectedFrom: sourcePath };
    }
  } catch {
    // ignore realpath issues and copy
  }
  if (path.resolve(sourcePath) === path.resolve(target)) {
    return { ...entry, path: sourcePath, collected: true, collectedFrom: sourcePath };
  }
  fs.copyFileSync(sourcePath, target);
  return {
    ...entry,
    path: target,
    collected: true,
    collectedFrom: sourcePath,
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

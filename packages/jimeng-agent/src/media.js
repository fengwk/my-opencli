/**
 * jimeng-agent local media preflight.
 *
 * This module performs purely local validation: it ensures every canonical
 * reference asset resolves to a readable file on disk, matches the
 * extension allow-list for its kind, has a unique mention stem across kinds,
 * and — for video / audio — does not blow past the product-wide reference
 * duration cap.
 *
 * Critical boundary: this module does NOT upload, navigate, drive OpenCLI,
 * or generate anything. Anything past local validation belongs in a
 * browser-aware sibling module.
 *
 * Imported dependencies are intentionally minimal: Node built-ins plus the
 * `ArgumentError` class shared with the rest of the agent boundary and the
 * `MAX_REFERENCE_DURATION_SECONDS` constant already produced by contract.js.
 */

import * as defaultChildProcess from 'node:child_process';
import * as defaultFs from 'node:fs';
import * as defaultPath from 'node:path';

import { ArgumentError } from '@jackwener/opencli/errors';

import { MAX_REFERENCE_DURATION_SECONDS } from './contract.js';
import {
  stageForBrowserUpload as defaultStageForBrowserUpload,
  stageReferenceUploadAliases as defaultStageReferenceUploadAliases,
} from './upload-paths.js';

/**
 * Lower-case extensions Jimeng currently accepts as image references.
 * Order is deliberate: it matches the documented allow-list order so error
 * messages stay deterministic.
 */
export const IMAGE_EXTENSIONS = Object.freeze([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'heic',
  'heif',
  'gif',
  'tiff',
  'tif',
]);

/** Lower-case extensions Jimeng currently accepts as video references. */
export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov']);

/** Lower-case extensions Jimeng currently accepts as audio references. */
export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav']);

/**
 * Kind-keyed lookup so validation can dispatch on `asset.kind` without
 * repeating the allow-lists in code. Frozen so runtime mutation is a no-op.
 */
const KIND_TO_EXTENSIONS = Object.freeze({
  image: IMAGE_EXTENSIONS,
  video: VIDEO_EXTENSIONS,
  audio: AUDIO_EXTENSIONS,
});

const DEFAULT_FFPROBE_BIN = 'ffprobe';

const MIN_REFERENCE_DURATION_SECONDS = 2;
const MIN_REFERENCE_DURATION_MS = MIN_REFERENCE_DURATION_SECONDS * 1000;
const MAX_REFERENCE_DURATION_MS = MAX_REFERENCE_DURATION_SECONDS * 1000;

/**
 * Internal {@link Number.parseFloat} wrapper used for ffprobe's stdout.
 * Pulled into a tiny helper so the parsing-path invariants stay
 * self-documenting next to the only place that needs them.
 */
function parseDurationString(raw, filePath) {
  const text = (raw ?? '').toString().trim();
  if (text.length === 0) {
    throw new ArgumentError(
      `ffprobe returned an empty duration for '${filePath}'`,
      'The file may not be a media container ffprobe can describe.',
    );
  }
  // Do not use parseFloat here: it silently accepts malformed values such as
  // "15seconds", which would let an invalid probe result pass preflight.
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ArgumentError(
      `ffprobe returned a non-positive or invalid duration for '${filePath}': '${text}'`,
      'Reference media must expose a positive, finite duration in seconds.',
    );
  }
  return Math.ceil(seconds * 1000);
}

/**
 * Probe a media file's duration in milliseconds using `ffprobe`. The
 * invocation is intentionally synchronous and bound through
 * `child_process.execFileSync` so there is never shell interpolation on a
 * file path. The result is `Math.ceil(seconds * 1000)`; fractional values
 * round UP so a media file at the 15s cap can never silently overflow.
 *
 * @param {string} filePath absolute path to a media file on disk.
 * @param {object} [options]
 * @param {(file: string, args: string[], opts: object) => string|Buffer} [options.execFileSync]
 *        Process runner injection point. Defaults to `node:child_process.execFileSync`.
 * @param {string} [options.ffprobe] Binary name or absolute path. Defaults to `'ffprobe'`.
 * @returns {number} duration in milliseconds, rounded up via `Math.ceil`.
 * @throws {ArgumentError} on any probe failure (missing binary, non-zero exit,
 *         empty output, or non-positive / non-finite duration).
 */
export function probeMediaDurationMs(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ArgumentError(
      `Invalid filePath: expected non-empty string, got ${describeType(filePath)}`,
      'Pass a non-empty string pointing to a readable media file on disk.',
    );
  }

  const runner = options.execFileSync ?? defaultChildProcess.execFileSync;
  const ffprobeBin = options.ffprobe ?? DEFAULT_FFPROBE_BIN;

  let stdout;
  try {
    const out = runner(
      ffprobeBin,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    stdout = typeof out === 'string' || Buffer.isBuffer(out)
      ? out
      : String(out);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ArgumentError(
        `ffprobe is not installed or not on PATH (looked up '${ffprobeBin}')`,
        'Install ffmpeg so `ffprobe` is on PATH, or set options.ffprobe to a reachable binary path.',
      );
    }
    throw new ArgumentError(
      `ffprobe failed for '${filePath}': ${describeError(err)}`,
      'Verify the file is a readable media container that ffprobe can describe.',
    );
  }

  return parseDurationString(stdout, filePath);
}

/**
 * Main entry point. Given the canonical object produced by
 * `normalizeAskArgs`, validate every asset locally and return a frozen
 * preflight result with prepared records the future browser layer will
 * consume. Throws {@link ArgumentError} on any preflight failure.
 *
 * @param {object} canonical canonical payload returned by `normalizeAskArgs`.
 * @param {object} [options]
 * @param {typeof import('node:fs')} [options.fs] Filesystem injection. Defaults to `node:fs`.
 * @param {typeof import('node:path')} [options.path] Path injection. Defaults to `node:path`.
 * @param {(filePath: string, options: object) => number} [options.probe]
 *        Duration probe injection. Defaults to {@link probeMediaDurationMs}
 *        which itself honours `options.execFileSync` / `options.ffprobe`.
 * @param {(file: string, args: string[], opts: object) => string|Buffer} [options.execFileSync]
 *        Underlying process runner forwarded to the default probe.
 * @param {string} [options.ffprobe] ffprobe binary path forwarded to the default probe.
 * @returns {{
 *   assets: ReadonlyArray<object>,
 *   videoDurationMs: number,
 *   audioDurationMs: number,
 * }} frozen preflight summary.
 */
export function validateLocalReferenceAssets(canonical, options = {}) {
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new ArgumentError(
      `Invalid canonical payload: expected object, got ${describeType(canonical)}`,
      'Pass the object returned by normalizeAskArgs from ./contract.js.',
    );
  }
  if (!Array.isArray(canonical.assets)) {
    throw new ArgumentError(
      `Invalid canonical payload: 'assets' must be an array, got ${describeType(canonical.assets)}`,
      'Pass the canonical payload produced by normalizeAskArgs so it carries an assets array.',
    );
  }

  const fs = options.fs ?? defaultFs;
  const pathMod = options.path ?? defaultPath;
  const probe = options.probe ?? ((filePath) => probeMediaDurationMs(filePath, options));

  const seenMentions = new Map(); // lowercase stem -> first label
  const prepared = [];
  let videoDurationMs = 0;
  let audioDurationMs = 0;

  for (let i = 0; i < canonical.assets.length; i += 1) {
    const asset = canonical.assets[i];
    const label = describeAssetLabel(asset, i);

    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new ArgumentError(
        `Invalid asset entry at index ${i}: expected object, got ${describeType(asset)}`,
        'Each canonical asset must be an object with kind, label, index, path.',
      );
    }

    const { kind } = asset;
    const allowed = KIND_TO_EXTENSIONS[kind];
    if (!allowed) {
      throw new ArgumentError(
        `Invalid asset kind at index ${i}: '${describeType(kind)}' (must be one of image, video, audio)`,
        'Asset kinds are fixed by normalizeAskArgs; report a bug if you see this.',
      );
    }

    const rawPath = asset.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new ArgumentError(
        `Invalid asset path for ${label}: expected non-empty string, got ${describeType(rawPath)}`,
        'Each canonical asset must carry a non-empty `path`.',
      );
    }

    const sourcePath = resolveSourcePath(rawPath, pathMod, options);

    if (!fs.existsSync(sourcePath)) {
      throw new ArgumentError(
        `Asset path does not exist: '${rawPath}' (resolved to '${sourcePath}')`,
        'Make sure each --image / --video / --audio path points to an existing file on disk.',
      );
    }

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      throw new ArgumentError(
        `Could not stat '${sourcePath}': ${describeError(err)}`,
        'Ensure the file is readable and not behind a network mount that briefly disappeared.',
      );
    }

    if (!stat.isFile()) {
      throw new ArgumentError(
        `Asset path is not a regular file: '${rawPath}' (resolved to '${sourcePath}')`,
        'Directories, device nodes, and symlinks that point at directories cannot be referenced.',
      );
    }

    const filename = pathMod.basename(sourcePath);
    const ext = (pathMod.extname(sourcePath).slice(1) || '').toLowerCase();

    if (!allowed.includes(ext)) {
      throw new ArgumentError(
        `Asset extension '.${ext}' does not match kind ${kind} for '${rawPath}' (expected one of ${allowed.map((e) => '.' + e).join(', ')})`,
        `Pass a ${kind} reference whose filename extension is one of: ${allowed.join(', ')}.`,
      );
    }

    const mentionName = stripFinalExtension(filename);
    if (mentionName.length === 0) {
      throw new ArgumentError(
        `Could not derive a mention name from basename '${filename}' for ${label}`,
        'Avoid referencing files whose basename is only a leading dot (e.g. ".env").',
      );
    }
    const mentionKey = mentionName.toLowerCase();
    const firstLabel = seenMentions.get(mentionKey);
    if (firstLabel !== undefined) {
      throw new ArgumentError(
        `Duplicate reference mention name '${mentionName}' (already used by ${firstLabel}; also bound to ${label}); Jimeng's @ candidate list would treat them ambiguously.`,
        'Rename the conflicting file so each reference has a unique stem across all kinds.',
      );
    }
    seenMentions.set(mentionKey, label);

    let durationMs = null;
    if (kind === 'video' || kind === 'audio') {
      durationMs = probe(sourcePath, options);
      if (
        typeof durationMs !== 'number'
        || !Number.isFinite(durationMs)
        || !Number.isInteger(durationMs)
        || durationMs <= 0
      ) {
        throw new ArgumentError(
          `Duration probe returned an invalid value for '${sourcePath}': '${String(durationMs)}'`,
          'The duration probe must report a positive finite integer duration in milliseconds.',
        );
      }
      if (durationMs < MIN_REFERENCE_DURATION_MS) {
        throw new ArgumentError(
          `${kind === 'video' ? 'Video' : 'Audio'} reference '${sourcePath}' is ${durationMs}ms; Jimeng requires each video/audio reference to be at least ${MIN_REFERENCE_DURATION_SECONDS}s`,
          `Use a ${kind} reference whose duration is at least ${MIN_REFERENCE_DURATION_SECONDS} seconds.`,
        );
      }
      if (durationMs > MAX_REFERENCE_DURATION_MS) {
        throw new ArgumentError(
          `${kind === 'video' ? 'Video' : 'Audio'} reference '${sourcePath}' is ${durationMs}ms; Jimeng allows at most ${MAX_REFERENCE_DURATION_SECONDS}s per video/audio reference`,
          `Trim the ${kind} reference to at most ${MAX_REFERENCE_DURATION_SECONDS} seconds.`,
        );
      }
    }

    if (kind === 'video') videoDurationMs += durationMs;
    else if (kind === 'audio') audioDurationMs += durationMs;

    prepared.push(Object.freeze({
      kind,
      label,
      index: typeof asset.index === 'number' ? asset.index : i + 1,
      path: rawPath,
      sourcePath,
      filename,
      mentionName,
      durationMs,
    }));
  }

  if (videoDurationMs > MAX_REFERENCE_DURATION_MS) {
    throw new ArgumentError(
      `Total video reference duration ${videoDurationMs}ms exceeds the ${MAX_REFERENCE_DURATION_MS}ms (${MAX_REFERENCE_DURATION_SECONDS}s) product cap`,
      `Trim or shorten your --video references so the combined duration fits within ${MAX_REFERENCE_DURATION_SECONDS}s.`,
    );
  }
  if (audioDurationMs > MAX_REFERENCE_DURATION_MS) {
    throw new ArgumentError(
      `Total audio reference duration ${audioDurationMs}ms exceeds the ${MAX_REFERENCE_DURATION_MS}ms (${MAX_REFERENCE_DURATION_SECONDS}s) product cap`,
      `Trim or shorten your --audio references so the combined duration fits within ${MAX_REFERENCE_DURATION_SECONDS}s.`,
    );
  }

  return Object.freeze({
    assets: Object.freeze(prepared),
    videoDurationMs,
    audioDurationMs,
  });
}

/**
 * Add browser-visible paths after local preflight succeeds. Staging is kept
 * separate because it may copy a WSL-local file onto a Windows-visible drive.
 * A second disposable copy gives every upload the Jimeng @ label as its
 * filename, because the visible picker derives labels from filenames.
 */
export function prepareBrowserReferenceAssets(canonical, options = {}) {
  const preflight = validateLocalReferenceAssets(canonical, options);
  const stage = options.stageForBrowserUpload ?? defaultStageForBrowserUpload;
  const stagedAssets = preflight.assets.map((asset) => {
    const staged = stage(asset.sourcePath, options);
    if (
      !staged
      || typeof staged.nodePath !== 'string'
      || typeof staged.browserPath !== 'string'
      || typeof staged.name !== 'string'
    ) {
      throw new ArgumentError(
        `Could not prepare browser upload path for '${asset.sourcePath}'`,
        'The browser upload staging layer returned an invalid path record.',
      );
    }
    if (staged.name !== asset.filename) {
      throw new ArgumentError(
        `Browser upload staging changed filename '${asset.filename}' to '${staged.name}'`,
        'Reference filenames must be preserved so @ mentions can be bound unambiguously.',
      );
    }
    return Object.freeze({
      ...asset,
      nodePath: staged.nodePath,
      browserPath: staged.browserPath,
      staged: staged.staged === true,
    });
  });

  const stageAliases = options.stageReferenceUploadAliases ?? defaultStageReferenceUploadAliases;
  let aliases;
  try {
    aliases = stageAliases(stagedAssets, options);
  } catch (err) {
    throw new ArgumentError(
      `Could not create temporary Jimeng reference aliases: ${describeError(err)}`,
      'Ensure the browser-visible temporary directory is writable, then retry.',
    );
  }
  if (!aliases || !Array.isArray(aliases.assets) || typeof aliases.cleanup !== 'function') {
    try {
      aliases?.cleanup?.();
    } catch {
      // Report the invalid staging contract rather than masking it with cleanup.
    }
    throw new ArgumentError(
      'Temporary Jimeng reference alias staging returned an invalid result',
      'The alias staging layer must return assets and a cleanup function.',
    );
  }
  if (aliases.assets.length !== stagedAssets.length) {
    try {
      aliases.cleanup();
    } catch {
      // The primary error is the incomplete staging result.
    }
    throw new ArgumentError(
      `Temporary Jimeng reference alias staging returned ${aliases.assets.length} assets for ${stagedAssets.length} inputs`,
      'Every supplied reference must receive exactly one temporary upload alias.',
    );
  }

  let assets;
  try {
    assets = aliases.assets.map((asset, index) => {
      const original = stagedAssets[index];
      if (
        !asset
        || typeof asset.nodePath !== 'string'
        || typeof asset.browserPath !== 'string'
        || typeof asset.uploadFilename !== 'string'
        || asset.label !== original.label
        || asset.filename !== original.filename
      ) {
        throw new ArgumentError(
          `Temporary Jimeng reference alias ${index + 1} is malformed or no longer maps to ${original.label}`,
          'Every temporary upload alias must preserve its original reference record and expose browserPath.',
        );
      }
      return Object.freeze(asset);
    });
  } catch (err) {
    try {
      aliases.cleanup();
    } catch {
      // Preserve the alias validation error.
    }
    throw err;
  }

  return Object.freeze({
    assets: Object.freeze(assets),
    videoDurationMs: preflight.videoDurationMs,
    audioDurationMs: preflight.audioDurationMs,
    cleanup: aliases.cleanup,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function describeAssetLabel(asset, idx) {
  if (asset && typeof asset === 'object' && typeof asset.label === 'string' && asset.label.length > 0) {
    return asset.label;
  }
  return `asset#${idx}`;
}

/**
 * Strip only the FINAL extension from `name`. We deliberately keep
 * intermediate dots so a file named `panel.sora.tar.gz` still collapses to
 * `panel.sora.tar` for its mention name, instead of being treated as a
 * single `.gz` blob.
 *
 * Leading-dot names (".env") and dot-less names ("README") round-trip
 * unchanged — neither has a real extension per Node's path semantics.
 */
function stripFinalExtension(name) {
  if (typeof name !== 'string' || name.length === 0) return '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

function resolveSourcePath(rawPath, pathMod, options) {
  const windowsPath = rawPath.match(/^([a-z]):[\\/](.*)$/i);
  if (windowsPath && pathMod.sep === '/') {
    const mountRoot = options.wslMountRoot ?? '/mnt';
    return pathMod.normalize(pathMod.join(
      mountRoot,
      windowsPath[1].toLowerCase(),
      windowsPath[2].replace(/\\/g, '/'),
    ));
  }
  return pathMod.isAbsolute(rawPath)
    ? pathMod.normalize(rawPath)
    : pathMod.resolve(rawPath);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  const message = typeof err.message === 'string' && err.message.length > 0
    ? err.message
    : '';
  const stderr = err.stderr == null
    ? ''
    : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString('utf8').trim()
      : String(err.stderr).trim();
  if (message && stderr && !message.includes(stderr)) {
    return `${message}; stderr: ${stderr}`;
  }
  if (message) return message;
  if (stderr) return stderr;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

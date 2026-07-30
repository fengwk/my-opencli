/**
 * jimeng-agent video — pure command-contract normalization.
 *
 * This module is intentionally PREPARE-ONLY. It validates and reshapes the
 * OpenCLI kwarg surface for the `opencli jimeng-agent video` command and
 * assembles the exact `agentPrompt` text the LLM-facing surface requires.
 *
 * No browser I/O, no submission, no generation. Anything that needs to talk
 * to jimeng.jianying.com lives in a separate, browser-aware module that
 * consumes the canonical shape returned here.
 */

import crypto from 'node:crypto';

import { ArgumentError } from '@jackwener/opencli/errors';

/**
 * Allowed model versions. Order is deliberate — it drives the agentPrompt
 * prefix lookup and is the public contract surfaced to callers. Frozen so
 * downstream code cannot mutate the whitelist at runtime.
 */
export const MODEL_VERSIONS = Object.freeze([
  'seedance2.0',
  'seedance2.0fast',
  'seedance2.0_vip',
  'seedance2.0fast_vip',
  'seedance2.0mini',
]);

/**
 * Allowed aspect ratios. Same freeze contract as MODEL_VERSIONS.
 */
export const RATIOS = Object.freeze([
  '1:1',
  '3:4',
  '16:9',
  '4:3',
  '9:16',
  '21:9',
]);

/**
 * Hard upper bound on the total number of asset references (image + video
 * + audio) that may be attached to a single ask call. Enforced in this
 * prepare-only module so the browser layer never has to second-guess it.
 * Exposed publicly so callers can surface the cap ahead of time.
 */
export const MAX_REFERENCE_ASSETS = 12;

/**
 * Hard upper bound on the number of video references per ask call. Imposed
 * independently of {@link MAX_REFERENCE_ASSETS} because the UI uses a
 * dedicated control with its own slot budget.
 */
export const MAX_VIDEO_REFERENCES = 3;

/**
 * Hard upper bound on the number of audio references per ask call. Same
 * rationale as {@link MAX_VIDEO_REFERENCES}.
 */
export const MAX_AUDIO_REFERENCES = 3;

/**
 * Maximum supported output duration in seconds. This is the product-wide
 * ceiling — currently reachable through the `duration` kwarg — and is
 * published now so external callers (and a future media probe that runs
 * once browser plumbing exists) can reference a single source of truth.
 *
 * Note: this slice intentionally does NOT probe media files for their real
 * duration. The constant is exposed, not enforced against media metadata.
 */
export const MAX_REFERENCE_DURATION_SECONDS = 15;

/**
 * Length of the search/download anchor embedded in every agentPrompt.
 * Hex-encoded 8 random bytes => 16 lowercase characters.
 */
export const ASSET_ID_LENGTH = 16;

/** Prefix used in agentPrompt for the retrieval anchor line. */
export const ASSET_ID_LINE_PREFIX = '资产编号：';

/**
 * Default duration when the caller does not supply one. Per the product
 * spec the value lives in the closed integer range
 * [MIN_DURATION, MAX_REFERENCE_DURATION_SECONDS].
 */
const DEFAULT_DURATION = 5;
const MIN_DURATION = 4;
const MAX_DURATION = MAX_REFERENCE_DURATION_SECONDS;

/**
 * Map each allow-listed model version to its exact agentPrompt prefix.
 * Strings are copied verbatim from the product spec — including the
 * intentional ASCII '(' opening paren paired with the full-width '）'
 * closing paren. Touching these requires a product decision, not a refactor.
 */
const MODEL_PREFIXES = Object.freeze({
  'seedance2.0': '(使用 Seedance2.0，**禁止使用 VIP**）',
  'seedance2.0fast': '(使用 Seedance2.0 Fast，**禁止使用 VIP**）',
  'seedance2.0_vip': '(使用 Seedance2.0 VIP）',
  'seedance2.0fast_vip': '(使用 Seedance2.0 Fast VIP）',
  'seedance2.0mini': '(使用 Seedance2.0 Mini）',
});

const AGENT_SUFFIX_TEMPLATE = '，你必须严格按照下面的提示词内容生成1个{ratio}的{duration}s视频';

/**
 * Chinese resource-kind characters used as @-placeholder prefixes in the
 * user prompt. Ordered to keep deterministic iteration order in error
 * messages and label lookups.
 */
const RESOURCE_KIND_CHARS = Object.freeze(['图片', '视频', '音频']);

/**
 * Map a Chinese resource-kind char prefix to (English kind, output array key,
 * input kwarg key). The triple lookup is centralized so mention validation,
 * asset record construction, and duplicate rejection stay in sync.
 */
const RESOURCE_KIND_META = Object.freeze({
  '图片': { kind: 'image', pathKey: 'imagePaths', inputKey: 'image' },
  '视频': { kind: 'video', pathKey: 'videoPaths', inputKey: 'video' },
  '音频': { kind: 'audio', pathKey: 'audioPaths', inputKey: 'audio' },
});

/**
 * Public, ordered canonical output. Anything outside this list is a private
 * implementation detail and the test suite asserts presence.
 */
const CANONICAL_KEYS = Object.freeze([
  'workspace',
  'imagePaths',
  'videoPaths',
  'audioPaths',
  'prompt',
  'duration',
  'ratio',
  'modelVersion',
  'retry',
  'submit',
  'assetId',
  'assets',
  'mentions',
  'agentPrompt',
]);

/**
 * Normalize, validate, and assemble the contract payload for
 * `opencli jimeng-agent video`. Fail-closed: any malformed input throws
 * ArgumentError before any caller can do work with the result.
 *
 * @param {object} [kwargs={}]
 * @param {string} kwargs.workspace required non-blank string
 * @param {string|string[]} [kwargs.image] see {@link normalizeAssetList}
 * @param {string|string[]} [kwargs.video] see {@link normalizeAssetList}
 * @param {string|string[]} [kwargs.audio] see {@link normalizeAssetList}
 * @param {string} [kwargs.prompt] optional; undefined/null → ''
 * @param {number|string} [kwargs.duration] integer in [4, 15]; default 5
 * @param {string} kwargs.ratio required; must be one of {@link RATIOS}
 * @param {string} kwargs.model_version required; must be one of {@link MODEL_VERSIONS}
 * @param {number|string} [kwargs.retry] non-negative integer; default 0
 * @param {number|string|boolean} [kwargs.submit] 0/1 or false/true; default false
 * @returns {object} canonical payload — see {@link CANONICAL_KEYS}
 */
export function normalizeAskArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }

  const workspace = requireNonBlankStringField(kwargs, 'workspace');
  const ratio = requireChoiceField(kwargs, 'ratio', RATIOS, '--ratio');
  const modelVersion = requireChoiceField(kwargs, 'model_version', MODEL_VERSIONS, '--model_version');

  const duration = normalizeDuration(kwargs.duration);
  const retry = normalizeRetry(kwargs.retry);
  const submit = normalizeSubmit(kwargs.submit);

  const imagePaths = normalizeAssetList(kwargs.image, 'image', '--image');
  const videoPaths = normalizeAssetList(kwargs.video, 'video', '--video');
  const audioPaths = normalizeAssetList(kwargs.audio, 'audio', '--audio');

  rejectCrossDuplicates([
    ['image', imagePaths],
    ['video', videoPaths],
    ['audio', audioPaths],
  ]);

  enforceAssetLimits({
    imagePaths,
    videoPaths,
    audioPaths,
  });

  const prompt = normalizePrompt(kwargs.prompt);
  // Always tool-generated; callers consume the returned assetId for status lookup.
  const assetId = createAssetId();

  const assets = buildAssetRecords(imagePaths, videoPaths, audioPaths);
  const mentions = extractMentions(prompt, assets);

  const agentPrompt = assembleAgentPrompt({
    modelVersion,
    ratio,
    duration,
    prompt,
    assetId,
  });

  const result = {
    workspace,
    imagePaths,
    videoPaths,
    audioPaths,
    prompt,
    duration,
    ratio,
    modelVersion,
    retry,
    submit,
    assetId,
    assets,
    mentions,
    agentPrompt,
  };

  // The shape is the public contract; reject drift loudly during dev if a
  // future edit accidentally removes/renames a canonical key.
  assertCanonicalShape(result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field validators
// ─────────────────────────────────────────────────────────────────────────────

function requireNonBlankStringField(kwargs, key) {
  const raw = kwargs[key];
  if (raw === undefined || raw === null) {
    throw new ArgumentError(
      `Missing required argument: '${key}'`,
      `Pass a non-empty --${toFlag(key)} value.`,
    );
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid '${key}': expected string, got ${describeType(raw)}`,
      `Pass --${toFlag(key)} as a plain string.`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ArgumentError(
      `Invalid '${key}': value is blank`,
      `Pass a non-empty --${toFlag(key)} value.`,
    );
  }
  return trimmed;
}

function requireChoiceField(kwargs, key, choices, flag) {
  const raw = kwargs[key];
  if (raw === undefined || raw === null) {
    throw new ArgumentError(
      `Missing required argument: '${key}'`,
      `Pass one of: ${choices.join(', ')} via ${flag}.`,
    );
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid '${key}': expected string, got ${describeType(raw)}`,
      `Pass ${flag} as a string.`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ArgumentError(
      `Invalid '${key}': value is blank`,
      `Pass one of: ${choices.join(', ')} via ${flag}.`,
    );
  }
  if (!choices.includes(trimmed)) {
    throw new ArgumentError(
      `Invalid '${key}': '${raw}' (must be one of ${choices.join(', ')})`,
      `Pass one of: ${choices.join(', ')} via ${flag}.`,
    );
  }
  return trimmed;
}

function normalizeDuration(raw) {
  if (raw === undefined || raw === null) {
    return DEFAULT_DURATION;
  }

  // Treat empty/whitespace strings as "not provided" so that a CLI invocation
  // like `--duration ""` falls back to the default rather than crashing.
  if (typeof raw === 'string' && raw.trim() === '') {
    return DEFAULT_DURATION;
  }

  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    n = Number(raw.trim());
  } else {
    throw new ArgumentError(
      `Invalid duration: expected number or numeric string, got ${describeType(raw)}`,
      'Pass --duration as an integer in [4, 15].',
    );
  }

  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_DURATION || n > MAX_DURATION) {
    throw new ArgumentError(
      `Invalid duration: '${raw}' (must be an integer in [${MIN_DURATION}, ${MAX_DURATION}] inclusive)`,
      `Pass --duration as an integer from ${MIN_DURATION} through ${MAX_DURATION}.`,
    );
  }

  return n;
}

function normalizeRetry(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return 0;
  }

  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    n = Number(raw.trim());
  } else {
    throw new ArgumentError(
      `Invalid retry: expected non-negative integer, got ${describeType(raw)}`,
      'Pass --retry as 0 or a positive integer.',
    );
  }

  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ArgumentError(
      `Invalid retry: '${raw}' (must be a non-negative integer)`,
      'Pass --retry as 0 or a positive integer.',
    );
  }
  return n;
}

function normalizeSubmit(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return false;
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 0) return false;
    if (raw === 1) return true;
  }
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
    if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  }
  throw new ArgumentError(
    `Invalid submit: '${raw}' (must be 0/1 or true/false)`,
    'Pass --submit 0 to prepare only, or --submit 1 to submit after a green checkpoint.',
  );
}

function normalizePrompt(raw) {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid prompt: expected string, got ${describeType(raw)}`,
      'Pass --prompt as a plain string value.',
    );
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset list normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten {@link value} into an ordered array of leaf entries. Accepts
 * undefined, null, a string, an array, or any combination of nested arrays.
 */
function flatten(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(...flatten(item));
    }
    return out;
  }
  return [value];
}

/**
 * Normalize the user-supplied asset kwarg into a list of trimmed non-blank
 * path strings. Supports strings, comma-separated strings, arrays, and any
 * nesting of arrays (CLI frameworks often produce a mix). File existence
 * is intentionally NOT validated here — that belongs to the browser layer.
 */
function normalizeAssetList(value, kindName, flag) {
  const leaves = flatten(value);
  const result = [];

  for (const leaf of leaves) {
    if (typeof leaf !== 'string') {
      throw new ArgumentError(
        `Invalid --${kindName} entry: expected string path, got ${describeType(leaf)}`,
        `Each ${flag} entry must be a path string.`,
      );
    }
    // Allow comma-separated lists at the string level so a CLI option like
    // `--image 'a.png,b.png'` still flattens to two paths.
    for (const piece of leaf.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }

  return result;
}

/**
 * Cross-list duplicate detector. Walks every supplied list and rejects the
 * second occurrence of a normalized path because the browser layer will not
 * be able to map it back unambiguously.
 */
function rejectCrossDuplicates(listsWithNames) {
  const seen = new Map(); // path -> first list name
  for (const [name, list] of listsWithNames) {
    for (const path of list) {
      if (seen.has(path)) {
        throw new ArgumentError(
          `Duplicate asset path '${path}' (already provided via ${seen.get(path)})`,
          `Each path may appear in at most one of --image, --video, --audio.`,
        );
      }
      seen.set(path, name);
    }
  }
}

/**
 * Enforce per-call asset ceilings before any work that could reach the
 * browser layer. The checks run in the same order they appear in the
 * product spec (total → video → audio) so error messages and observable
 * behavior stay aligned. Counts are taken AFTER dedup, so the limit
 * reflects the number of distinct references actually queued up.
 */
function enforceAssetLimits({ imagePaths, videoPaths, audioPaths }) {
  const totalCount = imagePaths.length + videoPaths.length + audioPaths.length;
  if (totalCount > MAX_REFERENCE_ASSETS) {
    throw new ArgumentError(
      `Too many asset references: ${totalCount} supplied (max is ${MAX_REFERENCE_ASSETS})`,
      `Reduce --image, --video and --audio combined to at most ${MAX_REFERENCE_ASSETS} paths.`,
    );
  }
  if (videoPaths.length > MAX_VIDEO_REFERENCES) {
    throw new ArgumentError(
      `Too many video references: ${videoPaths.length} supplied (max is ${MAX_VIDEO_REFERENCES})`,
      `Pass at most ${MAX_VIDEO_REFERENCES} paths via --video.`,
    );
  }
  if (audioPaths.length > MAX_AUDIO_REFERENCES) {
    throw new ArgumentError(
      `Too many audio references: ${audioPaths.length} supplied (max is ${MAX_AUDIO_REFERENCES})`,
      `Pass at most ${MAX_AUDIO_REFERENCES} paths via --audio.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build ordered asset records in the contract order: images first, videos
 * next, audio last. Each record carries the minimum data the browser layer
 * needs to upload/match: kind, label, index, path.
 */
function buildAssetRecords(imagePaths, videoPaths, audioPaths) {
  const records = [];

  for (let i = 0; i < imagePaths.length; i += 1) {
    records.push({
      kind: 'image',
      label: `图片${i + 1}`,
      index: i + 1,
      path: imagePaths[i],
    });
  }

  for (let i = 0; i < videoPaths.length; i += 1) {
    records.push({
      kind: 'video',
      label: `视频${i + 1}`,
      index: i + 1,
      path: videoPaths[i],
    });
  }

  for (let i = 0; i < audioPaths.length; i += 1) {
    records.push({
      kind: 'audio',
      label: `音频${i + 1}`,
      index: i + 1,
      path: audioPaths[i],
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mention extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan {@link prompt} left-to-right for resource placeholders of the exact
 * form `@<kind><positive-integer>` where `<kind>` is one of 图片 / 视频 /
 * 音频. Anything that looks like a resource placeholder but is malformed
 * (no number, non-positive number, references a non-existent or wrong-kind
 * asset) throws. Unrelated `@foo` text and email addresses are ignored
 * because their post-`@` byte is not one of the resource kind prefixes.
 *
 * The returned array preserves document order so an adapter can reason
 * about the chronological mention sequence.
 */
function extractMentions(prompt, assets) {
  if (prompt.length === 0) return [];

  const labelIndex = new Map();
  for (const asset of assets) {
    labelIndex.set(asset.label, asset);
  }

  const mentions = [];

  for (let i = 0; i < prompt.length; i += 1) {
    if (prompt.charCodeAt(i) !== AT_CODE) continue; // not '@'
    if (i + 1 >= prompt.length) break;

    const matchedKind = matchResourceKindPrefix(prompt, i + 1);
    if (!matchedKind) continue;

    const afterKind = i + 1 + matchedKind.length;
    const { numberText, endPos } = consumeDecimalDigits(prompt, afterKind);

    if (numberText.length === 0) {
      throw new ArgumentError(
        `Malformed resource placeholder '@${matchedKind}' in prompt (missing positive integer)`,
        'Use the form @图片1, @视频2 or @音频1 with a positive integer.',
      );
    }

    const n = Number.parseInt(numberText, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new ArgumentError(
        `Malformed resource placeholder '@${matchedKind}${numberText}' in prompt (index must be a positive integer)`,
        'Use the form @图片1, @视频2 or @音频1 with a positive integer greater than zero.',
      );
    }

    const label = `${matchedKind}${n}`;
    const asset = labelIndex.get(label);
    if (!asset) {
      const meta = RESOURCE_KIND_META[matchedKind];
      throw new ArgumentError(
        `Unknown resource '@${label}' in prompt (no ${meta.kind} supplied at index ${n})`,
        `Provide ${n} ${meta.kind} asset(s) via ${flagForInputKey(meta.inputKey)}, or remove the reference.`,
      );
    }

    mentions.push({
      kind: asset.kind,
      label: asset.label,
      index: asset.index,
    });

    i = endPos - 1; // for-loop's i++ will move past the digit run
  }

  return mentions;
}

const AT_CODE = 0x40; // '@'

function matchResourceKindPrefix(prompt, afterAtPos) {
  for (const kind of RESOURCE_KIND_CHARS) {
    if (prompt.startsWith(kind, afterAtPos)) {
      return kind;
    }
  }
  return null;
}

function consumeDecimalDigits(prompt, startPos) {
  let endPos = startPos;
  while (endPos < prompt.length) {
    const code = prompt.charCodeAt(endPos);
    if (code < 0x30 || code > 0x39) break; // not 0-9
    endPos += 1;
  }
  return { numberText: prompt.slice(startPos, endPos), endPos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent prompt assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a 16-character lowercase hex asset id used as the retrieval anchor.
 * Always generated by the CLI; not a user-facing input flag.
 */
export function createAssetId(randomBytes = (n) => crypto.randomBytes(n)) {
  return randomBytes(ASSET_ID_LENGTH / 2).toString('hex');
}

/**
 * Assemble the exact `agentPrompt` string the browser layer types into Jimeng:
 *
 *   <modelPrefix>，你必须严格按照下面的提示词内容生成1个<ratio>的<duration>s视频
 *   资产编号：<16-hex>
 *   <BLANK LINE>
 *   ---
 *   <BLANK LINE>
 *   <original prompt if non-empty>
 *
 * Header and asset-id are adjacent (single LF, no blank line). The `---`
 * separator plus surrounding blank lines isolate free-form prompt text for
 * later hash-based search/download. No trailing newline.
 */
function assembleAgentPrompt({ modelVersion, ratio, duration, prompt, assetId }) {
  const prefix = MODEL_PREFIXES[modelVersion];
  const suffix = AGENT_SUFFIX_TEMPLATE
    .replace('{ratio}', ratio)
    .replace('{duration}', duration);

  let text = `${prefix}${suffix}\n${ASSET_ID_LINE_PREFIX}${assetId}`;
  if (prompt.length > 0) {
    text += `\n\n---\n\n${prompt}`;
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function toFlag(camelKey) {
  return '--' + camelKey.replace(/_/g, '-');
}

function flagForInputKey(inputKey) {
  return `--${inputKey}`;
}

/**
 * Defensive contract check. Runs only in development but guarantees that the
 * shape promised in CANONICAL_KEYS matches what callers actually receive.
 * Should never fail in production — if it does, the function has a bug.
 */
function assertCanonicalShape(result) {
  for (const key of CANONICAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`normalizeAskArgs: missing canonical key '${key}'`);
    }
  }
  for (const key of Object.keys(result)) {
    if (!CANONICAL_KEYS.includes(key)) {
      throw new Error(`normalizeAskArgs: unexpected key '${key}' in result`);
    }
  }
}

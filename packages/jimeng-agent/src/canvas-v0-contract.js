/**
 * jimeng-agent canvas-v0 — legacy canvas (/ai-tool/canvas) identity + ask contract.
 *
 * The legacy canvas ("初代画布") is a separate surface from the Agent Canvas
 * (/ai-tool/ai-canvas):
 *   - projects are numeric ids created through /mweb/v1/infinite_canvas/create_project
 *   - the prompt surface is the 对话 sidecar (`aside` right panel) whose composer
 *     shares one document with the canvas bottom composer
 *   - the composer carries uploaded files as attachments; there is no document
 *     mention chip to bind, so the prompt is plain text
 *
 * Everything here is pure: no browser I/O, no submission, no generation.
 */

import os from 'node:os';
import path from 'node:path';

import { ArgumentError } from '@jackwener/opencli/errors';

import { JIMENG_CANVAS_ORIGIN } from './canvas-contract.js';
import { normalizeAskArgs } from './contract.js';

export const JIMENG_CANVAS_V0_PATH = '/ai-tool/canvas';
export const JIMENG_CANVAS_V0_URL = `${JIMENG_CANVAS_ORIGIN}${JIMENG_CANVAS_V0_PATH}`;
export const JIMENG_CANVAS_V0_ASSET_URL = `${JIMENG_CANVAS_ORIGIN}/ai-tool/asset`;
export const V0_CANVAS_NEW = 'new';
export const V0_CANVAS_CREATE_QUERY = 'enter_from=create_new&from_page=assets';

/** Legacy canvas project creation (same-origin, signed by the page transport). */
export const V0_CREATE_PROJECT_PATH = '/mweb/v1/infinite_canvas/create_project';
export const V0_CREATE_PROJECT_QUERY = 'aid=513695&web_version=7.5.0&da_version=3.3.28&aigc_features=app_lip_sync';
export const V0_CREATE_PROJECT_DRAFT = JSON.stringify({
  meta: { version: '0.0.1' },
  layers: [],
  aiGeneratorReference: {},
  references: {},
});
export const V0_DEFAULT_PROJECT_NAME = '未命名项目';
/** The legacy create_project API rejects names longer than 20 characters. */
export const V0_MAX_TITLE_LENGTH = 20;
/** Legacy canvas project ids are numeric (for example 22104635995404). */
export const V0_PROJECT_ID_PATTERN = /^\d{6,}$/;

const CANONICAL_CREATE_KEYS = Object.freeze(['canvas', 'canvasMode', 'title']);
/** CLI input keys accepted by `canvas-v0-create` (canvas is implied to be new). */
const V0_CREATE_INPUT_KEYS = Object.freeze(['title']);
/** CLI input keys accepted by `canvas-v0-video` (kebab-case from the CLI). */
const V0_ASK_INPUT_KEYS = Object.freeze([
  'canvas',
  'title',
  'image',
  'video',
  'audio',
  'prompt',
  'duration',
  'ratio',
  'model_version',
  'retry',
  'submit',
]);
const V0_STATUS_INPUT_KEYS = Object.freeze(['canvas', 'asset_id', 'record_id', 'limit']);
const V0_DOWNLOAD_INPUT_KEYS = Object.freeze([
  'canvas',
  'asset_id',
  'record_id',
  'definition',
  'output',
]);
const CANONICAL_ASK_KEYS = Object.freeze([
  'canvas',
  'canvasMode',
  'projectId',
  'title',
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
 * @param {unknown} raw
 * @returns {{ mode: 'new'|'existing', value: string, projectId: string }}
 */
export function normalizeCanvasV0Identity(raw) {
  if (raw === undefined || raw === null) {
    throw new ArgumentError(
      "Missing required argument: 'canvas'",
      'Pass --canvas new to create a legacy canvas, or --canvas <projectId> for an existing one.',
    );
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid 'canvas': expected string, got ${describeType(raw)}`,
      'Pass --canvas new or --canvas <projectId>.',
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ArgumentError(
      "Invalid 'canvas': value is blank",
      'Pass --canvas new or --canvas <projectId>.',
    );
  }
  if (trimmed.toLowerCase() === V0_CANVAS_NEW) {
    return { mode: 'new', value: V0_CANVAS_NEW, projectId: '' };
  }

  const fromUrl = parseCanvasV0Locator(trimmed);
  if (fromUrl) return fromUrl;

  if (/\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new ArgumentError(
      `Invalid 'canvas': '${raw}' is not 'new', a legacy canvas project id, or a Jimeng /ai-tool/canvas URL`,
      'Pass --canvas new, --canvas <projectId>, or an /ai-tool/canvas URL.',
    );
  }
  if (!V0_PROJECT_ID_PATTERN.test(trimmed)) {
    throw new ArgumentError(
      `Invalid 'canvas': '${raw}' is not a numeric legacy canvas project id`,
      'Pass the numeric project id from the canvas URL path /ai-tool/canvas/<projectId>.',
    );
  }
  return { mode: 'existing', value: trimmed, projectId: trimmed };
}

export function buildCanvasV0Url(identity, options = {}) {
  const resolved = typeof identity === 'string'
    ? normalizeCanvasV0Identity(identity)
    : identity;
  if (!resolved || (resolved.mode !== 'new' && resolved.mode !== 'existing')) {
    throw new ArgumentError(
      'Canvas identity is required',
      'Pass --canvas new or --canvas <projectId>.',
    );
  }
  const projectId = typeof options.projectId === 'string' && options.projectId.trim()
    ? options.projectId.trim()
    : resolved.projectId;
  if (resolved.mode === 'existing' || projectId) {
    if (!projectId) {
      throw new ArgumentError(
        'Existing legacy canvas requires a project id',
        'Pass --canvas <projectId>.',
      );
    }
    return `${JIMENG_CANVAS_V0_URL}/${encodeURIComponent(projectId)}`;
  }
  return `${JIMENG_CANVAS_V0_URL}?${V0_CANVAS_CREATE_QUERY}`;
}

export function parseCanvasV0ProjectIdFromHref(href) {
  const text = String(href || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, JIMENG_CANVAS_ORIGIN);
    const match = url.pathname.match(/\/ai-tool\/canvas\/([^/]+)\/?$/);
    if (!match) return '';
    const id = decodeURIComponent(match[1]);
    return V0_PROJECT_ID_PATTERN.test(id) ? id : '';
  } catch {
    return '';
  }
}

export function buildCanvasV0CreateProjectBody({ name } = {}) {
  const projectName = typeof name === 'string' && name.trim()
    ? name.trim().slice(0, V0_MAX_TITLE_LENGTH)
    : V0_DEFAULT_PROJECT_NAME;
  return { name: projectName, draft: V0_CREATE_PROJECT_DRAFT };
}

/**
 * Read `/mweb/v1/infinite_canvas/create_project` (`ret`/`errmsg`/`data` envelope).
 *
 * @param {unknown} envelope
 * @returns {{ projectId: string, draftId: string, version: string }}
 */
export function readCanvasV0CreatedProject(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`${V0_CREATE_PROJECT_PATH} returned a malformed envelope`);
  }
  if (String(envelope.ret ?? '') !== '0') {
    throw new Error(
      `${V0_CREATE_PROJECT_PATH} rejected the request (ret=${String(envelope.ret ?? 'missing')}, errmsg=${String(envelope.errmsg || '')})`,
    );
  }
  const data = envelope.data;
  const projectId = typeof data?.project_id === 'string' ? data.project_id.trim() : '';
  if (!V0_PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      `${V0_CREATE_PROJECT_PATH} returned no usable project id (project_id=${JSON.stringify(data?.project_id ?? null)})`,
    );
  }
  return {
    projectId,
    draftId: typeof data?.draft_id === 'string' ? data.draft_id.trim() : '',
    version: data?.version === undefined || data?.version === null ? '' : String(data.version),
  };
}

/**
 * Normalize `canvas-v0-create` arguments: a blank legacy canvas only.
 *
 * @param {object} [kwargs]
 * @returns {{ canvas: string, canvasMode: 'new', title: string }}
 */
export function normalizeCanvasV0CreateArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }
  assertKnownInputKeys(kwargs, V0_CREATE_INPUT_KEYS, 'normalizeCanvasV0CreateArgs');
  const identity = { mode: 'new', value: V0_CANVAS_NEW, projectId: '' };
  return {
    canvas: V0_CANVAS_NEW,
    canvasMode: identity.mode,
    title: normalizeCanvasV0Title(kwargs.title, identity),
  };
}

/**
 * Legacy canvas titles are persisted through `create_project`, whose name field
 * is limited to 20 characters (verified against the live API).
 */
export function normalizeCanvasV0Title(raw, identity) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid 'title': expected string, got ${describeType(raw)}`,
      `Pass a non-empty legacy canvas title with at most ${V0_MAX_TITLE_LENGTH} characters.`,
    );
  }
  const title = raw.trim();
  if (!title) {
    throw new ArgumentError(
      "Invalid 'title': value is blank",
      'Omit --title or pass a non-empty title.',
    );
  }
  if (title.length > V0_MAX_TITLE_LENGTH) {
    throw new ArgumentError(
      `Invalid 'title': length ${title.length} exceeds ${V0_MAX_TITLE_LENGTH} characters`,
      `The legacy canvas create_project API supports at most ${V0_MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (identity?.mode !== 'new') {
    throw new ArgumentError(
      "'title' is only valid when --canvas new is used",
      'Existing legacy canvases are never renamed by canvas-v0-video; omit --title.',
    );
  }
  return title;
}

export function normalizeCanvasV0AskArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }
  assertKnownInputKeys(kwargs, V0_ASK_INPUT_KEYS, 'normalizeCanvasV0AskArgs');
  const identity = normalizeCanvasV0Identity(kwargs.canvas);
  const title = normalizeCanvasV0Title(kwargs.title, identity);
  const shared = normalizeAskArgs({
    ...kwargs,
    workspace: identity.mode === 'new' ? 'canvas-v0-new' : identity.projectId,
  });
  const result = {
    canvas: identity.value,
    canvasMode: identity.mode,
    projectId: identity.projectId,
    title,
    imagePaths: shared.imagePaths,
    videoPaths: shared.videoPaths,
    audioPaths: shared.audioPaths,
    prompt: shared.prompt,
    duration: shared.duration,
    ratio: shared.ratio,
    modelVersion: shared.modelVersion,
    retry: shared.retry,
    submit: shared.submit,
    assetId: shared.assetId,
    assets: shared.assets,
    mentions: shared.mentions,
    agentPrompt: shared.agentPrompt,
  };
  assertCanonicalShape(result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy canvas read-back contract (canvas-v0-status / canvas-v0-download)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Video definitions a legacy canvas history record publishes, best quality
 * first. Verified against live /mweb/v1/get_history_by_ids responses.
 */
export const V0_VIDEO_DEFINITIONS = Object.freeze(['origin', '720p', '480p', '360p']);
export const V0_DEFAULT_VIDEO_DEFINITION = '720p';
export const V0_DEFAULT_STATUS_LIMIT = 20;
export const V0_MAX_STATUS_LIMIT = 200;

const V0_HISTORY_ID_PATTERN = /^\d{6,}$/;
const V0_ASSET_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Record statuses observed on the live legacy canvas API. Codes that were never
 * observed are reported verbatim instead of named.
 */
const V0_RECORD_STATUS_NAMES = Object.freeze({
  50: 'finished',
});

export function canvasV0RecordStatusName(code) {
  if (code === undefined || code === null || code === '') return '';
  return V0_RECORD_STATUS_NAMES[Number(code)] || '';
}

/**
 * Legacy history records keep the composed prompt, so `资产编号：<assetId>` is
 * readable straight from the generated item and can anchor a status query.
 */
export function parseCanvasV0AssetId(value) {
  const match = /资产编号\s*[：:]\s*([0-9a-f]{16})(?![0-9a-f])/i.exec(String(value ?? ''));
  return match ? match[1].toLowerCase() : '';
}

/**
 * Read the first item of a history record that carries media.
 *
 * @param {object} record
 * @returns {{itemId: string, prompt: string, itemStatus: string|number, coverUrl: string,
 *   duration: number|string, videoId: string,
 *   definitions: Array<{definition: string, url: string, md5: string, size: number, width: number, height: number}>}|null}
 */
export function readCanvasV0RecordMedia(record) {
  const items = Array.isArray(record?.item_list) ? record.item_list : [];
  if (items.length === 0) return null;
  let fallback = null;
  for (const item of items) {
    const video = item?.video;
    const transcoded = video?.transcoded_video;
    const base = {
      itemId: String(item?.common_attr?.id ?? ''),
      prompt: String(item?.common_attr?.prompt ?? ''),
      itemStatus: item?.common_attr?.status ?? '',
      coverUrl: String(item?.common_attr?.cover_url ?? ''),
      duration: video?.duration ?? '',
      videoId: String(video?.video_id ?? ''),
    };
    if (!transcoded || typeof transcoded !== 'object' || Array.isArray(transcoded)) {
      fallback = fallback || { ...base, definitions: [] };
      continue;
    }
    const definitions = [];
    for (const definition of V0_VIDEO_DEFINITIONS) {
      const entry = transcoded[definition];
      const url = typeof entry?.video_url === 'string' ? entry.video_url.trim() : '';
      if (!url) continue;
      definitions.push({
        definition,
        url,
        md5: String(entry?.md5 ?? ''),
        size: Number(entry?.size) || 0,
        width: Number(entry?.width) || 0,
        height: Number(entry?.height) || 0,
      });
    }
    if (definitions.length > 0) return { ...base, definitions };
    fallback = fallback || { ...base, definitions: [] };
  }
  return fallback;
}

/**
 * `ready` because a downloadable video exists, `failed` because the API reported a
 * failure, `pending` otherwise (never submitted, still running, or a non-video task).
 */
export function evaluateCanvasV0RecordState(record, media) {
  const failure = String(record?.fail_starling_message || record?.fail_starling_key || '').trim();
  if (failure) return { state: 'failed', reason: failure };
  if ((media?.definitions?.length || 0) > 0) return { state: 'ready', reason: '' };
  return { state: 'pending', reason: '' };
}

/**
 * Resolve the definition to download. A missing preferred definition falls back in
 * documented quality order and reports that it did, so a download is never silent.
 */
export function pickCanvasV0VideoDefinition(media, preferred) {
  const definitions = Array.isArray(media?.definitions) ? media.definitions : [];
  if (definitions.length === 0) return null;
  const wanted = String(preferred ?? '').trim() || V0_DEFAULT_VIDEO_DEFINITION;
  const exact = definitions.find((entry) => entry.definition === wanted);
  if (exact) return { ...exact, preferred: wanted, fallback: false };
  for (const candidate of V0_VIDEO_DEFINITIONS) {
    const hit = definitions.find((entry) => entry.definition === candidate);
    if (hit) return { ...hit, preferred: wanted, fallback: true };
  }
  return null;
}

/**
 * Normalize `canvas-v0-status` arguments: an existing legacy canvas, optionally
 * narrowed by one generated asset id or one history record id.
 */
export function normalizeCanvasV0StatusArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }
  assertKnownInputKeys(kwargs, V0_STATUS_INPUT_KEYS, 'normalizeCanvasV0StatusArgs');
  const identity = requireCanvasV0ExistingIdentity(kwargs.canvas, 'canvas-v0-status');
  const limit = kwargs.limit === undefined || kwargs.limit === null || String(kwargs.limit).trim() === ''
    ? V0_DEFAULT_STATUS_LIMIT
    : Number(kwargs.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > V0_MAX_STATUS_LIMIT) {
    throw new ArgumentError(
      `Invalid 'limit': expected an integer between 1 and ${V0_MAX_STATUS_LIMIT}, got ${describeType(kwargs.limit)}`,
      `Pass --limit with a value between 1 and ${V0_MAX_STATUS_LIMIT}.`,
    );
  }
  return {
    canvas: identity.value,
    canvasMode: identity.mode,
    projectId: identity.projectId,
    assetId: normalizeCanvasV0AssetId(kwargs.asset_id),
    recordId: normalizeCanvasV0RecordId(kwargs.record_id, 'canvas-v0-status'),
    limit,
  };
}

/**
 * Normalize `canvas-v0-download` arguments: an existing legacy canvas plus the
 * generated record to fetch, chosen by record id, asset id, or the newest ready
 * generation.
 */
export function normalizeCanvasV0DownloadArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }
  assertKnownInputKeys(kwargs, V0_DOWNLOAD_INPUT_KEYS, 'normalizeCanvasV0DownloadArgs');
  const identity = requireCanvasV0ExistingIdentity(kwargs.canvas, 'canvas-v0-download');
  const recordId = normalizeCanvasV0RecordId(kwargs.record_id, 'canvas-v0-download');
  const assetId = normalizeCanvasV0AssetId(kwargs.asset_id);
  if (recordId && assetId) {
    throw new ArgumentError(
      "Invalid arguments: 'record_id' and 'asset_id' cannot be combined",
      'Pass either --record-id or --asset-id, or neither to download the newest ready video.',
    );
  }
  const definition = String(kwargs.definition ?? '').trim() || V0_DEFAULT_VIDEO_DEFINITION;
  if (!V0_VIDEO_DEFINITIONS.includes(definition)) {
    throw new ArgumentError(
      `Invalid 'definition': '${definition}' (must be one of ${V0_VIDEO_DEFINITIONS.join(', ')})`,
      'Pass --definition origin|720p|480p|360p.',
    );
  }
  return {
    canvas: identity.value,
    canvasMode: identity.mode,
    projectId: identity.projectId,
    recordId,
    assetId,
    definition,
    outputDir: normalizeCanvasV0OutputDir(kwargs.output),
  };
}

function requireCanvasV0ExistingIdentity(rawCanvas, caller) {
  const identity = normalizeCanvasV0Identity(rawCanvas);
  if (identity.mode !== 'existing' || !identity.projectId) {
    throw new ArgumentError(
      `${caller} requires an existing legacy canvas; '--canvas new' is not valid`,
      'Pass the project id or URL printed by canvas-v0-video.',
    );
  }
  return identity;
}

function normalizeCanvasV0AssetId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return '';
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid 'asset_id': expected string, got ${describeType(raw)}`,
      'Pass --asset-id with the 16-character value printed by canvas-v0-video.',
    );
  }
  const assetId = raw.trim().toLowerCase();
  if (!V0_ASSET_ID_PATTERN.test(assetId)) {
    throw new ArgumentError(
      `Invalid 'asset_id': '${raw}' is not a 16-character hex asset id`,
      'Pass --asset-id with the 16-character value printed by canvas-v0-video.',
    );
  }
  return assetId;
}

function normalizeCanvasV0RecordId(raw, caller) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return '';
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ArgumentError(
      `Invalid 'record_id': expected string, got ${describeType(raw)}`,
      `Pass --record-id with the history record id from ${caller}.`,
    );
  }
  const recordId = String(raw).trim();
  if (!V0_HISTORY_ID_PATTERN.test(recordId)) {
    throw new ArgumentError(
      `Invalid 'record_id': '${recordId}' is not a numeric history record id`,
      `Pass --record-id with the history record id from ${caller}.`,
    );
  }
  return recordId;
}

function normalizeCanvasV0OutputDir(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return path.join(os.homedir(), 'Downloads', 'jimeng-agent');
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid 'output': expected string, got ${describeType(raw)}`,
      'Pass --output as a directory path.',
    );
  }
  return path.resolve(raw.trim());
}

export function evaluateCanvasV0PreInputControls(snapshot) {
  const checks = {
    surfaceReady: snapshot?.surfaceReady === true,
    sidecarOpen: snapshot?.sidecarOpen === true,
    composerInSidecar: snapshot?.composerInSidecar === true,
    editorReady: snapshot?.editorReady === true,
    composerReady: snapshot?.composerReady === true,
  };
  if (snapshot?.requireUploadControl !== false) {
    checks.uploadControlReady = snapshot?.uploadControlReady === true;
  }
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    ok: failures.length === 0,
    failures,
    checks,
    phase: 'pre-input',
  };
}

export function evaluateCanvasV0Checkpoint(snapshot, expectations) {
  const expectedReferences = Number(expectations?.expectedReferences ?? 0);
  const editorText = snapshot?.editorTextNormalized || '';
  const textAnchors = Array.isArray(expectations?.textAnchors) ? expectations.textAnchors : [];
  const checks = {
    surfaceReady: snapshot?.surfaceReady === true,
    // The prepared draft only counts when it lives in the docked 对话 panel.
    sidecarOpen: snapshot?.sidecarOpen === true,
    composerInSidecar: snapshot?.composerInSidecar === true,
    // 自动 mirrors `generate` and is verified last, because the legacy app drops it
    // back to 自定义 whenever 图片/视频 or a ratio is picked. An unreadable mirror is
    // not a failure: configureCanvasV0Generation already confirmed it fail-closed.
    autoPreference: snapshot?.autoEnabled !== false,
    referenceCount: Number(snapshot?.referenceCount) === expectedReferences,
    promptAnchorsInOrder: anchorsInOrder(editorText, textAnchors),
    noProcessing: snapshot?.processingCount === 0,
    assetIdPresent: snapshot?.assetIdPresent === true,
  };
  if (snapshot?.requireSubmitArmed === true) {
    checks.submitArmed = snapshot?.submitEnabled === true;
  }
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    ok: failures.length === 0,
    failures,
    checks,
    anchorMismatch: checks.promptAnchorsInOrder ? null : firstAnchorMismatch(editorText, textAnchors),
    phase: 'checkpoint',
    expected: {
      references: expectedReferences,
      textAnchors,
    },
    observed: {
      referenceCount: snapshot?.referenceCount ?? null,
      editorText: editorText.slice(0, 400),
      processingCount: snapshot?.processingCount ?? null,
      submitEnabled: snapshot?.submitEnabled ?? null,
      sidecarOpen: snapshot?.sidecarOpen === true,
      composerInSidecar: snapshot?.composerInSidecar === true,
    },
  };
}

export function normalizeV0EditorText(value) {
  return String(value || '').replace(/[\u00a0\u200b\s]+/g, '');
}

/**
 * Legacy-canvas submit readiness is read from the 对话 panel composer (there is
 * no generation-preference duration/model control to assert).
 */
export function evaluateCanvasV0SubmitReadiness(snapshot) {
  const checks = {
    editorHasPrompt: snapshot?.editorHasPrompt === true,
    sendEnabled: snapshot?.sendEnabled === true,
    sidecarOpen: snapshot?.sidecarOpen === true,
    composerInSidecar: snapshot?.composerInSidecar === true,
  };
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { ok: failures.length === 0, failures, checks };
}

function anchorsInOrder(haystack, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return true;
  let cursor = 0;
  for (const anchor of anchors) {
    const needle = normalizeV0EditorText(anchor);
    if (!needle) continue;
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) return false;
    cursor = index + needle.length;
  }
  return true;
}

function firstAnchorMismatch(haystack, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  let cursor = 0;
  for (const anchor of anchors) {
    const needle = normalizeV0EditorText(anchor);
    if (!needle) continue;
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      return { anchor, index: null, cursor, haystackTail: haystack.slice(Math.max(0, cursor - 40), cursor + 80) };
    }
    cursor = index + needle.length;
  }
  return null;
}

function parseCanvasV0Locator(trimmed) {
  let url;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      url = new URL(trimmed);
    } else if (trimmed.startsWith(JIMENG_CANVAS_V0_PATH)) {
      url = new URL(trimmed, JIMENG_CANVAS_ORIGIN);
    } else {
      return null;
    }
  } catch {
    throw new ArgumentError(
      `Invalid 'canvas': '${trimmed}' is not a valid URL`,
      'Pass a Jimeng legacy canvas URL or a project id.',
    );
  }
  const host = url.hostname.toLowerCase();
  if (host && host !== 'jimeng.jianying.com' && host !== 'www.jimeng.jianying.com') {
    throw new ArgumentError(
      `Invalid 'canvas' URL host: '${url.hostname}'`,
      'Legacy canvas URLs must be on jimeng.jianying.com.',
    );
  }
  const match = url.pathname.match(/\/ai-tool\/canvas\/([^/]+)\/?$/);
  if (!match) {
    throw new ArgumentError(
      `Invalid 'canvas' URL path: '${url.pathname}'`,
      'Legacy canvas URLs look like https://jimeng.jianying.com/ai-tool/canvas/<projectId>.',
    );
  }
  const projectId = decodeURIComponent(match[1]);
  if (!V0_PROJECT_ID_PATTERN.test(projectId)) {
    throw new ArgumentError(
      `Invalid 'canvas' URL project id: '${projectId}'`,
      'Pass the numeric project id from the canvas URL.',
    );
  }
  return { mode: 'existing', value: projectId, projectId };
}

function assertKnownInputKeys(kwargs, allowed, caller) {
  for (const key of Object.keys(kwargs)) {
    // The CLI host injects its own bookkeeping keys; kebab-case flags arrive
    // next to their internal aliases from fromCliArgs.
    if (key.startsWith('_')) continue;
    const normalized = key.replace(/-/g, '_');
    if (!allowed.includes(normalized)) {
      throw new ArgumentError(
        `${caller}: unexpected argument '${key}'`,
        `Supported arguments: ${allowed.join(', ')}.`,
      );
    }
  }
}

function assertCanonicalShape(result) {
  for (const key of Object.keys(result)) {
    if (!CANONICAL_ASK_KEYS.includes(key)) {
      throw new Error(`normalizeCanvasV0AskArgs: unexpected key '${key}'`);
    }
  }
  for (const key of CANONICAL_ASK_KEYS) {
    if (!(key in result)) {
      throw new Error(`normalizeCanvasV0AskArgs: missing canonical key '${key}'`);
    }
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

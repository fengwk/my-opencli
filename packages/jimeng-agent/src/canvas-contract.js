/**
 * jimeng-agent canvas-video — identity + shared ask-contract normalization.
 *
 * Reuses generate-page prompt/media/model assembly from normalizeAskArgs.
 * Canvas identity is `new` or an existing project id (optionally a full URL).
 */

import { ArgumentError } from '@jackwener/opencli/errors';

import { normalizeAskArgs } from './contract.js';

export const JIMENG_DOMAIN = 'jimeng.jianying.com';
export const JIMENG_CANVAS_ORIGIN = `https://${JIMENG_DOMAIN}`;
export const JIMENG_CANVAS_PATH = '/ai-tool/ai-canvas';
export const JIMENG_CANVAS_URL = `${JIMENG_CANVAS_ORIGIN}${JIMENG_CANVAS_PATH}`;
export const CANVAS_NEW = 'new';
export const CANVAS_CREATE_QUERY = 'enter_from=page_click&from_page=create';

const CANONICAL_KEYS = Object.freeze([
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
export function normalizeCanvasIdentity(raw) {
  if (raw === undefined || raw === null) {
    throw new ArgumentError(
      "Missing required argument: 'canvas'",
      'Pass --canvas new to create a canvas, or --canvas <projectId> for an existing one.',
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
  if (trimmed.toLowerCase() === CANVAS_NEW) {
    return { mode: 'new', value: CANVAS_NEW, projectId: '' };
  }

  const fromUrl = parseCanvasLocator(trimmed);
  if (fromUrl) return fromUrl;

  if (/\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new ArgumentError(
      `Invalid 'canvas': '${raw}' is not 'new', a project id, or a Jimeng canvas URL`,
      'Pass --canvas new, --canvas <projectId>, or a /ai-tool/ai-canvas URL.',
    );
  }
  if (trimmed.toLowerCase() === 'project-copy') {
    throw new ArgumentError(
      "Invalid 'canvas': 'project-copy' is not a project id",
      'Pass the project id from the canvas URL path /ai-tool/ai-canvas/<projectId>.',
    );
  }
  return { mode: 'existing', value: trimmed, projectId: trimmed };
}

export function buildCanvasUrl(identity, options = {}) {
  const resolved = typeof identity === 'string'
    ? normalizeCanvasIdentity(identity)
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
        'Existing canvas requires a project id',
        'Pass --canvas <projectId>.',
      );
    }
    return `${JIMENG_CANVAS_URL}/${encodeURIComponent(projectId)}`;
  }
  return `${JIMENG_CANVAS_URL}?${CANVAS_CREATE_QUERY}`;
}

export function parseProjectIdFromHref(href) {
  const text = String(href || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, JIMENG_CANVAS_ORIGIN);
    const match = url.pathname.match(/\/ai-tool\/ai-canvas\/([^/]+)\/?$/);
    if (!match) return '';
    const id = decodeURIComponent(match[1]);
    if (!id || id.toLowerCase() === 'project-copy') return '';
    return id;
  } catch {
    return '';
  }
}

export function normalizeCanvasAskArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }
  const identity = normalizeCanvasIdentity(kwargs.canvas);
  const title = normalizeCanvasTitle(kwargs.title, identity);
  const shared = normalizeAskArgs({
    ...kwargs,
    workspace: identity.mode === 'new' ? 'canvas-new' : identity.projectId,
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

export function normalizeCanvasTitle(raw, identity) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid 'title': expected string, got ${describeType(raw)}`,
      'Pass a non-empty canvas title with at most 60 characters.',
    );
  }
  const title = raw.trim();
  if (!title) {
    throw new ArgumentError(
      "Invalid 'title': value is blank",
      'Omit --title or pass a non-empty title.',
    );
  }
  if (title.length > 60) {
    throw new ArgumentError(
      `Invalid 'title': length ${title.length} exceeds 60 characters`,
      'Jimeng canvas titles support at most 60 characters.',
    );
  }
  if (identity?.mode !== 'new') {
    throw new ArgumentError(
      "'title' is only valid when --canvas new is used",
      'Existing canvases are never renamed by canvas-video; omit --title.',
    );
  }
  return title;
}

export function evaluateCanvasPreInputControls(snapshot) {
  const checks = {
    canvasReady: snapshot?.canvasReady === true,
    sidecarOpen: snapshot?.sidecarOpen === true,
    editorReady: snapshot?.editorReady === true,
  };
  if (snapshot?.requireAddControl !== false) {
    checks.addControlReady = snapshot?.addControlReady === true;
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

export function evaluateCanvasContentCheckpoint(snapshot, expectations) {
  const expectedReferences = Number(expectations?.expectedReferences ?? 0);
  const expectedLabels = Array.isArray(expectations?.expectedChipLabels)
    ? expectations.expectedChipLabels
    : (Array.isArray(expectations?.mentionLabels) ? expectations.mentionLabels : []);
  const expectedMentionLabels = Array.isArray(expectations?.expectedMentionLabels)
    ? expectations.expectedMentionLabels
    : [];
  const observedLabels = Array.isArray(snapshot?.observedChipLabels)
    ? snapshot.observedChipLabels
    : [];
  const observedMentionLabels = Array.isArray(snapshot?.richMentionLabels)
    ? snapshot.richMentionLabels
    : [];
  const checks = {
    surfaceReady: snapshot?.surfaceReady === true,
    referenceCount: Number(snapshot?.referenceCount) === expectedReferences,
    chipLabelsCoverExpected: labelsCoverExpected(observedLabels, expectedLabels),
    richMentionCount: Number(snapshot?.richMentionCount ?? 0) === expectedMentionLabels.length,
    richMentionsInOrder: mentionLabelsMatchExpected(observedMentionLabels, expectedMentionLabels),
    noProcessing: snapshot?.processingCount === 0,
    noMentionMenu: snapshot?.menuVisible !== true,
    assetIdPresent: snapshot?.assetIdPresent === true,
    promptAnchorsInOrder: anchorsInOrder(
      snapshot?.editorTextNormalized || '',
      expectations?.textAnchors || [],
    ),
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
    phase: 'checkpoint',
    expected: {
      references: expectedReferences,
      mentionLabels: expectedLabels,
      richMentionLabels: expectedMentionLabels,
      textAnchors: expectations?.textAnchors || [],
    },
    observed: {
      referenceCount: snapshot?.referenceCount ?? null,
      chipLabels: observedLabels,
      richMentionCount: snapshot?.richMentionCount ?? null,
      richMentionLabels: observedMentionLabels,
      processingCount: snapshot?.processingCount ?? null,
      submitEnabled: snapshot?.submitEnabled ?? null,
    },
  };
}

function parseCanvasLocator(trimmed) {
  let url;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      url = new URL(trimmed);
    } else if (trimmed.startsWith('/ai-tool/ai-canvas')) {
      url = new URL(trimmed, JIMENG_CANVAS_ORIGIN);
    } else {
      return null;
    }
  } catch {
    throw new ArgumentError(
      `Invalid 'canvas': '${trimmed}' is not a valid URL`,
      'Pass a Jimeng canvas URL or a project id.',
    );
  }
  const host = url.hostname.toLowerCase();
  if (host && host !== JIMENG_DOMAIN && host !== 'www.jimeng.jianying.com') {
    throw new ArgumentError(
      `Invalid 'canvas' URL host: '${url.hostname}'`,
      `Canvas URLs must be on ${JIMENG_DOMAIN}.`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === JIMENG_CANVAS_PATH) {
    return { mode: 'new', value: CANVAS_NEW, projectId: '' };
  }
  const match = pathname.match(/\/ai-tool\/ai-canvas\/([^/]+)$/);
  if (!match) {
    throw new ArgumentError(
      `Invalid 'canvas' URL path: '${url.pathname}'`,
      'Expected /ai-tool/ai-canvas or /ai-tool/ai-canvas/<projectId>.',
    );
  }
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw new ArgumentError(
      `Invalid 'canvas' project id encoding: '${match[1]}'`,
      'Pass a valid project id from /ai-tool/ai-canvas/<projectId>.',
    );
  }
  if (!id || id.toLowerCase() === 'project-copy') {
    throw new ArgumentError(
      `Invalid 'canvas' project id in URL: '${match[1]}'`,
      'Pass the project id from /ai-tool/ai-canvas/<projectId>.',
    );
  }
  return { mode: 'existing', value: id, projectId: id };
}

function labelsCoverExpected(observed, expected) {
  if (expected.length === 0) return true;
  const compactObserved = observed.map(compactLabel);
  return expected.every((expectedLabel) => {
    const alternatives = Array.isArray(expectedLabel) ? expectedLabel : [expectedLabel];
    return alternatives.some((label) => {
      const needle = compactLabel(label);
      if (!needle) return false;
      return compactObserved.some((item) => {
        if (item.includes(needle) || needle.includes(item)) return true;
        const parts = item.split(/[…\u2026.]+/).filter((p) => p.length >= 2);
        return parts.length > 0 && parts.every((p) => needle.includes(p));
      });
    });
  });
}

function compactLabel(value) {
  return String(value || '').replace(/[\s\u00a0\u200b]/g, '').toLocaleLowerCase();
}

function mentionLabelsMatchExpected(observed, expected) {
  if (observed.length !== expected.length) return false;
  return expected.every((expectedLabel, index) => {
    const haystack = compactLabel(observed[index]);
    const needle = compactLabel(expectedLabel);
    if (!haystack || !needle) return false;
    if (haystack === needle || haystack === `@${needle}`) return true;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@?${escaped}(?!\\p{N})`, 'u').test(haystack);
  });
}

function anchorsInOrder(haystack, anchors) {
  let cursor = 0;
  for (const anchor of anchors) {
    if (!anchor) continue;
    const index = haystack.indexOf(anchor, cursor);
    if (index < 0) return false;
    cursor = index + anchor.length;
  }
  return true;
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertCanonicalShape(result) {
  for (const key of CANONICAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`normalizeCanvasAskArgs: missing canonical key '${key}'`);
    }
  }
  for (const key of Object.keys(result)) {
    if (!CANONICAL_KEYS.includes(key)) {
      throw new Error(`normalizeCanvasAskArgs: unexpected key '${key}' in result`);
    }
  }
}

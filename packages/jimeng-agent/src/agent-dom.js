/**
 * Visible-UI Jimeng Agent preparation, checkpoint, and optional submit.
 *
 * Flow:
 *   clear draft
 *   -> Agent/Auto/video configuration
 *   -> pre-input controls check (mode/preference only)
 *   -> upload refs -> write prompt/mentions
 *   -> content checkpoint (references + prompt only)
 *   -> optional formal submit (--submit 1) only when content checkpoint passes
 *
 * Mention selection atomically revalidates and clicks one unique candidate.
 * Generation is never submitted unless the content checkpoint is green and
 * the caller explicitly requests submit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

import {
  buildCheckpointExpectations,
  evaluateContentCheckpoint,
  evaluatePreInputControls,
  normalizePromptValidationLines as normalizeCheckpointLines,
  normalizePromptValidationText as normalizeCheckpointText,
} from './checkpoint.js';

import {
  JIMENG_CONVERSATION_PATH,
  classifySubmitAck,
  isConversationUrl,
  normalizeCaptureEntry,
} from './submit-ack.js';

import {
  cardIdentity,
  countVisibleMediaReferences,
  hasUploadBusyText,
  hasCollapsedReferenceMore,
  isNewUploadCard,
  isProcessingCard,
  isUploadSlotEntry,
  observeCurrentUploadFailure,
  parseReferenceCountStyle,
} from './upload-state.js';

export const JIMENG_DOMAIN = 'jimeng.jianying.com';
export const JIMENG_GENERATE_URL = `https://${JIMENG_DOMAIN}/ai-tool/generate`;

const EDITOR_SELECTOR = '.tiptap.ProseMirror[contenteditable="true"]';
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const MENTION_NODE_SELECTOR = [
  '[contenteditable="false"]',
  '[data-type*="mention"]',
  '[data-node-type*="mention"]',
  '[class*="mention"]',
].join(', ');
const MENTION_OPTION_SELECTOR = [
  'li[role="option"]',
  '.lv-select-option',
  '[class*="option-item"]',
  '[class*="mention-item"]',
].join(', ');
const LEADING_MENTION_GUARD = '\u200b';
const UPLOAD_SLOT_ATTR = 'data-opencli-jimeng-upload-slot';
const UPLOAD_ALERT_BASELINE_ATTR = 'data-opencli-jimeng-upload-alert-baseline';
const UPLOAD_ALERT_ID_ATTR = 'data-opencli-jimeng-upload-alert-id';
const UPLOAD_ALERT_REGISTRY_KEY = '__opencliJimengUploadAlertBaselineRegistry';
const TARGET_ATTR = 'data-opencli-jimeng-target';
const MENTION_DEBUG_ENABLED_ENV = 'OPENCLI_JIMENG_MENTION_DEBUG';
const MENTION_DEBUG_SLEEP_ENV = 'OPENCLI_JIMENG_MENTION_DEBUG_SLEEP_MS';
const MENTION_DEBUG_ROOT_ENV = 'OPENCLI_JIMENG_MENTION_DEBUG_ROOT';
const MENTION_DEBUG_STOP_ENV = 'OPENCLI_JIMENG_MENTION_DEBUG_STOP';

export function resolveMentionDebugOptions(env = process.env) {
  const enabled = /^(?:1|true|yes|on)$/i.test(String(env[MENTION_DEBUG_ENABLED_ENV] ?? '').trim());
  if (!enabled) {
    return {
      enabled: false,
      sleepMs: 0,
      artifactRoot: null,
    };
  }

  const rawSleep = String(env[MENTION_DEBUG_SLEEP_ENV] ?? '3000').trim();
  const sleepMs = Number(rawSleep);
  if (!Number.isSafeInteger(sleepMs) || sleepMs < 0 || sleepMs > 30_000) {
    throw new ArgumentError(
      `${MENTION_DEBUG_SLEEP_ENV} must be an integer in [0, 30000]`,
      `Set ${MENTION_DEBUG_SLEEP_ENV}=3000 for a three-second visual pause.`,
    );
  }

  const configuredRoot = String(env[MENTION_DEBUG_ROOT_ENV] ?? '').trim();
  const stopPhase = String(env[MENTION_DEBUG_STOP_ENV] ?? 'after-click').trim();
  if (!['before-click', 'after-click'].includes(stopPhase)) {
    throw new ArgumentError(
      `${MENTION_DEBUG_STOP_ENV} must be 'before-click' or 'after-click'`,
      `Set ${MENTION_DEBUG_STOP_ENV}=before-click to leave the candidate open for a manual click.`,
    );
  }
  return {
    enabled: true,
    sleepMs,
    artifactRoot: configuredRoot ? path.resolve(configuredRoot) : os.tmpdir(),
    stopPhase,
  };
}

export function buildWorkspaceUrl(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new ArgumentError(
      'Jimeng workspace must be a non-empty string',
      'Pass --workspace <workspace-id>.',
    );
  }
  return `${JIMENG_GENERATE_URL}?workspace=${encodeURIComponent(workspace.trim())}`;
}

/**
 * Split the exact agent prompt into text and rich-mention operations.
 * `normalizeAskArgs` already validates every placeholder; this defensive
 * lookup prevents accidental plaintext fallback if a caller bypasses it.
 */
export function buildMentionSegments(agentPrompt, assets) {
  if (typeof agentPrompt !== 'string') {
    throw new ArgumentError('agentPrompt must be a string', 'Use normalizeAskArgs before DOM preparation.');
  }
  if (!Array.isArray(assets)) {
    throw new ArgumentError('assets must be an array', 'Use prepareBrowserReferenceAssets before DOM preparation.');
  }

  const byLabel = new Map(assets.map((asset) => [asset.label, asset]));
  const parts = [];
  const appendText = (value) => {
    const lines = value.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]) parts.push({ type: 'text', value: lines[i] });
      if (i + 1 < lines.length) parts.push({ type: 'newline', value: '\n' });
    }
  };
  const tokenPattern = /@(图片|视频|音频)([1-9]\d*)/g;
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(agentPrompt)) !== null) {
    if (match.index > cursor) {
      appendText(agentPrompt.slice(cursor, match.index));
    }
    const label = `${match[1]}${match[2]}`;
    const asset = byLabel.get(label);
    if (!asset) {
      throw new ArgumentError(
        `Prompt references '${label}' but no prepared upload matches it`,
        'Ensure every @图片N / @视频N / @音频N reference has a corresponding local asset.',
      );
    }
    parts.push({ type: 'mention', label, asset });
    cursor = tokenPattern.lastIndex;
  }
  if (cursor < agentPrompt.length) {
    appendText(agentPrompt.slice(cursor));
  }
  return parts;
}

export function mentionTextMatchesVariant(name, variant) {
  const compact = (value) => String(value || '').replace(/[\s\u00a0\u200b]/g, '').toLocaleLowerCase();
  const haystack = compact(name);
  const needle = compact(variant);
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Jimeng option text is often compacted to "图片1hero.png". Treat 图片1 as a
  // match there, but reject 图片10 because the label continues with a digit.
  return new RegExp(`${escaped}(?!\\p{N})`, 'u').test(haystack);
}

/**
 * Retry decisions are pure to make the "avoid refresh when possible" policy
 * auditable. An in-page retry is allowed once for a healthy failed upload;
 * any later retry opens a fresh workspace and starts from the first asset.
 *
 * Clear/mention/prompt/surface failures always prefer a full page reload —
 * in-page resume is too weak when reference cards are stuck or the composer
 * is in an unknown state.
 */
export function chooseRetryPlan({
  retriesUsed,
  retryBudget,
  priorInPlaceRetry,
  errorPhase,
  failedAssetIndex,
  surface,
  retryable,
}) {
  if (retriesUsed >= retryBudget) return { kind: 'stop' };
  if (retryable === false) return { kind: 'stop' };

  if (
    errorPhase === 'submit'
    || errorPhase === 'submit-unconfirmed'
    || errorPhase === 'submit-rejected'
    || errorPhase === 'submit-capture-unavailable'
  ) {
    return { kind: 'stop' };
  }

  if (errorPhase === 'submit-not-sent' || errorPhase === 'submit-button-missing') {
    return { kind: 'fresh', startAssetIndex: 0 };
  }

  const forceFreshPhases = new Set([
    'clear-initial',
    'clear-references',
    'clear-after-upload',
    'mention',
    'prompt',
    'surface',
  ]);
  if (forceFreshPhases.has(errorPhase)) {
    return { kind: 'fresh', startAssetIndex: 0 };
  }

  if (
    errorPhase === 'upload'
    && !priorInPlaceRetry
    && Number.isInteger(failedAssetIndex)
    && failedAssetIndex >= 0
    && surface?.ready === true
    && surface.fileInputCount > 0
  ) {
    return { kind: 'resume', startAssetIndex: failedAssetIndex };
  }
  return { kind: 'fresh', startAssetIndex: 0 };
}

/**
 * Navigate, configure Agent + Auto/video preference, upload all references,
 * and populate the prompt with rich mention nodes. No submission is performed.
 */
export async function prepareJimengAgentAsk(page, canonical, preparedAssets, options = {}) {
  assertPageCapabilities(page);
  if (!canonical || typeof canonical !== 'object') {
    throw new ArgumentError('canonical ask payload is required', 'Use normalizeAskArgs before browser preparation.');
  }
  if (!Array.isArray(preparedAssets)) {
    throw new ArgumentError(
      'preparedAssets must be an array',
      'Use prepareBrowserReferenceAssets before browser preparation.',
    );
  }

  const workspaceUrl = buildWorkspaceUrl(canonical.workspace);
  const uploads = [];
  let retriesUsed = 0;
  let priorInPlaceRetry = false;
  let startAssetIndex = 0;
  let clearRefreshUsed = false;
  let baselineSlots = 0;
  const mentionDebug = createMentionDebugSession(resolveMentionDebugOptions());

  // Always start with a fresh reload: chat history + leftover reference cards
  // are otherwise invisible to clearReferenceAssets (X only on hover) and
  // would inflate the referenceCount for the next upload.
  await openWorkspace(page, workspaceUrl);

  while (true) {
    try {
      await waitForAgentSurface(page);
      if (process.env.OPENCLI_JIMENG_SURFACE_VERBOSE) {
        const s = await probeJimengAgentSurface(page);
        console.error(`[jimeng-agent] surface modeText=${JSON.stringify(s.modeText)} dockText=${JSON.stringify(s.dockText)} agentSelected=${s.agentSelected} autoEnabled=${s.autoEnabled} videoSelected=${s.videoSelected} autoFromDock=${s.autoFromDock} autoPopupOpen=${s.autoPopupOpen} editorReady=${s.editorReady} fileInputs=${s.fileInputCount}`);
      }
      if (startAssetIndex === 0) {
        baselineSlots = await clearInitialDraftState(page);
      }
      await selectAgentMode(page);
      await configureAutoVideoPreference(page);
      // Preference panel is still the source of truth for Auto/Video. Verify it
      // here, then close it before any upload/prompt typing.
      await runPreInputControlsCheck(page);
      await closeVisiblePreferenceTooltip(page);
      await uploadReferenceAssets(page, preparedAssets, uploads, startAssetIndex, baselineSlots);
      // Jimeng may insert an uploaded reference chip at the document start.
      // Match the established flow: clear that platform-added draft state
      // before writing the canonical prompt and its explicit @ mentions.
      await clearComposer(page, 'clear-after-upload');
      await fillPromptWithRichMentions(page, canonical.agentPrompt, preparedAssets, mentionDebug);

      const checkpoint = await runContentCheckpoint(
        page,
        canonical.agentPrompt,
        preparedAssets,
        { requireSubmitArmed: !!canonical.submit },
      );
      let submitted = false;
      let submitResult = null;
      if (canonical.submit) {
        submitResult = await submitPreparedGeneration(page, canonical, options);
        submitted = submitResult?.confirmation === 'ack_confirmed';
        if (!submitted) {
          const err = new Error('Submit helper returned without an explicit confirmed ACK');
          err.phase = 'submit-unconfirmed';
          err.retryable = false;
          err.nonRetryable = true;
          err.hint = 'Generation state is uncertain. Do not automatically retry.';
          throw err;
        }
      }

      return {
        status: submitted ? 'submitted' : 'prepared',
        workspace: canonical.workspace,
        workspaceUrl,
        uploaded: uploads.map((asset) => asset.filename),
        mentions: checkpoint.expected.mentions,
        assetId: canonical.assetId,
        retryUsed: retriesUsed,
        submitted,
        checkpointOk: true,
        confirmation: submitResult?.confirmation ?? (submitted ? 'ack_confirmed' : 'none'),
        threadId: submitResult?.threadId ?? '',
        conversationId: submitResult?.conversationId ?? '',
        submitRequestCount: submitResult?.submitRequestCount ?? (submitted ? 1 : 0),
      };
    } catch (err) {
      const failure = normalizePreparationError(err, uploads.length);
      const surface = await probeJimengAgentSurface(page).catch(() => ({
        ready: false,
        fileInputCount: 0,
      }));

      // Clear-path failures: always hard-reload (not soft same-URL skip).
      if (
        (failure.phase === 'clear-initial'
          || failure.phase === 'clear-references'
          || failure.phase === 'clear-after-upload')
        && !clearRefreshUsed
      ) {
        clearRefreshUsed = true;
        priorInPlaceRetry = false;
        startAssetIndex = 0;
        uploads.splice(0);
        await openWorkspace(page, workspaceUrl);
        continue;
      }

      const plan = chooseRetryPlan({
        retriesUsed,
        retryBudget: canonical.retry ?? 0,
        priorInPlaceRetry,
        errorPhase: failure.phase,
        failedAssetIndex: failure.failedAssetIndex,
        surface,
        retryable: failure.retryable,
      });

      if (plan.kind === 'stop') {
        const isUnconfirmed = failure.phase === 'submit-unconfirmed';
        const isRejected = failure.phase === 'submit-rejected';
        const isSubmitFailure = typeof failure.phase === 'string' && failure.phase.startsWith('submit');

        let errPrefix = 'JIMENG_PREPARE_FAILED';
        let hint = '';

        if (isUnconfirmed) {
          errPrefix = 'JIMENG_SUBMIT_UNCONFIRMED';
          hint = `${failure.hint} 可能已受理时不要重试，请手动检查 Jimeng 任务列表。`;
        } else if (isRejected) {
          errPrefix = 'JIMENG_SUBMIT_REJECTED';
          hint = `${failure.hint} 服务端已明确拒绝，请勿盲目重试。`;
        } else if (isSubmitFailure) {
          errPrefix = 'JIMENG_SUBMIT_FAILED';
          hint = `No generation was submitted. ${failure.hint} Inspect the visible Jimeng workspace and retry.`;
        } else {
          hint = `No generation was submitted. ${failure.hint} Retry with --retry ${Number(canonical.retry ?? 0) + 1} after checking the visible Jimeng workspace.`;
        }

        throw new CommandExecutionError(
          `${errPrefix}: ${failure.message}`,
          hint,
        );
      }

      retriesUsed += 1;
      if (plan.kind === 'resume') {
        priorInPlaceRetry = true;
        startAssetIndex = plan.startAssetIndex;
        uploads.splice(startAssetIndex);
        continue;
      }

      priorInPlaceRetry = false;
      startAssetIndex = 0;
      uploads.splice(0);
      await openWorkspace(page, workspaceUrl);
    }
  }
}

/**
 * Collect raw reference-strip facts from the visible dock.
 *
 * The dock reference strip (`references-<hash>`) only renders while cards
 * exist, so an absent strip means zero cards. History-message chips use
 * different classes and are excluded by filtering candidates to the dock
 * band around the prompt editor and away from history containers.
 *
 * Returns plain data; the stable derivations (card count / identity /
 * processing) are computed here in Node from the pure helpers so the
 * decisions are unit-testable.
 */
async function collectDockReferenceSnapshot(page, alertBaselineMarker = '') {
  const raw = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    // \`visible\` comes from buildPromptEditorLocatorScript().
    const editor = findPromptEditor();
    const editorRect = editor ? editor.getBoundingClientRect() : null;
    const editorTop = editorRect ? editorRect.top : -1;
    const editorBottom = editorRect ? editorRect.bottom : -1;
    const stripCandidates = [...document.querySelectorAll('[class]')]
      .filter((el) => [...el.classList].some((c) => /^references-[A-Za-z0-9_-]+$/.test(c)));
    const strips = stripCandidates
      .filter((strip) => {
        if (!visible(strip)) return false;
        const rect = strip.getBoundingClientRect();
        // The dock strip sits on the same row as the composer, never far
        // above it (history bubbles sit much higher).
        if (editorTop >= 0 && (rect.top < editorTop - 220 || rect.top > editorBottom + 60)) {
          return false;
        }
        // Skip strips nested inside obvious history containers.
        for (let node = strip.parentElement; node; node = node.parentElement) {
          if (/record|message|history/i.test(String(node.className || '')) && !node.querySelector('.tiptap')) {
            return false;
          }
        }
        return true;
      })
      .map((strip) => ({
        classes: [...strip.classList],
        groupStyle: (() => {
          const group = [...strip.querySelectorAll('[class]')].find((el) =>
            [...el.classList].some((c) => /^reference-group-[A-Za-z0-9_-]+$/.test(c)));
          return group ? group.getAttribute('style') || '' : '';
        })(),
        descendants: [...strip.querySelectorAll('[class]')].map((el) => {
          const media = el.querySelector('img[src], video[src], audio[src]');
          const rect = el.getBoundingClientRect();
          return {
            classes: [...el.classList],
            dataIndex: el.getAttribute('data-index'),
            text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
            hasSpin: !!el.querySelector('.spin, [class*="spin-"]'),
            hasMask: !!el.querySelector('[class*="mask-"]'),
            hasRemoveBtn: !!el.querySelector('[data-reference-remove-button="true"]'),
            hasUploadSlot: !!el.querySelector('[class*="reference-upload-"]'),
            hasMoreEntry: !!el.querySelector('[class*="collapsed-more-entry-"]'),
            mediaSrc: media
              ? media.getAttribute('src') || media.getAttribute('poster') || null
              : null,
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }),
      }));
    // Capture visible live toasts/alerts separately from chat history. Upload
    // callers compare them with their pre-upload baseline before attribution.
    const scopedAlerts = [...document.querySelectorAll('[role="alert"], [class*="toast-"], [class^="toast"], [class*="Toast"]')]
      .filter(visible)
      .map((el) => {
        const id = el.getAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)}) || '';
        const registry = window[${JSON.stringify(UPLOAD_ALERT_REGISTRY_KEY)}]?.[${JSON.stringify(alertBaselineMarker)}];
        return {
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(),
          baselineId: (
            el.getAttribute(${JSON.stringify(UPLOAD_ALERT_BASELINE_ATTR)}) === ${JSON.stringify(alertBaselineMarker)}
            && id
            && registry?.[id] === el
          ) ? id : '',
        };
      })
      .filter((alert) => alert.text);
    return { ok: true, editorTop, alerts: scopedAlerts, strips };
  })()`);

  if (!raw?.ok) {
    return {
      ok: false,
      editorTop: -1,
      alerts: [],
      strips: 0,
      count: 0,
      cards: [],
      hasCollapsedMoreEntry: false,
      busy: false,
    };
  }

  const cards = [];
  for (const strip of raw.strips || []) {
    for (const entry of strip.descendants || []) {
      let isCard = false;
      for (const name of entry.classes || []) {
        if (name.startsWith('reference-item-content-')) {
          isCard = false;
          break;
        }
        if (name.startsWith('reference-item-')) {
          isCard = true;
          break;
        }
      }
      if (isCard) cards.push({ ...entry, identity: cardIdentity(entry) });
    }
  }

  const count = cards.length;
  const hasCollapsedMoreEntry = hasCollapsedReferenceMore(cards);
  const processingCards = cards.filter((card) => isProcessingCard(card));
  const busy = processingCards.length > 0;
  const countFromStyle = raw.strips
    .map((strip) => parseReferenceCountStyle(strip.groupStyle))
    .find((value) => value !== null);

  return {
    ok: true,
    editorTop: raw.editorTop,
    alerts: raw.alerts || [],
    strips: raw.strips.length,
    count,
    countFromStyle,
    cards,
    hasCollapsedMoreEntry,
    processing: processingCards.length,
    busy,
  };
}

/**
 * Visible page health snapshot. It intentionally exposes only UI state and
 * does not call hidden application endpoints or inspect internal stores.
 */
export async function probeJimengAgentSurface(page) {
  const surface = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const readable = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\\s+/g, ' ')
      .trim();
    const editors = [...document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR)})].filter(visible);
    const editor = findPromptEditor();
    const fileInputs = [...document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)})];
    const comboboxes = [...document.querySelectorAll('[role="combobox"]')].filter(visible);
    const modeText = comboboxes.map(readable).join(' | ');

    // Current Jimeng dock: "Agent 模式" combobox + standalone "自动" button
    // (not a second combobox). Collect dock control text near the editor.
    const dockRoots = [];
    if (editor) {
      let node = editor.parentElement;
      for (let i = 0; node && i < 10; i += 1, node = node.parentElement) dockRoots.push(node);
    }
    const dockScope = dockRoots[dockRoots.length - 1] || document.body;
    const dockControls = [...dockScope.querySelectorAll('button, [role="button"], [role="combobox"]')]
      .filter(visible)
      .map(readable)
      .filter(Boolean);
    const dockText = dockControls.join(' | ');

    const preferenceTooltips = [...document.querySelectorAll('[role="tooltip"]')]
      .filter(visible)
      .filter((tip) => (
        tip.querySelector('button[role="switch"]')
        && tip.querySelector('input[type="radio"][value="image"]')
        && tip.querySelector('input[type="radio"][value="video"]')
      ));
    const tooltip = preferenceTooltips.length === 1 ? preferenceTooltips[0] : null;
    const autoSwitch = tooltip?.querySelector('button[role="switch"]') || null;
    const videoRadio = tooltip?.querySelector('input[type="radio"][value="video"]') || null;
    const alertTexts = [...document.querySelectorAll('[role="alert"]')]
      .filter(visible)
      .map(readable)
      .filter(Boolean);
    const mentionNodes = editor
      ? [...editor.querySelectorAll(${JSON.stringify(MENTION_NODE_SELECTOR)})]
        .filter(visible)
        .filter((node) => {
          const compact = readable(node).replace(/\\s+/g, '');
          const metadata = [
            node.className,
            node.getAttribute('data-type'),
            node.getAttribute('data-node-type'),
          ].join(' ');
          return /(?:图片|视频|音频)\\d+/.test(compact) || /mention/i.test(metadata);
        })
      : [];
    // Auto is enabled when the dock shows the 自动 chip/button, or the open
    // preference switch is aria-checked=true.
    const autoFromDock = /(?:^|[|\\s])自动(?:$|[|\\s])/.test(dockText.replace(/\\s+/g, ''))
      || dockControls.some((t) => t.replace(/\\s+/g, '') === '自动' || /^自动/.test(t.replace(/\\s+/g, '')));
    return {
      url: location.href,
      editorCount: editors.length,
      editorReady: !!editor,
      editorText: editor ? (editor.innerText || editor.textContent || '').replace(/\\u00a0/g, ' ') : '',
      fileInputCount: fileInputs.length,
      fileInputs: fileInputs.map((input, index) => ({
        id: input.id || '',
        accept: input.accept || '',
        multiple: !!input.multiple,
        index,
      })),
      modeText,
      dockText,
      agentSelected: /Agent\\s*模式/i.test(modeText) || /Agent\\s*模式/i.test(dockText),
      autoPopupOpen: !!tooltip,
      preferencePopupCount: preferenceTooltips.length,
      autoEnabled: autoSwitch?.getAttribute('aria-checked') === 'true' || (!tooltip && autoFromDock),
      // Video radio is only readable while the preference tooltip is open.
      // When closed, if Auto is already on the dock, treat video as selected
      // for Agent video workflows (do not force-open the dropdown just to re-read).
      videoSelected: !!videoRadio?.checked || (!tooltip && autoFromDock),
      autoFromDock,
      mentionCount: mentionNodes.length,
      alerts: alertTexts,
      ready: !!editor && fileInputs.length > 0,
    };
  })()`);

  const dock = await collectDockReferenceSnapshot(page);
  return {
    ...surface,
    // Reference cards are counted from the dock reference strip, never from
    // remove-button attributes (those only exist/hover on some UI versions).
    referenceCount: dock.count,
    referenceMoreEntry: dock.hasCollapsedMoreEntry === true,
    referenceStripFound: dock.strips > 0,
    referenceProcessingCount: dock.processing,
    uploadBusy: dock.busy,
  };
}

/**
 * Open the Jimeng workspace in the current tab.
 *
 * Every prepare path reloads (`fresh`) so Jimeng's server-side draft
 * (reference cards + composer text) is re-rendered deterministically before
 * clear/upload. Never opens a new tab.
 */
async function openWorkspace(page, workspaceUrl) {
  await page.goto(workspaceUrl);
}

async function waitForAgentSurface(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeJimengAgentSurface(page);
    if (last.ready) return last;
    await page.sleep(0.35);
  }
  throw phaseError(
    'surface',
    `Jimeng Agent composer did not become ready (editor=${last?.editorCount ?? 0}, fileInputs=${last?.fileInputCount ?? 0})`,
    'Open the Jimeng workspace in the automation tab, finish any interstitial, then retry.',
  );
}

async function selectAgentMode(page) {
  const before = await probeJimengAgentSurface(page);
  if (before.agentSelected) {
    await closeVisibleListbox(page);
    return;
  }

  const marker = nextMarker('mode');
  const marked = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    const ancestors = [];
    let node = editor.parentElement;
    for (let i = 0; node && i < 8; i += 1, node = node.parentElement) ancestors.push(node);
    const combobox = ancestors
      .flatMap((root) => [...root.querySelectorAll('[role="combobox"]')])
      .find(visible)
      || [...document.querySelectorAll('[role="combobox"]')].find(visible);
    if (!combobox) return { ok: false, reason: 'combobox-not-found' };
    combobox.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) {
    throw phaseError('mode', 'Could not locate Jimeng creation-mode combobox', 'Verify that the visible composer is loaded.');
  }
  await page.click(`[${TARGET_ATTR}="${marker}"]`);

  const optionMarker = nextMarker('agent-option');
  const option = await waitForMarker(page, optionMarker, `(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('[role="listbox"] [role="option"], li[role="option"]')]
      .filter(visible)
      .filter((el) => {
        const name = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
          .replace(/\\s+/g, ' ')
          .trim();
        return name === 'Agent 模式' || name.startsWith('Agent 模式 ');
      });
    if (candidates.length !== 1) return { ok: false, count: candidates.length };
    candidates[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(optionMarker)});
    return { ok: true };
  })()`, 8_000);
  if (!option.ok) {
    throw phaseError('mode', 'Could not find the Agent mode option in the creation-mode listbox', 'Confirm this account has Agent mode available.');
  }
  await page.click(`[${TARGET_ATTR}="${optionMarker}"]`);

  await waitForCondition(page, async () => (await probeJimengAgentSurface(page)).agentSelected, 8_000, 'Agent mode did not become selected');
  await closeVisibleListbox(page);
}

async function configureAutoVideoPreference(page) {
  // One-shot configuration of Auto + Video. Prefer nativeClick on real
  // coordinates; avoid fragile re-open loops of the preference dropdown.
  let surface = await probeJimengAgentSurface(page);

  // Fast path: dock already shows Agent + 自动. Do NOT open the preference
  // dropdown just to re-read radios (Hub flaky / blank-page side effects).
  if (!surface.autoPopupOpen && surface.agentSelected && (surface.autoFromDock || surface.autoEnabled)) {
    return;
  }

  if (!surface.autoPopupOpen) {
    const marker = nextMarker('auto');
    const marked = await markPreferenceControl(page, marker);
    if (!marked?.ok) {
      // Soft: if Agent is already on and dock shows 自动, skip.
      if (surface.agentSelected && (surface.autoFromDock || surface.autoEnabled)) return;
      throw phaseError('preference', 'Could not locate the Auto preference control', 'Verify that Agent mode is selected and the visible composer is complete.');
    }
    await page.click(`[${TARGET_ATTR}="${marker}"]`);
    await page.sleep(0.25);
    await waitForCondition(page, async () => (await probeJimengAgentSurface(page)).autoPopupOpen, 8_000, 'Auto preference popup did not open');
    surface = await probeJimengAgentSurface(page);
  }

  if (!surface.autoEnabled) {
    const switchMarker = nextMarker('auto-switch');
    const switchState = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const tooltips = [...document.querySelectorAll('[role="tooltip"]')]
        .filter(visible)
        .filter((tip) => (
          tip.querySelector('button[role="switch"]')
          && tip.querySelector('input[type="radio"][value="image"]')
          && tip.querySelector('input[type="radio"][value="video"]')
        ));
      if (tooltips.length !== 1) return { ok: false, popupCount: tooltips.length };
      const controls = [...tooltips[0].querySelectorAll('button[role="switch"]')].filter(visible);
      if (controls.length !== 1) return { ok: false, switchCount: controls.length };
      const control = controls[0];
      const rect = control.getBoundingClientRect();
      control.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(switchMarker)});
      return {
        ok: true,
        enabled: control.getAttribute('aria-checked') === 'true',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`);
    if (!switchState?.ok) {
      throw phaseError('preference', 'Auto preference switch disappeared before it could be enabled');
    }
    if (!switchState.enabled) {
      if (typeof page.nativeClick === 'function' && switchState.x && switchState.y) {
        await page.nativeClick(switchState.x, switchState.y);
      } else {
        await page.click(`[${TARGET_ATTR}="${switchMarker}"]`);
      }
      await page.sleep(0.25);
      await waitForCondition(
        page,
        async () => (await probeJimengAgentSurface(page)).autoEnabled,
        8_000,
        'Auto preference switch did not enable',
      );
    }
  }

  surface = await probeJimengAgentSurface(page);
  if (!surface.videoSelected) {
    const radioMarker = nextMarker('video-radio');
    const radioFound = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const tooltip = [...document.querySelectorAll('[role="tooltip"]')]
        .filter(visible)
        .find((tip) => tip.querySelector('input[type="radio"][value="video"]'));
      const input = tooltip?.querySelector('input[type="radio"][value="video"]');
      if (!input) return { ok: false };
      const clickTarget = input.closest('label') || input;
      const rect = clickTarget.getBoundingClientRect();
      clickTarget.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(radioMarker)});
      return {
        ok: true,
        x: Math.round(rect.left + Math.max(8, rect.width / 2)),
        y: Math.round(rect.top + Math.max(6, rect.height / 2)),
      };
    })()`);
    if (!radioFound?.ok) {
      throw phaseError(
        'preference',
        'Video output preference is not available in the visible Auto popup',
        'This workspace/account may not have Jimeng Agent video capability enabled.',
      );
    }
    // Prefer nativeClick: DOM click on hidden radio / label can be a no-op.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (typeof page.nativeClick === 'function' && radioFound.x && radioFound.y) {
        await page.nativeClick(radioFound.x, radioFound.y);
      } else {
        await page.click(`[${TARGET_ATTR}="${radioMarker}"]`);
      }
      await page.sleep(0.3);
      if ((await probeJimengAgentSurface(page)).videoSelected) break;
    }
    await waitForCondition(page, async () => (await probeJimengAgentSurface(page)).videoSelected, 5_000, 'Video output preference did not become selected');
  }

  // Close the preference card immediately so it never blocks upload/composer.
  await closeVisiblePreferenceTooltip(page).catch(() => null);
}

async function markPreferenceControl(page, marker) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    const roots = [];
    let node = editor.parentElement;
    for (let i = 0; node && i < 10; i += 1, node = node.parentElement) roots.push(node);
    const scope = roots[roots.length - 1] || document.body;
    const readable = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\\s+/g, '')
      .trim();

    // New UI: standalone button labeled 自动 next to Agent 模式 combobox.
    const autoButtons = [...scope.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((el) => {
        const t = readable(el);
        return t === '自动' || t.startsWith('自动');
      });
    if (autoButtons.length >= 1) {
      // Prefer the smallest leaf control in the composer dock.
      autoButtons.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });
      autoButtons[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
      return { ok: true, via: 'auto-button' };
    }

    // Legacy UI: combobox + sibling button + following combobox structure.
    const comboboxes = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('[role="combobox"]')]))]
      .filter(visible);
    const candidates = [...new Set(comboboxes.flatMap((combobox) => {
      const parent = combobox.parentElement;
      if (!parent) return [];
      const siblings = [...parent.children];
      const index = siblings.indexOf(combobox);
      const button = siblings[index + 1];
      if (!(button instanceof HTMLButtonElement) || !visible(button)) return [];
      const hasFollowingCombobox = siblings.slice(index + 2).some((sibling) => {
        if (sibling.matches('[role="combobox"]') && visible(sibling)) return true;
        const nested = sibling.querySelector('[role="combobox"]');
        return !!nested && visible(nested);
      });
      return hasFollowingCombobox ? [button] : [];
    }))];
    if (candidates.length !== 1) {
      return { ok: false, reason: 'structural-match-count', count: candidates.length };
    }
    candidates[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true, via: 'legacy-structure' };
  })()`);
}

async function clearInitialDraftState(page) {
  await clearComposer(page, 'clear-initial');
  const { keptSlots } = await clearReferenceAssets(page);
  const composer = await getComposerClearState(page);
  const surface = await probeJimengAgentSurface(page);
  // Empty upload slots cannot be removed by the UI; they are tolerated as
  // baseline because they expose no asset to the mention picker. Any other
  // leftover card would shift @图片N numbering and fails the cleanup.
  if (!composer.empty || surface.referenceCount !== keptSlots) {
    throw phaseError(
      'clear-initial',
      `Jimeng initial draft cleanup was incomplete (${composer.textLength} text character(s), ${composer.mentionCount} mention node(s), ${surface.referenceCount} reference card(s), ${keptSlots} unremovable slot(s))`,
      'No generation was submitted. Inspect the visible composer and reference strip before retrying.',
    );
  }
  return keptSlots;
}

/**
 * Remove removable reference cards from the dock strip.
 *
 * Jimeng renders the remove button (`[data-reference-remove-button="true"]`)
 * only after the reference group has been hovered, and it becomes clickable
 * while the specific card is hovered. We first hover the group area so the
 * buttons render, then hover the card itself, then click its remove button.
 *
 * Empty upload slots (draft references whose media is gone) expose no remove
 * control and cannot be cleared; they are kept and reported as `keptSlots` so
 * callers can treat them as baseline (they expose no asset to the mention
 * picker and do not shift @图片N numbering).
 *
 * Returns { removed, keptSlots }.
 */
async function markReferenceRemoveControl(page, marker) {
  return page.evaluate(`(() => {
    // The button may still be opacity-0 / zero-sized until the hover CSS
    // transition finishes; synthetic clicks do not need hit-testing, so only
    // exclude buttons that are not rendered at all (display:none / hidden).
    const candidates = [...document.querySelectorAll('[data-reference-remove-button="true"]')]
      .filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
    if (candidates.length === 0) return { ok: false, count: 0 };
    candidates[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true, count: candidates.length };
  })()`);
}

async function clearReferenceAssets(page) {
  const maxReferences = 24;
  for (let removed = 0; removed < maxReferences; removed += 1) {
    const before = await collectDockReferenceSnapshot(page);
    if (before.count === 0) return { removed, keptSlots: 0 };

    const removable = before.cards.find((entry) => (
      entry.identity
      && entry.width > 0
      && entry.height > 0
      && !isUploadSlotEntry(entry)
    ));
    if (!removable) {
      // Only empty upload slots remain — nothing can be removed.
      return { removed, keptSlots: before.count };
    }

    // Pass 1: hover the group so the remove buttons render into the DOM.
    await page.cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(removable.left + removable.width / 2),
      y: Math.round(removable.top + removable.height / 2),
    }).catch(() => null);
    await page.sleep(0.5);

    // Pass 2: hover the card element itself (real move + synthetic events).
    const cardX = Math.round(removable.left + removable.width / 2);
    const cardY = Math.round(removable.top + Math.max(8, removable.height / 2));
    await page.cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cardX,
      y: cardY,
    }).catch(() => null);
    await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('[class]')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          && Math.abs((r.left + r.width / 2) - ${cardX}) < 12
          && Math.abs((r.top + r.height / 2) - ${cardY}) < 12
          && /reference-item-/.test(String(el.className || ''));
      });
      if (!card) return;
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: ${cardX},
        clientY: ${cardY},
      };
      try { card.dispatchEvent(new PointerEvent('pointerover', init)); } catch (_) {}
      try { card.dispatchEvent(new PointerEvent('pointermove', init)); } catch (_) {}
      card.dispatchEvent(new MouseEvent('mouseover', init));
      card.dispatchEvent(new MouseEvent('mousemove', init));
      try { card.dispatchEvent(new MouseEvent('mouseenter', init)); } catch (_) {}
    })()`);
    await page.sleep(0.4);

    const marker = nextMarker(`reference-remove-${removed}`);
    let marked = await markReferenceRemoveControl(page, marker);
    if (!marked?.ok) {
      // Layout may have shifted since the snapshot (previous card removal
      // animates the strip), so re-collect and hover several hotspot points
      // around the card before giving up.
      const refreshed = await collectDockReferenceSnapshot(page);
      const target = (refreshed.cards || []).find((entry) => (
        entry.identity
        && entry.width > 0
        && entry.height > 0
        && !isUploadSlotEntry(entry)
      )) || removable;
      const points = [
        [target.left + target.width / 2, target.top + target.height / 2],
        [target.left + 4, target.top + 4],
        [target.left + target.width - 4, target.top + 4],
        [target.left + 4, target.top + target.height - 4],
        [target.left + target.width - 4, target.top + target.height - 4],
      ];
      for (const [hotX, hotY] of points) {
        await page.cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(hotX),
          y: Math.round(hotY),
        }).catch(() => null);
        await page.evaluate(`(() => {
          const card = [...document.querySelectorAll('[class]')].find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0
              && Math.abs((r.left + r.width / 2) - ${hotX}) < 12
              && Math.abs((r.top + r.height / 2) - ${hotY}) < 12
              && /reference-item-/.test(String(el.className || ''));
          });
          if (!card) return;
          const init = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: ${hotX},
            clientY: ${hotY},
          };
          try { card.dispatchEvent(new PointerEvent('pointerover', init)); } catch (_) {}
          try { card.dispatchEvent(new PointerEvent('pointermove', init)); } catch (_) {}
          card.dispatchEvent(new MouseEvent('mouseover', init));
          card.dispatchEvent(new MouseEvent('mousemove', init));
          try { card.dispatchEvent(new MouseEvent('mouseenter', init)); } catch (_) {}
        })()`);
        await page.sleep(0.35);
        marked = await markReferenceRemoveControl(page, marker);
        if (marked?.ok) break;
      }
    }
    if (!marked?.ok) {
      const diagnostics = (before.cards || []).map((card) => ({
        id: card.identity,
        cls: (card.classes || []).join(' ').slice(0, 80),
        w: card.width,
        h: card.height,
        img: !!card.mediaSrc,
        spin: card.hasSpin,
        mask: card.hasMask,
        remove: card.hasRemoveBtn,
        slot: card.hasUploadSlot,
      }));
      throw phaseError(
        'clear-references',
        `Jimeng reference card remove control stayed hidden after hover (${before.count} card(s)): ${JSON.stringify(diagnostics)}`,
        'No generation was submitted. Inspect the visible reference strip and clear stale cards manually.',
      );
    }

    // Click via synthetic events (mousedown/mouseup/click). The remove
    // button sits under a hover-trigger overlay, so a coordinate click would
    // hit the overlay; React's delegated listeners respond to bubbled events.
    await page.evaluate(`(() => {
      const button = document.querySelector('[${TARGET_ATTR}="${marker}"]');
      if (!button) return;
      const init = { bubbles: true, cancelable: true, view: window };
      button.dispatchEvent(new MouseEvent('mousedown', init));
      button.dispatchEvent(new MouseEvent('mouseup', init));
      button.dispatchEvent(new MouseEvent('click', init));
    })()`);
    const deadline = Date.now() + 3_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await collectDockReferenceSnapshot(page);
      const removedIdentity = removable.identity;
      const identityStillVisible = (after.cards || []).some(
        (card) => card.identity === removedIdentity,
      );
      // In a collapsed reference strip, removing one hidden/visible resource
      // can replace it with another visible resource, so the DOM card count
      // stays constant even though the targeted identity is gone.
      if (after.count < before.count || !identityStillVisible) break;
      await page.sleep(0.25);
    }
    const identityStillVisible = (after.cards || []).some(
      (card) => card.identity === removable.identity,
    );
    if (after.count >= before.count && identityStillVisible) {
      throw phaseError(
        'clear-references',
        `Jimeng reference identity remained after clicking a remove control (${removable.identity}; ${before.count} card(s))`,
        'No generation was submitted. Inspect the visible reference strip and retry.',
      );
    }
    // Keep the pointer away from the strip/history between deletions so no
    // prompt-tooltip overlay can cover the next card's hover target.
    await parkMouseAtComposer(page);
  }

  throw phaseError(
    'clear-references',
    `Jimeng still exposes reference cards after ${maxReferences} removal attempts`,
    'No generation was submitted. The reference strip exceeded the safe cleanup bound.',
  );
}

/**
 * Park the mouse over the prompt editor (safe zone). CDP mouse moves leave the
 * pointer parked at the last hovered element; if that is a reference/history
 * card, Jimeng raises its prompt-tooltip overlay which covers the composer and
 * breaks later hover/click work. Moving to the editor keeps the overlay away
 * without changing focus (move only, never click).
 */
async function parkMouseAtComposer(page) {
  const rect = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return null;
    const r = editor.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 200)), y: Math.round(r.top + Math.min(r.height / 2, 24)) };
  })()`).catch(() => null);
  if (!rect) return;
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }).catch(() => null);
}

async function uploadReferenceAssets(page, assets, uploads, startAssetIndex, baselineSlots) {
  for (let index = startAssetIndex; index < assets.length; index += 1) {
    const asset = assets[index];
    const before = await collectDockReferenceSnapshot(page);
    // Empty upload slots are unremovable placeholders that never expose an
    // asset to the mention picker, and Jimeng may add/fill them differently
    // on slow hosts. When the strip is collapsed, the visible "more" card
    // represents hidden references, so the visible media count can be lower
    // than the number already confirmed by this upload loop.
    const mediaCardCount = countVisibleMediaReferences(before.cards);
    const collapsedMore = hasCollapsedReferenceMore(before.cards);
    if (mediaCardCount !== index && !(collapsedMore && mediaCardCount < index)) {
      const cardDump = (before.cards || []).map((card) => ({
        id: card.identity,
        slot: card.hasUploadSlot,
        img: !!card.mediaSrc,
        spin: card.hasSpin,
        mask: card.hasMask,
        remove: card.hasRemoveBtn,
        cls: (card.classes || []).join(' ').slice(0, 50),
      }));
      throw phaseError(
        'upload',
        `Expected ${index} confirmed Jimeng media card(s) before ${asset.label} (${index} upload(s)), found ${mediaCardCount}`
        + ` (slots=${before.count - mediaCardCount}, details=${JSON.stringify(cardDump)})`,
        'No generation was submitted. The upload sequence stopped before writing the prompt.',
        index,
      );
    }

    // Do NOT click the dock "+" before setFileInput — that opens a native file
    // chooser and blocks CDP assignment. The hidden input accepts multi files.

    const slot = await markCurrentUploadSlot(page, nextMarker(`upload-${index}`));
    if (!slot.ok) {
      throw phaseError(
        'upload',
        `Could not locate an active Jimeng reference file input before ${asset.label}`,
        'Reload the visible Jimeng workspace manually and retry.',
        index,
      );
    }
    const alertBaselineMarker = nextMarker(`upload-alerts-${index}`);
    const baselineAlerts = await markVisibleUploadAlertBaseline(page, alertBaselineMarker);

    try {
      try {
        // Assign exactly one file per change event. Jimeng can silently discard a
        // heterogeneous multi-file assignment, so every card is acknowledged
        // before the next resource is offered.
        await page.setFileInput([asset.browserPath], slot.selector);
      } catch (err) {
        throw phaseError(
          'upload',
          `setFileInput failed for ${asset.label} (${asset.filename}): ${describeError(err)}`,
          'Verify the file is readable by the browser host and no native file chooser is open.',
          index,
        );
      }

      await waitForUploadCompletion(
        page,
        asset,
        index,
        before.cards,
        before.count,
        alertBaselineMarker,
        baselineAlerts,
      );
    } finally {
      await clearUploadAlertBaseline(page, alertBaselineMarker);
    }
    // The upload-wait loop never moves the mouse; it stays parked where the
    // last clear hover ended. Move it to the composer so no history-card
    // tooltip overlay can rise during the next upload's wait.
    await parkMouseAtComposer(page);
    uploads[index] = asset;
    uploads.length = index + 1;
  }
}

async function markCurrentUploadSlot(page, marker) {
  return page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)})];
    const preferred = inputs.filter((input) => /reference-upload/i.test(input.id || ''));
    // When the strip renders an upload slot it carries the real per-card file
    // input; prefer the newest slot, otherwise fall back to the dock input.
    const candidates = preferred.length > 0
      ? preferred
      : inputs.filter((input) => input.multiple || input.accept.includes('image') || input.accept.includes('video') || input.accept.includes('audio'));
    if (candidates.length === 0) {
      return { ok: false, count: 0, ids: [] };
    }
    const input = candidates[candidates.length - 1];
    input.setAttribute(${JSON.stringify(UPLOAD_SLOT_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      selector: '[${UPLOAD_SLOT_ATTR}="${marker}"]',
    };
  })()`);
}

async function markVisibleUploadAlertBaseline(page, marker) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const registryKey = ${JSON.stringify(UPLOAD_ALERT_REGISTRY_KEY)};
    const registries = window[registryKey] || (window[registryKey] = Object.create(null));
    const registry = Object.create(null);
    registries[${JSON.stringify(marker)}] = registry;
    const alerts = [...document.querySelectorAll(
      '[role="alert"], [class*="toast-"], [class^="toast"], [class*="Toast"]',
    )].filter(visible);
    return alerts.map((el, index) => {
      const id = ${JSON.stringify(marker)} + '-' + index;
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      el.setAttribute(${JSON.stringify(UPLOAD_ALERT_BASELINE_ATTR)}, ${JSON.stringify(marker)});
      el.setAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)}, id);
      registry[id] = el;
      return { id, text };
    }).filter((alert) => alert.text);
  })()`);
}

async function clearUploadAlertBaseline(page, marker) {
  await page.evaluate(`(() => {
    const registryKey = ${JSON.stringify(UPLOAD_ALERT_REGISTRY_KEY)};
    const registries = window[registryKey];
    if (registries) delete registries[${JSON.stringify(marker)}];
    for (const el of document.querySelectorAll(
      '[${UPLOAD_ALERT_BASELINE_ATTR}="${marker}"]',
    )) {
      el.removeAttribute(${JSON.stringify(UPLOAD_ALERT_BASELINE_ATTR)});
      el.removeAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)});
    }
  })()`).catch(() => null);
}

async function waitForUploadCompletion(
  page,
  asset,
  failedAssetIndex,
  baselineCards,
  baselineCount,
  alertBaselineMarker,
  baselineAlerts = [],
) {
  // Images usually index quickly, but content-moderation can keep the card in
  // the processing state for a while; video/audio often need longer anyway.
  const timeoutMs = asset.kind === 'image' ? 45_000 : 60_000;
  const deadline = Date.now() + timeoutMs;
  const baseline = new Set((baselineCards || []).filter((card) => card?.identity).map((card) => card.identity));
  // Empty upload slots can be filled in place by an upload (audio cards carry
  // no blob src, so their identity stays `index:N`); treat such a slot→card
  // transition as a new card too.
  const baselineSlotIdentities = new Set(
    (baselineCards || [])
      .filter((card) => isUploadSlotEntry(card) && card.identity)
      .map((card) => card.identity),
  );
  let activeBaselineAlertIds = baselineAlerts.map((alert) => alert.id);
  let stablePolls = 0;
  let lastCards = null;
  while (Date.now() < deadline) {
    const snap = await collectDockReferenceSnapshot(page, alertBaselineMarker);
    // A new card is one whose identity is not part of the pre-upload baseline
    // (draft cards restored by Jimeng count as baseline, so leftovers never
    // inflate the upload result), or a baseline upload slot that was filled
    // in place (audio cards have no blob source to change identity).
    const newCards = (snap.cards || []).filter(
      (card) => isNewUploadCard(card, baseline, baselineSlotIdentities),
    );
    const newIds = new Set(newCards.map((card) => card.identity));
    const failureObservation = observeCurrentUploadFailure({
      cards: newCards,
      alerts: snap.alerts,
      baselineAlerts,
      activeBaselineAlertIds,
    });
    activeBaselineAlertIds = failureObservation.activeBaselineAlertIds;
    const { failureText } = failureObservation;
    if (failureText) {
      const moderationHint = /审核|未通过|不通过|违规|敏感|拒绝|content.*review|violat/i.test(
        failureText,
      );
      throw phaseError(
        'upload',
        `Jimeng rejected ${asset.label} (${asset.filename}): ${failureText}`,
        moderationHint
          ? 'No generation was submitted. The visible UI rejected this asset — likely by content moderation. Check the file content and retry with a different asset.'
          : 'No generation was submitted. The visible UI rejected this file; check account/workspace entitlement and retry later.',
        failedAssetIndex,
      );
    }
    if (newCards.length > 0) {
      const processing = newCards.some((card) => isProcessingCard(card));
      const busyText = hasUploadBusyText(newCards.map((card) => card.text || '').join(' '));
      const ready = !processing && !busyText;
      // Require exactly ONE new card per upload: Jimeng can transiently create
      // a duplicate processing card on slow hosts; confirming two cards would
      // shift @图片N numbering and the next pre-upload gate would fail
      // ('found 4' ghost-card pattern). A single stable card is the contract.
      const single = newCards.length === 1;
      // Require the same new-card set (identity) twice in a row so a
      // transient re-render does not count as "upload complete".
      const sameSet = lastCards !== null
        && lastCards.size === newIds.size
        && [...newIds].every((id) => lastCards.has(id));
      if (ready && sameSet && single) {
        stablePolls += 1;
      } else {
        stablePolls = 0;
      }
      if (stablePolls >= 2) {
        await page.sleep(asset.kind === 'image' ? 0.8 : 1.2);
        return;
      }
    } else {
      stablePolls = 0;
    }
    lastCards = newIds;
    await page.sleep(0.5);
  }

  const final = await collectDockReferenceSnapshot(page).catch(() => null);
  const cardDump = (final?.cards || []).map((card) => ({
    id: card.identity,
    slot: card.hasUploadSlot,
    img: !!card.mediaSrc,
    spin: card.hasSpin,
    mask: card.hasMask,
    remove: card.hasRemoveBtn,
    cls: (card.classes || []).join(' ').slice(0, 50),
  }));
  throw phaseError(
    'upload',
    `Jimeng did not create a reference card for ${asset.label} (${asset.filename}) within ${Math.round(timeoutMs / 1000)} seconds`
    + ` (baseline=${baselineCount}, cards=${final?.count ?? '?'}, processing=${final?.processing ?? '?'}, busy=${final?.busy ?? '?'}`
    + `, details=${JSON.stringify(cardDump)})`,
    'No generation was submitted. The upload was not acknowledged; verify the visible reference strip and file type.',
    failedAssetIndex,
  );
}

async function fillPromptWithRichMentions(page, agentPrompt, assets, mentionDebug) {
  // Jimeng can re-inject the server-side draft text into the composer after
  // the post-upload clear; typing the canonical prompt on top of that draft
  // shifts the caret and breaks the mention picker. Re-clear until empty.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await getComposerClearState(page);
    if (state.empty) break;
    await clearComposer(page, 'clear-after-upload');
    await page.sleep(0.3);
  }
  const finalState = await getComposerClearState(page);
  if (!finalState.empty) {
    throw phaseError(
      'prompt',
      `Jimeng re-injected draft text into the composer after upload (${finalState.textLength} character(s), ${finalState.mentionCount} mention(s))`,
      'No generation was submitted. Clear the visible composer and retry.',
    );
  }

  const normalizedPrompt = agentPrompt.replace(/\\n/g, '\n');
  const segments = buildMentionSegments(normalizedPrompt, assets);
  let expectedMentionCount = 0;
  let emittedAnyContent = false;
  let lastSegmentType = null;
  let lastTextMayLeaveMentionMenuOpen = false;

  for (const segment of segments) {
    if (segment.type === 'newline') {
      if (lastTextMayLeaveMentionMenuOpen) {
        await page.nativeKeyPress('Escape');
        await page.sleep(0.12);
      }
      await insertSoftBreak(page);
      emittedAnyContent = true;
      lastSegmentType = 'newline';
      lastTextMayLeaveMentionMenuOpen = false;
      continue;
    }

    if (segment.type === 'text') {
      if (segment.value) {
        await ensurePromptEditorCaret(page);
        await insertNativeText(page, segment.value);
        emittedAnyContent = true;
        lastSegmentType = 'text';
        lastTextMayLeaveMentionMenuOpen = /(?:^|\s)@[^\s@]*$/.test(segment.value);
      }
      continue;
    }

    if (!emittedAnyContent) {
      await ensurePromptEditorCaret(page);
      await insertNativeText(page, LEADING_MENTION_GUARD);
      emittedAnyContent = true;
    }
    if (lastSegmentType === 'mention') {
      await ensurePromptEditorCaret(page);
      await insertNativeText(page, ' ');
    }
    expectedMentionCount += 1;
    await insertRichMention(page, segment.asset, expectedMentionCount, mentionDebug);
    lastSegmentType = 'mention';
    lastTextMayLeaveMentionMenuOpen = false;
  }

  if (lastTextMayLeaveMentionMenuOpen) {
    await page.nativeKeyPress('Escape');
    await page.sleep(0.12);
  }

  // Let TipTap merge the final mention commit back into one paragraph before
  // the checkpoint reads the line structure. Right after the last Enter the
  // DOM can briefly show a split/extra block (flaky lineStructure failures);
  // require two identical consecutive polls before proceeding.
  const settleDeadline = Date.now() + 3_000;
  let lastLines = null;
  let settleStable = 0;
  while (Date.now() < settleDeadline) {
    const settleSnapshot = await collectContentCheckpointSnapshot(page);
    const lines = settleSnapshot.editorLines;
    const mentionsOk = settleSnapshot.mentionCount >= expectedMentionCount;
    const sameLines = lastLines !== null && lines.join('|') === lastLines.join('|');
    if (mentionsOk && sameLines) {
      settleStable += 1;
      if (settleStable >= 2) break;
    } else {
      settleStable = 0;
    }
    lastLines = lines;
    await page.sleep(0.25);
  }
  if (settleStable < 2) {
    await page.sleep(0.3);
  }

  // Line structure is re-checked by the mandatory preparation checkpoint.
}

async function clearComposer(page, phase = 'clear-initial') {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await focusPromptEditorEnd(page);
    // OpenCLI's CDP helper expects a lowercase printable key for Ctrl+A.
    await page.nativeKeyPress('a', ['Ctrl']);
    await page.nativeKeyPress('Backspace');
    await page.sleep(0.5);

    last = await getComposerClearState(page);
    if (last.empty) return;
  }

  throw phaseError(
    phase,
    `Jimeng prompt editor retained content after keyboard clear (${last?.textLength ?? 0} text character(s), ${last?.mentionCount ?? 0} mention node(s))`,
    phase === 'clear-initial'
      ? 'No generation was submitted. The workspace will be refreshed once before this preparation stops.'
      : 'No generation was submitted. Inspect the uploaded reference chip and retry after clearing the visible composer.',
  );
}

async function getComposerClearState(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { empty: false, textLength: 0, mentionCount: 0 };

    const clone = editor.cloneNode(true);
    clone.querySelectorAll(
      '[data-rich-placeholder], .rich-placeholder-widget, .ProseMirror-separator, .ProseMirror-trailingBreak',
    ).forEach((node) => node.remove());
    const text = (clone.innerText || clone.textContent || '')
      .replace(/[\\u00a0\\u200b\\s]+/g, '');
    const mentionCount = [...clone.querySelectorAll(${JSON.stringify(MENTION_NODE_SELECTOR)})].length;
    return {
      empty: text.length === 0 && mentionCount === 0,
      textLength: text.length,
      mentionCount,
    };
  })()`);
}

function createMentionDebugSession(options) {
  if (!options.enabled) {
    return {
      enabled: false,
      sleepMs: 0,
      directory: null,
      sequence: 0,
      stopPhase: null,
    };
  }

  fs.mkdirSync(options.artifactRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(options.artifactRoot, 'jimeng-agent-mention-'));
  console.error(`[jimeng-agent][mention-debug] artifacts=${directory}`);
  return {
    enabled: true,
    sleepMs: options.sleepMs,
    directory,
    sequence: 0,
    stopPhase: options.stopPhase,
  };
}

/**
 * Rewind keystrokes typed in the current mention attempt.
 * phase 'at'    → Backspace x1  (only '@')
 * phase 'label' → Backspace x(label.length + 1)  (label + '@')
 *
 * Escape first to close the picker, then restore caret, then backspace.
 * Does not rely on full-text baseline matching.
 */
/** Small pause between discrete key/input ops so Jimeng can settle. */
const MENTION_KEY_GAP_S = 0.2;

async function pressKeyWithGap(page, key, gapSeconds = MENTION_KEY_GAP_S) {
  await page.nativeKeyPress(key);
  await page.sleep(gapSeconds);
}

async function rewindMentionKeystrokes(page, label, phase) {
  await pressKeyWithGap(page, 'Escape', 0.12);
  try {
    await ensurePromptEditorCaret(page);
  } catch {
    await placeCaretAtPromptEditorEnd(page).catch(() => null);
  }
  await page.sleep(MENTION_KEY_GAP_S);
  let n = 0;
  if (phase === 'at') n = 1;
  else if (phase === 'label') n = 1 + Array.from(String(label || '')).length;
  // Each Backspace is spaced out — rapid-fire deletes race Jimeng's editor.
  for (let i = 0; i < n; i += 1) {
    await pressKeyWithGap(page, 'Backspace');
  }
  // Safety: never leave a bare trailing '@'.
  for (let i = 0; i < 3; i += 1) {
    const endsWithAt = await page.evaluate(`(() => {
      ${buildPromptEditorLocatorScript()}
      const editor = findPromptEditor();
      if (!editor) return false;
      const text = (editor.innerText || editor.textContent || '').replace(/[\\u00a0\\u200b\\s]+$/g, '');
      return /@$/.test(text);
    })()`);
    if (!endsWithAt) break;
    await pressKeyWithGap(page, 'Backspace');
  }
  await page.sleep(MENTION_KEY_GAP_S);
}

/**
 * Pure DOM read of the mention picker.
 *
 * IMPORTANT: This does NOT click, focus, or dispatch input. It only queries
 * option nodes via page.evaluate, so the composer caret and the open picker
 * stay intact (no focus loss from the check itself).
 *
 * A "visible picker" means at least one real 图片N / 视频N / 音频N option is
 * on screen — not arbitrary list widgets.
 */
async function isMentionPickerVisible(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const options = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .filter(visible)
      .filter((el) => {
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
          .replace(/\\s+/g, '');
        return /(?:图片|视频|音频)\\d+/.test(text);
      });
    return options.length > 0;
  })()`);
}

/**
 * Poll until the mention picker shows real candidate options.
 *
 * The `.suggestion` decoration appears immediately after '@' (often empty or
 * showing the raw query), so it must NOT count as success — only real
 * 图片N/视频N/音频N options mean the candidate list has loaded.
 */
async function waitForMentionCandidates(page, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastFramePush = 0;
  const framePath = path.join(os.tmpdir(), `jimeng-agent-poll-frame-${process.pid}.png`);
  while (Date.now() < deadline) {
    if (await isMentionPickerVisible(page)) return true;
    // A hidden/background tab pauses frame-driven React work; capturing a
    // frame lets the mention candidate list finish rendering. 1 Hz while the
    // picker is still missing.
    const now = Date.now();
    if (now - lastFramePush > 1_000) {
      lastFramePush = now;
      await page.screenshot({ path: framePath }).catch(() => null);
    }
    await page.sleep(0.15);
  }
  return isMentionPickerVisible(page);
}

/**
 * Delete every trailing bare '@' at the end of the composer (not chip content).
 * No-op when the composer does not end with '@' — avoids Escape/click thrash.
 * When cleanup is needed, ensure a real caret first (JS place alone can miss).
 */
async function stripTrailingBareAtsAtEnd(page) {
  const endsWithAt = async () => page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return false;
    const text = (editor.innerText || editor.textContent || '')
      .replace(/[\\u00a0\\u200b]+/g, '')
      .replace(/\\s+$/g, '');
    return /@$/.test(text);
  })()`);

  if (!(await endsWithAt())) return;

  // Only when there is a real bare '@' to remove: place caret firmly, then delete.
  try {
    await ensurePromptEditorCaret(page);
  } catch {
    await placeCaretAtPromptEditorEnd(page).catch(() => null);
  }
  for (let i = 0; i < 6; i += 1) {
    if (!(await endsWithAt())) break;
    await pressKeyWithGap(page, 'Backspace');
  }
}

/**
 * Insert one rich @mention chip.
 *
 * Flow:
 *   1. ensure no trailing bare '@', type ONE '@', poll for picker (slow Hub/NAS)
 *      - if still invisible: strip ALL trailing bare '@', re-type ONE '@' (max 3)
 *   2. type label → poll picker still visible
 *      - invisible: rewind (label.length + 1) and full-retry
 *   3. click unique candidate → verify chip; strip orphan bare '@' after commit
 *
 * Critical: never type a second '@' while a bare '@' is still in the composer
 * (that produced the Hub-visible "@@图片1" flash on slow machines).
 */
async function insertRichMention(page, asset, expectedMentionCount, mentionDebug) {
  const maxAtAttempts = mentionDebug.enabled ? 1 : 3;
  const maxFullAttempts = mentionDebug.enabled ? 1 : 3;
  const label = asset.label;
  // Hub/NAS is slower than local; fixed 0.5s after '@' was too short and caused
  // false "picker missing" → re-type '@' → "@@图片1".
  const pickerWaitAfterAtMs = 8_000;
  // Hub/NAS can drop the filtered list briefly after CJK + digit label input.
  const pickerWaitAfterLabelMs = 8_000;

  for (let fullAttempt = 0; fullAttempt < maxFullAttempts; fullAttempt += 1) {
    const before = await getMentionState(page, asset);

    // Do not press Escape when no picker is open: Jimeng may collapse the
    // composer. Failure rewind still closes an actually open picker.
    await ensurePromptEditorCaret(page);
    await page.sleep(MENTION_KEY_GAP_S);
    // Drop any leftover bare '@' from a previous attempt before we type a new one.
    await stripTrailingBareAtsAtEnd(page);

    await captureMentionDebug(page, mentionDebug, 'before-at', asset, {
      fullAttempt: fullAttempt + 1,
      expectedMentionCount,
      before,
    });

    // ---------- Phase 1: open picker via toolbar '@' (keyboard is fallback) ----------
    let atOpened = false;
    for (let atAttempt = 0; atAttempt < maxAtAttempts; atAttempt += 1) {
      // Guard: never stack another '@' on top of an existing bare '@'.
      await stripTrailingBareAtsAtEnd(page);
      const toolbar = await openMentionPickerViaToolbar(page);
      let opened = false;
      if (toolbar?.ok) {
        opened = await waitForMentionCandidates(page, pickerWaitAfterAtMs);
      }
      if (!opened) {
        // Fallback: one typed '@' if the dock button is missing or inert.
        await stripTrailingBareAtsAtEnd(page);
        await typeMentionQuery(page, '@');
        opened = await waitForMentionCandidates(page, pickerWaitAfterAtMs);
      }
      await captureMentionDebug(page, mentionDebug, 'after-at', asset, {
        fullAttempt: fullAttempt + 1,
        atAttempt: atAttempt + 1,
        pickerVisible: opened,
        toolbar,
      });

      if (opened) {
        atOpened = true;
        break;
      }

      // Picker never appeared → aggressively remove bare '@' (trailing + orphan
      // text nodes). endsWith-only strip was leaving "请以@@@" on some hosts.
      await stripTrailingBareAtsAtEnd(page);
      if (await hasOrphanBareAt(page).catch(() => false)) {
        await stripTrailingBareAt(page);
      }
      const caretOk = await isCaretInPromptEditor(page).catch(() => false);
      if (!caretOk) {
        await ensurePromptEditorCaret(page);
        await page.sleep(MENTION_KEY_GAP_S);
      }
    }

    if (!atOpened) {
      await stripTrailingBareAtsAtEnd(page);
      if (await hasOrphanBareAt(page).catch(() => false)) {
        await stripTrailingBareAt(page);
      }
      throw phaseError(
        'mention',
        `Rich @ mention picker did not open after ${maxAtAttempts} toolbar/@ attempt${maxAtAttempts === 1 ? '' : 's'} for ${label} (${asset.filename})`,
        `Ensure Jimeng is focused, the composer '@' button is visible, and reference assets are uploaded before selecting '${label}'.`,
      );
    }

    // ---------- Phase 2: type label only when the unique option is not already visible ----------
    // Do NOT click/refocus the editor here — that can close the picker.
    await page.sleep(MENTION_KEY_GAP_S);
    const uniqueBeforeLabel = await page.evaluate(buildMentionCandidateExpression(asset, nextMarker(`mention-prefilter-${label}`)));
    if (!uniqueBeforeLabel?.ok) {
      await typeMentionQuery(page, label);
    }
    const labelPickerOk = uniqueBeforeLabel?.ok
      ? true
      : await waitForMentionCandidates(page, pickerWaitAfterLabelMs);
    await captureMentionDebug(page, mentionDebug, 'after-label', asset, {
      fullAttempt: fullAttempt + 1,
      expectedMentionCount,
      pickerVisible: labelPickerOk,
      typedLabel: !uniqueBeforeLabel?.ok,
    });

    if (!labelPickerOk) {
      const suggestion = await page.evaluate(`(() => {
        ${buildPromptEditorLocatorScript()}
        const s = document.querySelector('.suggestion, [class*="suggestion"]');
        const opts = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
          .filter(visible)
          .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').slice(0, 30));
        return {
          suggestion: s ? String(s.className) + ' ' + (s.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) : null,
          opts,
        };
      })()`);
      console.error(
        `[jimeng-agent] mention label picker missing for ${label} suggestion=${JSON.stringify(suggestion)}`,
      );
      // Label typing lost the picker → rewind (label chars + '@') and full-retry.
      await rewindMentionKeystrokes(page, label, 'label');
      continue;
    }

    // ---------- Phase 3: unique candidate + atomic click ----------
    await page.sleep(0.5);
    const marker = nextMarker(`mention-${label}`);
    const candidate = await waitForMarker(
      page,
      marker,
      buildMentionCandidateExpression(asset, marker),
      5_000,
    );

    let committed = false;
    if (candidate.ok) {
      const candidateTarget = await inspectMentionCandidateTarget(page, marker, asset);
      await captureMentionDebug(page, mentionDebug, 'before-click', asset, {
        fullAttempt: fullAttempt + 1,
        expectedMentionCount,
        candidate,
        candidateTarget,
      });
      if (mentionDebug.enabled && mentionDebug.stopPhase === 'before-click') {
        throw phaseError(
          'mention',
          `Mention debug checkpoint reached before selecting ${label}; inspect ${mentionDebug.directory}`,
          'No generation was submitted. The unique candidate remains open for a manual mouse click.',
        );
      }

      // Do not re-focus the editor: the selector revalidates and clicks the
      // marked unique candidate in one browser-side turn.
      if (candidateTarget?.ok || candidateTarget?.reason === 'candidate-center-obscured') {
        try {
          await page.sleep(MENTION_KEY_GAP_S);
          const selection = await page.evaluate(buildMentionCandidateExpression(asset, marker, true));
          // Do NOT Escape after click — picker closes itself; Escape thrashs the dock.
          // Chip rendering can lag behind the click on slow hosts, so poll
          // for the commit instead of a single fixed sleep.
          const commit = await waitForMentionCommit(
            page,
            asset,
            before,
            selection,
            expectedMentionCount,
            6_000,
          );
          await captureMentionDebug(page, mentionDebug, 'after-click', asset, {
            fullAttempt: fullAttempt + 1,
            expectedMentionCount,
            candidate,
            candidateTarget,
            selection,
            before,
            after: commit.after,
          });
          if (mentionDebug.enabled && mentionDebug.stopPhase === 'after-click') {
            throw phaseError(
              'mention',
              `Mention debug checkpoint reached after selecting ${label}; inspect ${mentionDebug.directory}`,
              'No generation was submitted.',
            );
          }
          if (commit.committed) {
            committed = true;
          } else {
            console.error(
              `[jimeng-agent] mention commit not observed for ${label} selection=${selection?.status} `
              + `after=${JSON.stringify(commit.after)}`,
            );
          }
        } catch (err) {
          if (mentionDebug.enabled && mentionDebug.stopPhase === 'after-click') throw err;
          await captureMentionDebug(page, mentionDebug, 'click-failed', asset, {
            fullAttempt: fullAttempt + 1,
            error: err?.message || String(err),
          });
        }
      }
    } else {
      console.error(
        `[jimeng-agent] mention candidate not found for ${label} within timeout: ${JSON.stringify(candidate)}`,
      );
    }

    if (committed) {
      // Only edit when a bare orphan '@' is actually present. No Escape / no click
      // when the commit is already clean — avoids dock shrink/expand thrash.
      if (await hasOrphanBareAt(page)) {
        await stripTrailingBareAt(page);
      }
      await page.sleep(0.2);
      // Soft caret only (JS place). Do not nativeClick unless caret is missing.
      await placeCaretAtPromptEditorEnd(page).catch(() => null);
      if (!(await isCaretInPromptEditor(page).catch(() => false))) {
        await ensurePromptEditorCaret(page).catch(() => null);
      }
      return;
    }

    // Click/commit failed → rewind (label + '@') and full-retry.
    await rewindMentionKeystrokes(page, label, 'label');
  }

  await rewindMentionKeystrokes(page, label, 'label');
  await stripTrailingBareAt(page);
  throw phaseError(
    'mention',
    `Rich @ mention insertion failed after ${maxFullAttempts} full attempt${maxFullAttempts === 1 ? '' : 's'} for ${label} (${asset.filename})`,
    `Ensure Jimeng exposes a unique @ candidate for '${label}'.`,
  );
}

/** True if the composer has an orphan bare '@' text node (not part of a chip). */
async function hasOrphanBareAt(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return false;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue || '';
      const lone = v === '@' || v.trim() === '@';
      const trailing = /@$/.test(v) && !/@(?:图片|视频|音频)\\d*$/.test(v.replace(/\\s+$/, ''));
      if (lone || trailing) return true;
    }
    const text = (editor.innerText || editor.textContent || '')
      .replace(/[\\u00a0\\u200b]+/g, '')
      .replace(/\\s+$/g, '');
    return /@$/.test(text);
  })()`);
}

/**
 * Remove orphan bare '@' text left beside a committed mention chip.
 * Call only when hasOrphanBareAt() is true — no Escape, no no-op edits.
 */
async function stripTrailingBareAt(page) {
  // No Escape here: caller already decided there is a bare '@' to delete.
  await placeCaretAtPromptEditorEnd(page).catch(() => null);

  for (let i = 0; i < 4; i += 1) {
    const selected = await page.evaluate(`(() => {
      ${buildPromptEditorLocatorScript()}
      const editor = findPromptEditor();
      if (!editor) return { ok: false, reason: 'no-editor' };
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const v = node.nodeValue || '';
        // Lone '@' node, or a text node ending with '@' that is not part of a raw @图片N token.
        const lone = v === '@' || v.trim() === '@';
        const trailing = /@$/.test(v) && !/@(?:图片|视频|音频)\\d*$/.test(v.replace(/\\s+$/, ''));
        if (!lone && !trailing) continue;
        const atIndex = v.lastIndexOf('@');
        if (atIndex < 0) continue;
        const range = document.createRange();
        range.setStart(node, atIndex);
        range.setEnd(node, atIndex + 1);
        const sel = window.getSelection();
        if (!sel) return { ok: false, reason: 'no-selection' };
        sel.removeAllRanges();
        sel.addRange(range);
        editor.focus();
        return { ok: true, value: v, atIndex };
      }
      return { ok: false, reason: 'none' };
    })()`);

    if (!selected?.ok) break;
    await pressKeyWithGap(page, 'Backspace');
  }

  // Fallback: if a bare '@' is still the last non-space char, delete from end once.
  await placeCaretAtPromptEditorEnd(page).catch(() => null);
  await page.sleep(MENTION_KEY_GAP_S);
  const endsWithAt = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return false;
    const text = (editor.innerText || editor.textContent || '').replace(/[\\u00a0\\u200b\\s]+$/g, '');
    return /@$/.test(text);
  })()`);
  if (endsWithAt) {
    await pressKeyWithGap(page, 'Backspace');
  }
}

async function captureMentionDebug(page, debug, phase, asset, extra = {}) {
  if (!debug.enabled) return;

  debug.sequence += 1;
  const prefix = `${String(debug.sequence).padStart(2, '0')}-${phase}`;
  const screenshotPath = path.join(debug.directory, `${prefix}.png`);
  const statePath = path.join(debug.directory, `${prefix}.json`);
  const state = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    const compactText = (node) => (node?.innerText || node?.textContent || '')
      .replace(/\\u00a0/g, ' ')
      .replace(/\\u200b/g, '');
    const nodePath = (node) => {
      if (!node || !editor || !editor.contains(node)) return null;
      const path = [];
      let current = node;
      while (current && current !== editor) {
        const parent = current.parentNode;
        if (!parent) return null;
        path.push([...parent.childNodes].indexOf(current));
        current = parent;
      }
      return path.reverse();
    };
    const rectValue = (rect) => rect
      ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      }
      : null;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectionInEditor = !!(
      editor
      && selection?.anchorNode
      && selection?.focusNode
      && editor.contains(selection.anchorNode)
      && editor.contains(selection.focusNode)
    );
    const active = document.activeElement;
    const options = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .filter(visible)
      .map((option) => {
        const rect = option.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          tag: option.tagName,
          className: String(option.className || ''),
          text: compactText(option).replace(/\\s+/g, ' ').trim(),
          rect: rectValue(rect),
          centerHitTag: hit?.tagName || null,
          centerHitClass: String(hit?.className || ''),
          centerHitsOption: !!(hit && option.contains(hit)),
          marked: option.hasAttribute(${JSON.stringify(TARGET_ATTR)}),
        };
      });
    // Broad dump of any visible floating layer (mention menus use custom
    // classes that drift between builds; this records their real structure).
    const floating = [...document.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="option"], [class*="popup"], [class*="popper"], [class*="dropdown"], [class*="floating"], [class*="suggestion"]',
    )]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          className: String(el.className || '').slice(0, 90),
          text: compactText(el).replace(/\\s+/g, ' ').trim().slice(0, 60),
          rect: rectValue(rect),
        };
      })
      .filter((item) => item.text || /menu|option|dropdown|popup|suggestion/i.test(item.className));
    const mentions = editor
      ? [...editor.querySelectorAll('.node-reference-mention-tag')].map((node) => ({
        text: compactText(node).replace(/\\s+/g, ' ').trim(),
        blockIndex: [...editor.children].findIndex((block) => block.contains(node)),
        html: node.outerHTML,
      }))
      : [];
    return {
      url: location.href,
      activeElement: {
        tag: active?.tagName || null,
        className: String(active?.className || ''),
        role: active?.getAttribute?.('role') || null,
        isEditor: active === editor,
      },
      editor: editor
        ? {
          text: compactText(editor),
          html: editor.innerHTML,
          blocks: [...editor.children].map((block, index) => ({
            index,
            text: compactText(block),
            html: block.outerHTML,
          })),
        }
        : null,
      selection: {
        exists: !!selection,
        collapsed: !!selection?.isCollapsed,
        inEditor: selectionInEditor,
        anchorPath: nodePath(selection?.anchorNode),
        anchorOffset: selection?.anchorOffset ?? null,
        focusPath: nodePath(selection?.focusNode),
        focusOffset: selection?.focusOffset ?? null,
        rangeRect: rectValue(range?.getBoundingClientRect()),
      },
      options,
      floating,
      mentions,
    };
  })()`);
  const record = {
    phase,
    asset: {
      label: asset.label,
      filename: asset.filename,
      uploadFilename: asset.uploadFilename,
    },
    extra,
    state,
  };
  fs.writeFileSync(statePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await page.screenshot({ path: screenshotPath });
  console.error(
    `[jimeng-agent][mention-debug] phase=${phase} screenshot=${screenshotPath} state=${statePath} `
    + `selection=${JSON.stringify(state.selection)} mentions=${state.mentions.length} options=${state.options.length}`,
  );
  if (debug.sleepMs > 0) {
    await page.sleep(debug.sleepMs / 1000);
  }
}

async function dispatchEnterKey(page, modifiers = 0) {
  for (const event of buildEnterKeyEvents(modifiers)) {
    await page.cdp('Input.dispatchKeyEvent', event);
  }
}

/**
 * Chromium Enter descriptor matching Playwright's crInput path.
 * Bare `key: 'Enter'` without code/text is dropped by current Chrome CDP
 * routing; Enter must be `keyDown` with `text: '\r'` (not textless rawKeyDown).
 */
export function buildEnterKeyEvents(modifiers = 0) {
  const base = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers,
  };
  return [
    {
      ...base,
      type: 'keyDown',
      text: '\r',
      unmodifiedText: '\r',
    },
    {
      ...base,
      type: 'keyUp',
    },
  ];
}

async function waitForMarker(page, marker, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false };
  while (Date.now() < deadline) {
    last = await page.evaluate(expression);
    if (last?.ok) return last;
    await page.sleep(0.2);
  }
  return last ?? { ok: false };
}

async function waitForCondition(page, check, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await page.sleep(0.2);
  }
  throw phaseError('surface', failureMessage, 'Inspect the visible Jimeng workspace and retry.');
}

async function closeVisibleListbox(page) {
  const open = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('[role="listbox"]')].some(visible);
  })()`);
  if (!open) return;
  if (typeof page.nativeKeyPress === 'function') {
    await page.nativeKeyPress('Escape');
    await page.sleep(0.1);
    return;
  }
  await page.click(EDITOR_SELECTOR);
  await page.sleep(0.1);
}

async function closeVisiblePreferenceTooltip(page) {
  // Jimeng keeps the preference card open after the switch / radio are
  // configured. That overlays the upload card and the composer, which blocks
  // both `setFileInput` and the `@` mention picker. Close it before upload.
  if (!(await probeJimengAgentSurface(page)).autoPopupOpen) return;

  await page.nativeKeyPress('Escape');
  if (await waitForPreferenceTooltipClosed(page, 1_500)) return;

  const marker = nextMarker('auto-close');
  const marked = await markPreferenceControl(page, marker);
  if (marked?.ok) {
    await page.click(`[${TARGET_ATTR}="${marker}"]`);
    if (await waitForPreferenceTooltipClosed(page, 2_000)) return;
  }

  throw phaseError(
    'preference',
    'Auto/video preference card remained open and would block the composer',
    'Close the visible preference card manually, then retry.',
  );
}

function assertPageCapabilities(page) {
  const missing = ['goto', 'evaluate', 'click', 'setFileInput', 'sleep', 'nativeClick', 'nativeKeyPress', 'cdp']
    .filter((name) => typeof page?.[name] !== 'function');
  if (typeof page?.nativeType !== 'function' && typeof page?.insertText !== 'function') {
    missing.push('nativeType|insertText');
  }
  if (missing.length > 0) {
    throw new CommandExecutionError(
      `JIMENG_BROWSER_UNSUPPORTED: missing page capability ${missing.join(', ')}`,
      'Use the OpenCLI Browser Bridge extension with CDP file-input support.',
    );
  }
}

function buildPromptEditorLocatorScript() {
  return `
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const findPromptEditor = () => {
      const editors = [...document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR)})].filter(visible);
      if (editors.length === 0) return null;
      const score = (editor) => {
        let value = document.activeElement === editor ? 20 : 0;
        let node = editor;
        for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
          if (node.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)})) {
            value += 120 - depth * 8;
            break;
          }
        }
        node = editor;
        for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
          const comboboxes = [...node.querySelectorAll('[role="combobox"]')].filter(visible);
          const hasPreferenceStructure = comboboxes.some((combobox) => {
            const parent = combobox.parentElement;
            if (!parent) return false;
            const siblings = [...parent.children];
            const index = siblings.indexOf(combobox);
            const button = siblings[index + 1];
            if (!(button instanceof HTMLButtonElement) || !visible(button)) return false;
            return siblings.slice(index + 2).some((sibling) => {
              if (sibling.matches('[role="combobox"]') && visible(sibling)) return true;
              const nested = sibling.querySelector('[role="combobox"]');
              return !!nested && visible(nested);
            });
          });
          if (hasPreferenceStructure) {
            value += 80 - depth * 5;
            break;
          }
        }
        const rect = editor.getBoundingClientRect();
        return value + Math.max(0, Math.min(10, rect.bottom / Math.max(1, window.innerHeight) * 10));
      };
      return editors
        .map((editor) => ({ editor, score: score(editor) }))
        .sort((a, b) => b.score - a.score)[0].editor;
    };
  `;
}

async function isCaretInPromptEditor(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode || !selection?.focusNode) return false;
    return editor.contains(selection.anchorNode) && editor.contains(selection.focusNode);
  })()`);
}

/**
 * Place the caret at the true end of the ProseMirror editor.
 * Prefer after the last child so we leave mention widgets / placeholders.
 */
async function placeCaretAtPromptEditorEnd(page) {
  const marker = nextMarker('editor');
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    editor.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return { ok: false, reason: 'no-selection' };
    const range = document.createRange();
    // Walk to the last renderable child; after mention chips this is more
    // reliable than collapse(false) on the whole editor contents.
    let node = editor.lastChild;
    while (node && node.nodeType === Node.ELEMENT_NODE && node.lastChild) {
      node = node.lastChild;
    }
    if (node && node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      range.setStart(node, len);
      range.collapse(true);
    } else if (editor.lastChild) {
      range.setStartAfter(editor.lastChild);
      range.collapse(true);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true };
  })()`);
}

async function focusPromptEditorEnd(page) {
  const result = await placeCaretAtPromptEditorEnd(page);
  if (!result?.ok) {
    throw phaseError('prompt', 'Could not locate the active Jimeng prompt editor');
  }
}

async function computePromptEditorEndClickPoint(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };

    const editorRect = editor.getBoundingClientRect();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let lastText = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!node.nodeValue || !parent) continue;
      if (parent.closest('.rich-placeholder-widget, [data-rich-placeholder], .node-reference-mention-tag')) continue;
      lastText = node;
    }

    // Prefer bottom-right of the editor content box; safer than mid-widget hits
    // after a mention chip re-render.
    let x = editorRect.left + Math.max(16, editorRect.width - 24);
    let y = editorRect.top + Math.max(12, editorRect.height - 18);
    if (lastText) {
      const range = document.createRange();
      const length = lastText.nodeValue.length;
      range.setStart(lastText, Math.max(0, length - 1));
      range.setEnd(lastText, length);
      const rects = [...range.getClientRects()];
      const rect = rects[rects.length - 1] || range.getBoundingClientRect();
      if (rect && rect.height > 0) {
        x = rect.right + 4;
        y = rect.top + rect.height / 2;
      }
    }

    x = Math.max(editorRect.left + 2, Math.min(editorRect.right - 2, x));
    y = Math.max(editorRect.top + 2, Math.min(editorRect.bottom - 2, y));
    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
    };
  })()`);
}

/**
 * Ensure a real caret is inside the prompt editor before typing.
 * Native click is best-effort: Jimeng mention re-renders can swallow the click
 * without leaving a selection. Always re-place the caret via JS afterward and
 * only fail when every strategy leaves the caret outside the editor.
 */
async function ensurePromptEditorCaret(page) {
  await placeCaretAtPromptEditorEnd(page);
  if (await isCaretInPromptEditor(page)) return;

  const target = await computePromptEditorEndClickPoint(page);
  if (target?.ok && typeof page.nativeClick === 'function') {
    await page.nativeClick(target.x, target.y);
    await page.sleep(0.12);
    await placeCaretAtPromptEditorEnd(page);
    if (await isCaretInPromptEditor(page)) return;
  }

  // Last resort: click the editor content box itself, then re-place caret.
  const box = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return null;
    const r = editor.getBoundingClientRect();
    return {
      x: Math.round(r.left + Math.min(40, r.width / 3)),
      y: Math.round(r.top + Math.min(28, r.height / 2)),
    };
  })()`);
  if (box && typeof page.nativeClick === 'function') {
    await page.nativeClick(box.x, box.y);
    await page.sleep(0.12);
    await placeCaretAtPromptEditorEnd(page);
  }

  if (!(await isCaretInPromptEditor(page))) {
    throw phaseError(
      'prompt',
      'Could not place a caret inside the Jimeng prompt editor after mention/text updates',
      'No generation was submitted. Inspect the visible editor and retry.',
    );
  }
}

/** @deprecated Prefer ensurePromptEditorCaret — kept as an alias for call sites. */
async function clickPromptEditorEnd(page) {
  await ensurePromptEditorCaret(page);
}

async function insertNativeText(page, text) {
  if (!text) return;
  if (typeof page.nativeType === 'function') {
    await page.nativeType(text);
    return;
  }
  await page.insertText(text);
}

/**
 * Open the mention picker by clicking the composer dock '@' button.
 * This is more reliable than synthesizing '@' / Shift+2, which often inserts
 * the character without triggering Jimeng's mention plugin.
 */
async function openMentionPickerViaToolbar(page) {
  const marker = nextMarker('mention-at');
  const marked = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    const roots = [];
    let node = editor.parentElement;
    for (let i = 0; node && i < 10; i += 1, node = node.parentElement) roots.push(node);
    const scope = roots[roots.length - 1] || document.body;
    const readable = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\\s+/g, '')
      .trim();
    const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter(visible);
    const scored = buttons.map((el) => {
      const text = readable(el);
      const cls = String(el.className || '');
      let score = 0;
      if (text === '@' || text.endsWith('@') || text.includes('提及') || text.includes('mention')) score += 80;
      if (cls.includes('toolbar-button') && cls.includes('icon-only') && !text) score += 40;
      if (cls.includes('toolbar-button') && cls.includes('icon-only')) score += 15;
      if (cls.includes('voice-input') || cls.includes('submit-button')) score -= 200;
      if (text === '自动' || text.startsWith('自动') || text.includes('技能') || text.includes('Agent')) score -= 200;
      return { el, score, text };
    }).filter((item) => item.score > 0);
    scored.sort((a, b) => b.score - a.score || (
      a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left
    ));
    if (scored.length === 0) return { ok: false, reason: 'button-not-found', count: buttons.length };
    scored[0].el.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true, via: 'toolbar-at', text: scored[0].text, score: scored[0].score };
  })()`);
  if (!marked?.ok) return marked;
  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  return marked;
}

async function typeMentionQuery(page, text) {
  for (const char of text) {
    if (char === '@' || /^[0-9]$/.test(char)) {
      await typeMentionAsciiKey(page, char);
    } else {
      // Playwright keyboard.type() uses text insertion for non-US-layout CJK
      // characters. Once @ has opened the picker, this updates its filter.
      await insertNativeText(page, char);
    }
    // Space out each character so Jimeng's mention filter can keep up.
    await page.sleep(MENTION_KEY_GAP_S);
  }
}

async function typeMentionAsciiKey(page, char) {
  const isAtSign = char === '@';
  const virtualKeyCode = isAtSign ? 0x32 : char.charCodeAt(0);
  const event = {
    key: char,
    code: isAtSign ? 'Digit2' : `Digit${char}`,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers: isAtSign ? 8 : 0,
  };
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...event,
    text: char,
    unmodifiedText: isAtSign ? '2' : char,
  });
  await page.cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...event,
  });
}

async function insertSoftBreak(page) {
  // Verify the break actually landed: Shift+Enter can be swallowed when the
  // editor just committed a mention (flaky lineStructure checkpoints).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clickPromptEditorEnd(page);
    await focusPromptEditorEnd(page);
    // Shift modifier bit = 8. Do not use bare nativeKeyPress('Enter'): current
    // Chrome drops incomplete Enter descriptors (no code / no text).
    await dispatchEnterKey(page, 8);
    await page.sleep(0.25);
    const broke = await page.evaluate(`(() => {
      ${buildPromptEditorLocatorScript()}
      const editor = findPromptEditor();
      if (!editor) return false;
      const text = editor.innerText || '';
      if (text.endsWith('\\n')) return true;
      const blocks = [...editor.children].filter((el) => {
        const cls = String(el.className || '');
        return cls.includes('paragraph') || el.tagName === 'P' || el.tagName === 'BR';
      });
      return blocks.length >= 2;
    })()`);
    if (broke) return;
    await page.sleep(0.2);
  }
}

export function buildMentionCandidateExpression(asset, marker, click = false) {
  return `(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').toLocaleLowerCase();
    const variants = ${JSON.stringify([asset.label, asset.filename, asset.mentionName])}.map(compact).filter(Boolean);
    const matchesVariant = ${mentionTextMatchesVariant.toString()};
    const registryKey = '__opencliJimengMentionCandidateRegistry';
    let registry = window[registryKey];
    if (!(registry instanceof Map)) {
      registry = new Map();
      window[registryKey] = registry;
    }
    if (!${JSON.stringify(click)}) registry.clear();
    const options = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .filter(visible)
      .filter((option) => {
        const rect = option.getBoundingClientRect();
        return rect.height <= 80 && rect.width <= 420;
      });
    const named = options.map((option) => ({
      option,
      name: compact((option.getAttribute('aria-label') || '') + ' ' + (option.innerText || option.textContent || '')),
    }));
    const matches = named.filter(({ name }) => variants.some((variant) => matchesVariant(name, variant)));
    if (matches.length !== 1) {
      if (${JSON.stringify(click)}) {
        registry.delete(${JSON.stringify(marker)});
        document.querySelectorAll('[${TARGET_ATTR}="${marker}"]')
          .forEach((node) => node.removeAttribute(${JSON.stringify(TARGET_ATTR)}));
      }
      const suggestion = document.querySelector('.suggestion, [class*="suggestion"]');
      const menus = [...document.querySelectorAll('[role="listbox"], [role="menu"], [class*="mention"], [class*="suggestion"]')]
        .filter(visible)
        .map((el) => ({
          cls: String(el.className || '').slice(0, 70),
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
        }));
      return {
        ok: false,
        count: matches.length,
        options: named.map(({ name }) => name).filter(Boolean).slice(0, 8),
        suggestion: suggestion ? String(suggestion.className) + ' ' + (suggestion.innerText || '').replace(/\\s+/g, ' ').slice(0, 40) : null,
        menus,
      };
    }
    const marked = [...document.querySelectorAll(
      '[${TARGET_ATTR}="${marker}"]',
    )];
    if (${JSON.stringify(click)}) {
      const approved = registry.get(${JSON.stringify(marker)});
      const sameCandidate = approved instanceof HTMLElement
        && approved.isConnected
        && marked.length === 1
        && marked[0] === approved
        && approved === matches[0].option;
      if (!sameCandidate) {
        registry.delete(${JSON.stringify(marker)});
        marked.forEach((node) => node.removeAttribute(${JSON.stringify(TARGET_ATTR)}));
        return {
          ok: false,
          status: 'candidate-changed',
          markedCount: marked.length,
          approvedConnected: approved instanceof HTMLElement && approved.isConnected,
        };
      }
    } else {
      registry.set(${JSON.stringify(marker)}, matches[0].option);
    }
    matches[0].option.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    const rect = matches[0].option.getBoundingClientRect();
    if (${JSON.stringify(click)}) {
      try {
        matches[0].option.click();
      } finally {
        registry.delete(${JSON.stringify(marker)});
        matches[0].option.removeAttribute(${JSON.stringify(TARGET_ATTR)});
      }
    }
    return {
      ok: true,
      status: ${JSON.stringify(click)} ? 'clicked' : 'ready',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: matches[0].name,
    };
  })()`;
}

async function inspectMentionCandidateTarget(page, marker, asset) {
  const result = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').toLocaleLowerCase();
    const variants = ${JSON.stringify([asset.label, asset.filename, asset.mentionName])}.map(compact).filter(Boolean);
    const option = document.querySelector('[${TARGET_ATTR}="${marker}"]');
    if (!visible(option)) return { ok: false, reason: 'candidate-not-visible' };
    const name = compact(
      (option.getAttribute('aria-label') || '') + ' ' + (option.innerText || option.textContent || ''),
    );
    const matchesVariant = ${mentionTextMatchesVariant.toString()};
    if (!variants.some((variant) => matchesVariant(name, variant))) {
      return { ok: false, reason: 'candidate-text-changed', name };
    }
    const rect = option.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    // Center-obscured is non-fatal for DOM click selection; report it but
    // still mark ok when the unique candidate is visible and text-matched.
    const centerClear = !!(hit && option.contains(hit));
    return {
      ok: true,
      x,
      y,
      centerClear,
      reason: centerClear ? null : 'candidate-center-obscured',
      hitTag: hit?.tagName || null,
      hitClass: String(hit?.className || ''),
    };
  })()`);
  // Soft result for the attempt loop. Hard failures only when missing/mismatched.
  if (!result?.ok) {
    return result || { ok: false, reason: 'inspect-failed' };
  }
  return result;
}

async function getMentionState(page, asset) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    // \`visible\` comes from buildPromptEditorLocatorScript().
    const editor = findPromptEditor();
    if (!editor) {
      return {
        hasRaw: false,
        matchingMentionCount: 0,
        menuVisible: false,
        mentionLabels: [],
      };
    }
    const compact = (value) => String(value || '').replace(/\\u200b/g, '').replace(/\\s+/g, '').toLocaleLowerCase();
    const read = (node) => {
      let text = node.innerText || node.textContent || '';
      if (!text.trim()) {
        const child = node.querySelector('[title], [aria-label], img[alt]');
        if (child) text = child.getAttribute('title') || child.getAttribute('aria-label') || child.getAttribute('alt') || '';
      }
      return text;
    };
    const variants = ${JSON.stringify([asset.label, asset.filename, asset.mentionName])}.map(compact).filter(Boolean);
    const editorText = (editor.innerText || editor.textContent || '').replace(/\\u00a0/g, ' ');
    const tail = compact(editorText.slice(-Math.max(160, ${JSON.stringify(asset.label)}.length * 8)));
    const mentionNodes = [...editor.querySelectorAll(${JSON.stringify(MENTION_NODE_SELECTOR)})].filter(visible);
    const mentionLabels = [...editor.querySelectorAll('.node-reference-mention-tag')]
      .filter(visible)
      .map((node) => compact(read(node)))
      .filter(Boolean);
    const matchesVariant = ${mentionTextMatchesVariant.toString()};
    const matchingMentionCount = mentionNodes.filter((node) => {
      const text = compact(read(node));
      return variants.some((variant) => matchesVariant(text, variant));
    }).length;
    const menuVisible = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .filter(visible)
      .some((node) => {
        const text = String(read(node) || '').replace(/\\s+/g, '');
        return /(?:图片|视频|音频)\\d+/.test(text);
      });
    return {
      hasRaw: tail.includes(compact('@' + ${JSON.stringify(asset.label)})),
      matchingMentionCount,
      menuVisible,
      mentionLabels,
    };
  })()`);
}

export function isMentionChipAppended(before, after, asset, expectedMentionCount) {
  if (!Array.isArray(before?.mentionLabels) || !Array.isArray(after?.mentionLabels)) {
    return false;
  }
  if (
    before.mentionLabels.length !== expectedMentionCount - 1
    || after.mentionLabels.length !== expectedMentionCount
  ) {
    return false;
  }
  for (let i = 0; i < before.mentionLabels.length; i += 1) {
    if (before.mentionLabels[i] !== after.mentionLabels[i]) return false;
  }
  const compact = (value) => String(value || '').replace(/\s+/g, '').toLocaleLowerCase();
  const appended = after.mentionLabels[after.mentionLabels.length - 1] || '';
  return appended === compact(asset?.label);
}

export function isStrictMentionCommit(before, after, selection, asset, expectedMentionCount) {
  if (selection?.status !== 'clicked' || after?.hasRaw !== false || after?.menuVisible !== false) {
    return false;
  }
  return isMentionChipAppended(before, after, asset, expectedMentionCount);
}

/**
 * Locate `@图片N` even when Jimeng wraps/breaks the typed query (`@图` + newline + `片2`).
 * Returns the last match so leftover query after a chip is preferred.
 */
export function findSpacedNeedleRange(joined, needle) {
  const compactNeedle = String(needle || '').replace(/[\s\u00a0\u200b]/g, '');
  if (!compactNeedle) return null;
  const ignorable = /[\s\u00a0\u200b]/;
  let best = null;
  for (let i = 0; i < joined.length; i += 1) {
    let needleIndex = 0;
    let start = -1;
    for (let j = i; j < joined.length && needleIndex < compactNeedle.length; j += 1) {
      const ch = joined[j];
      if (ignorable.test(ch)) continue;
      if (ch !== compactNeedle[needleIndex]) break;
      if (start < 0) start = j;
      needleIndex += 1;
      if (needleIndex === compactNeedle.length) {
        best = { start, end: j + 1 };
      }
    }
  }
  return best;
}

/**
 * Poll after the atomic candidate click until the mention commit is observable:
 * - the click ran;
 * - exactly one ordered .node-reference-mention-tag was appended for this asset;
 * - the raw query is gone and the mention menu is closed.
 * Chip rendering can lag behind the click on slow hosts.
 */
async function waitForMentionCommit(
  page,
  asset,
  before,
  selection,
  expectedMentionCount,
  timeoutMs,
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let after = before;
  let stripAttempts = 0;
  while (Date.now() < deadline) {
    after = await getMentionState(page, asset);
    if (isStrictMentionCommit(before, after, selection, asset, expectedMentionCount)) {
      await page.sleep(0.15);
      return { committed: true, after };
    }
    // Hub/toolbar flow can insert the chip while leaving the typed filter
    // ("@图片N" or just "图片N") in the composer. Strip leftover text once
    // the ordered chip is visible, then re-read.
    if (
      stripAttempts < 3
      && after?.menuVisible === false
      && isMentionChipAppended(before, after, asset, expectedMentionCount)
    ) {
      stripAttempts += 1;
      await stripLeftoverRawMentionQuery(page, asset);
      continue;
    }
    await page.sleep(0.25);
  }
  return { committed: false, after };
}

/**
 * Delete leftover "@图片N" / "@视频N" / "@音频N" text that sits outside mention
 * chips after Jimeng inserts the chip without consuming the typed query.
 */
async function stripLeftoverRawMentionQuery(page, asset) {
  const label = String(asset?.label || '');
  if (!label) return;
  const removed = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return { ok: false, reason: 'no-editor' };
    const needles = ${JSON.stringify(['@' + label, label])};
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const chunks = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('.node-reference-mention-tag, [data-type*="mention"], [data-node-type*="mention"]')) {
        continue;
      }
      chunks.push({ node, value: node.nodeValue || '' });
    }
    let joined = '';
    const spans = [];
    for (const chunk of chunks) {
      spans.push({
        node: chunk.node,
        start: joined.length,
        end: joined.length + chunk.value.length,
      });
      joined += chunk.value;
    }
    const findSpacedNeedleRange = ${findSpacedNeedleRange.toString()};
    let hit = null;
    for (const needle of needles) {
      const candidate = findSpacedNeedleRange(joined, needle);
      if (candidate && (!hit || candidate.start >= hit.start)) hit = candidate;
    }
    if (!hit) return { ok: false, reason: 'not-found' };
    const startSpan = spans.find((span) => hit.start >= span.start && hit.start < span.end);
    const endSpan = spans.find((span) => hit.end > span.start && hit.end <= span.end) || startSpan;
    if (!startSpan || !endSpan) return { ok: false, reason: 'span-mismatch' };
    const range = document.createRange();
    range.setStart(startSpan.node, hit.start - startSpan.start);
    range.setEnd(endSpan.node, hit.end - endSpan.start);
    range.deleteContents();
    return { ok: true, start: hit.start, end: hit.end };
  })()`);
  if (removed?.ok) {
    await placeCaretAtPromptEditorEnd(page).catch(() => null);
    await page.sleep(MENTION_KEY_GAP_S);
  }
}

/**
 * Pre-input gate: Agent mode + dock readiness.
 *
 * Does NOT reopen the Auto preference dropdown. Opening that panel was flaky
 * on Hub (wrong target / blank page side-effects) and is not required after
 * configureAutoVideoPreference already applied Auto/Video once.
 *
 * When the panel is closed, Auto is inferred from the dock combobox text
 * ("自动"). Video cannot be re-read without reopening the panel — trust the
 * earlier configure step and only require Agent + Auto signals here.
 */
export async function runPreInputControlsCheck(page) {
  const surface = await probeJimengAgentSurface(page);
  const snapshot = {
    surfaceReady: surface.ready === true || (surface.editorReady === true && surface.fileInputCount > 0),
    agentSelected: surface.agentSelected === true,
    // probe already folds dock "自动" button into autoEnabled/videoSelected
    // when the preference tooltip is closed.
    autoEnabled: surface.autoEnabled === true,
    videoSelected: surface.videoSelected === true,
  };

  const report = evaluatePreInputControls(snapshot);
  if (!report.ok) {
    throw phaseError(
      'pre-input',
      `Pre-input controls check failed: ${report.failures.join(', ')}`,
      'No generation was submitted. Fix Agent/Auto/Video controls before uploading references or typing the prompt.',
    );
  }
  return report;
}

/**
 * Post-input content gate: references + prompt only.
 * Does not reopen preference panels.
 */
export async function runContentCheckpoint(page, agentPrompt, assets, options = {}) {
  const snapshot = await collectContentCheckpointSnapshot(page);
  const expectations = buildCheckpointExpectations(agentPrompt, assets);
  // Reference cards are counted from the dock strip, never from remove-button
  // attributes (those only exist/hover on some UI versions). Empty upload
  // slots (trailing "+" placeholder) are not references and are excluded.
  const dock = await collectDockReferenceSnapshot(page);
  const visibleReferenceCount = countVisibleMediaReferences(dock.cards);
  snapshot.referenceCount = (
    dock.hasCollapsedMoreEntry === true
    && visibleReferenceCount < expectations.expectedReferences
    && snapshot.mentionCount === expectations.expectedMentions
  )
    ? expectations.expectedReferences
    : visibleReferenceCount;
  snapshot.requireSubmitArmed = options.requireSubmitArmed === true;
  const report = evaluateContentCheckpoint(snapshot, expectations);
  if (!report.ok) {
    const diagnostic = {
      failures: report.failures,
      expectedLines: expectations.expectedLines,
      observedLines: snapshot.editorLines,
      expectedMentions: expectations.expectedMentions,
      observedMentions: snapshot.mentionCount,
      expectedReferences: expectations.expectedReferences,
      observedReferences: snapshot.referenceCount,
      observedLabels: snapshot.observedMentionLabels,
      rawAt: snapshot.rawAt,
      menuVisible: snapshot.menuVisible,
    };
    throw phaseError(
      'checkpoint',
      `Content checkpoint failed: ${report.failures.join(', ')} (${JSON.stringify(diagnostic)})`,
      'No generation was submitted. Inspect uploaded references and the composed prompt/mentions.',
    );
  }
  return report;
}

async function collectContentCheckpointSnapshot(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    const surfaceReady = !!editor
      && document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)}).length > 0;
    const editorText = editor
      ? (editor.innerText || editor.textContent || '').replace(/\\u00a0/g, ' ')
      : '';
    const editorLines = editor
      ? [...editor.children].flatMap((block) => {
        const clone = block.cloneNode(true);
        clone.querySelectorAll('.node-reference-mention-tag').forEach((mention) => {
          mention.replaceWith(document.createTextNode(mention.innerText || mention.textContent || ''));
        });
        clone.querySelectorAll(
          '[data-rich-placeholder], .rich-placeholder-widget, .ProseMirror-separator, .ProseMirror-trailingBreak',
        ).forEach((node) => node.remove());
        clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\\n')));
        return String(clone.textContent || '').split('\\n');
      })
      : [];
    const observedMentionLabels = editor
      ? [...editor.querySelectorAll('.node-reference-mention-tag')]
        .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim())
        .filter(Boolean)
      : [];
    const menuVisible = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .some((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
    const submitCandidates = [...document.querySelectorAll(
      'button[class*="submit-button"], button[class*="submit"], button.lv-btn-primary.lv-btn-shape-circle',
    )].filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && !el.disabled
        && el.getAttribute('aria-disabled') !== 'true'
        && !el.className.toString().includes('disabled');
    });
    return {
      surfaceReady,
      // Overridden by runContentCheckpoint with the dock-strip count.
      referenceCount: 0,
      mentionCount: observedMentionLabels.length,
      observedMentionLabels,
      rawAt: editorText.includes('@'),
      menuVisible,
      editorLines: editorLines.map((line) => String(line || '')
        .replace(/@/g, '')
        .replace(/[\\u00a0\\u200b\\s]+/g, '')),
      editorTextNormalized: editorText
        .replace(/@/g, '')
        .replace(/[\\u00a0\\u200b\\s]+/g, ''),
      submitEnabled: submitCandidates.length > 0,
    };
  })()`);
}

export function assertSubmitCapabilities(page) {
  const missing = [];
  if (typeof page?.startNetworkCapture !== 'function') missing.push('startNetworkCapture');
  if (typeof page?.readNetworkCapture !== 'function') missing.push('readNetworkCapture');
  if (missing.length > 0) {
    const err = new Error(`Missing page capability for submit: ${missing.join(', ')}`);
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Formal submit requires network capture support in the browser driver.';
    throw err;
  }
}

export async function inspectComposerAssetIdState(page, assetId) {
  if (typeof page?.evaluate !== 'function') {
    return { assetIdInComposer: false, assetIdOutsideComposer: false, error: 'page.evaluate unavailable' };
  }
  return await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const assetId = ${JSON.stringify(String(assetId || ''))};
    if (!assetId) return { assetIdInComposer: false, assetIdOutsideComposer: false };

    const editor = findPromptEditor();
    if (!editor) {
      return {
        assetIdInComposer: false,
        assetIdOutsideComposer: false,
        error: 'prompt editor not found',
      };
    }
    const editorText = editor ? (editor.innerText || editor.textContent || '') : '';
    const assetIdInComposer = editorText.includes(assetId);

    let assetIdOutsideComposer = false;
    const candidates = [...document.querySelectorAll('div, p, span, li')];
    for (const el of candidates) {
      if (editor && editor.contains(el)) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const text = el.innerText || el.textContent || '';
      if (text.includes(assetId)) {
        if (!el.contains(editor)) {
          assetIdOutsideComposer = true;
          break;
        }
      }
    }

    return {
      assetIdInComposer,
      assetIdOutsideComposer,
    };
  })()`).catch(() => ({ assetIdInComposer: false, assetIdOutsideComposer: false, error: 'evaluate failed' }));
}

/**
 * Click the visible generate control only after a green checkpoint and verify
 * server reception via SSE ACK matching canonical assetId.
 */
export async function submitPreparedGeneration(page, canonicalOrAssetId, options = {}) {
  const assetId = (
    typeof canonicalOrAssetId === 'string'
      ? canonicalOrAssetId
      : (canonicalOrAssetId?.assetId || options?.assetId || '')
  );
  if (!assetId) {
    const err = new Error('assetId is required for submit ACK validation');
    err.phase = 'submit';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Ensure canonical assetId is passed to submitPreparedGeneration.';
    throw err;
  }

  // 1. Page capabilities check for submit
  assertSubmitCapabilities(page);

  // 2. Start network capture for conversation endpoint
  const captureStarted = await page.startNetworkCapture(JIMENG_CONVERSATION_PATH).catch(() => false);
  if (!captureStarted) {
    const err = new Error('Network capture could not be started for conversation submit ACK');
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Network capture is required before clicking submit to verify server receipt.';
    throw err;
  }

  // 3. Clear/drain pre-click network capture entries
  let drainedEntries;
  try {
    const raw = await page.readNetworkCapture();
    if (!Array.isArray(raw)) {
      throw new Error('network capture drain returned a non-array payload');
    }
    drainedEntries = raw;
  } catch (drainErr) {
    const err = new Error(`Pre-click network capture drain failed: ${drainErr.message || drainErr}`);
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Network capture could not be drained before clicking submit. Check browser driver capabilities.';
    throw err;
  }

  // A delayed response from a prior proven-not-sent retry may arrive before
  // the next click. Never discard matching evidence and click again.
  const normalizedDrainedEntries = drainedEntries.map(normalizeCaptureEntry);
  if (normalizedDrainedEntries.some((entry) => entry.captureMalformed)) {
    const err = new Error('Pre-click network capture drain contained malformed entries without a usable URL');
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Network capture returned malformed data before clicking submit. Check browser driver compatibility.';
    throw err;
  }
  const priorEndpointEntries = normalizedDrainedEntries.filter((entry) => (
    isConversationUrl(entry.url)
  ));
  if (priorEndpointEntries.length > 0) {
    const priorAck = classifySubmitAck({
      entries: priorEndpointEntries,
      assetId,
      timedOut: true,
    });
    if (priorAck.kind === 'confirmed') {
      return {
        accepted: true,
        confirmation: 'ack_confirmed',
        threadId: priorAck.threadId || '',
        conversationId: priorAck.conversationId || '',
        submitRequestCount: priorAck.matchingRequestCount || 1,
      };
    }

    const err = new Error(`JIMENG_SUBMIT_UNCONFIRMED: Conversation endpoint evidence appeared before the next submit click (${priorAck.reason || priorAck.kind})`);
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'A previous submit attempt may have reached the server. Do not click again or automatically retry.';
    throw err;
  }

  // 4. Locate and mark submit button
  const marker = nextMarker('submit');
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll(
      'button[class*="submit-button"], button[class*="submit"], button.lv-btn-primary.lv-btn-shape-circle'
    )].filter((el) => (
      visible(el)
      && !el.disabled
      && el.getAttribute('aria-disabled') !== 'true'
      && !String(el.className || '').includes('disabled')
    ));
    if (candidates.length === 0) return { ok: false, count: 0 };
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.bottom - ar.bottom) || (br.right - ar.right);
    });
    candidates[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true, count: candidates.length };
  })()`);

  if (!marked?.ok) {
    const err = new Error('Could not locate an enabled Jimeng generate/submit control after checkpoint');
    err.phase = 'submit-button-missing';
    err.retryable = true;
    err.nonRetryable = false;
    err.hint = 'Checkpoint passed but formal submission is blocked until the generate button is visible and enabled.';
    throw err;
  }

  // 5. Click the submit button (unconditional Escape removed; capture click error)
  let clickError = null;
  try {
    await page.click(`[${TARGET_ATTR}="${marker}"]`);
  } catch (clickErr) {
    clickError = clickErr;
  }

  // 6. Keep the destructive capture buffer intact for the full ACK window.
  // DOM polling only preserves the latest fallback state; it cannot prove the
  // SSE stream has completed, so it must not shorten the network wait.
  const requestedTimeoutMs = Number(options.timeoutMs ?? 15_000);
  const requestedPollIntervalMs = Number(options.pollIntervalMs ?? 500);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, requestedTimeoutMs)
    : 15_000;
  const pollIntervalMs = Number.isFinite(requestedPollIntervalMs)
    ? Math.max(50, requestedPollIntervalMs)
    : 500;
  const deadline = Date.now() + timeoutMs;
  let pageState = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      await page.sleep(Math.min(pollIntervalMs, remainingMs) / 1000);
    } catch (sleepErr) {
      const err = new Error(`Submit ACK wait failed after the generate click: ${sleepErr.message || sleepErr}`);
      err.phase = 'submit-unconfirmed';
      err.retryable = false;
      err.nonRetryable = true;
      err.hint = 'The paid submit state is unknown after the click. Do not automatically retry.';
      throw err;
    }
    pageState = await inspectComposerAssetIdState(page, assetId);
  }

  let capturedEntries;
  try {
    const raw = await page.readNetworkCapture();
    if (!Array.isArray(raw)) {
      throw new Error('network capture read returned a non-array payload');
    }
    capturedEntries = raw;
  } catch (readErr) {
    const err = new Error(`Network capture read failed after submit click: ${readErr.message || readErr}`);
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'Request may have been sent, but network capture could not be read. Do not automatically retry.';
    throw err;
  }

  // 7. Classify the one-shot capture. A pending or malformed response is
  // unconfirmed at this point and must never enter the automatic retry path.
  if (!pageState) {
    pageState = await inspectComposerAssetIdState(page, assetId);
  }
  let finalAck;
  try {
    finalAck = classifySubmitAck({
      entries: capturedEntries,
      assetId,
      timedOut: true,
      pageState,
    });
  } catch (classifyErr) {
    const err = new Error(`Submit ACK classification failed after the generate click: ${classifyErr.message || classifyErr}`);
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    err.hint = 'The paid submit state is unknown after the click. Do not automatically retry.';
    throw err;
  }

  if (finalAck.kind === 'confirmed') {
    return {
      accepted: true,
      confirmation: 'ack_confirmed',
      threadId: finalAck.threadId || '',
      conversationId: finalAck.conversationId || '',
      submitRequestCount: finalAck.matchingRequestCount || 1,
    };
  }

  if (finalAck.kind === 'rejected') {
    const err = new Error(`JIMENG_SUBMIT_REJECTED: Server rejected conversation request (code: ${finalAck.errorCode}, msg: ${finalAck.errorMsg || 'none'}, http: ${finalAck.httpStatus ?? 'unknown'})`);
    err.phase = 'submit-rejected';
    err.retryable = false;
    err.nonRetryable = true;
    err.errorCode = finalAck.errorCode;
    err.errorMsg = finalAck.errorMsg;
    err.hint = `Server rejected the generation request: ${finalAck.errorMsg || 'rejected'}. Do not automatically retry.`;
    throw err;
  }

  if (finalAck.kind === 'not_sent') {
    const err = clickError
      ? new Error(`JIMENG_SUBMIT_NOT_SENT: Submit click threw error (${clickError.message || clickError}), no conversation request was sent, and prompt remains in composer`)
      : new Error('JIMENG_SUBMIT_NOT_SENT: Submit click did not trigger a conversation request and prompt remains in composer');
    err.phase = 'submit-not-sent';
    err.retryable = true;
    err.nonRetryable = false;
    err.hint = 'Submit click did not produce a network request. Safe to retry with a fresh workspace.';
    throw err;
  }

  const err = new Error(`JIMENG_SUBMIT_UNCONFIRMED: ${finalAck.reason || 'Conversation request or page state could not be confirmed safely'}`);
  err.phase = 'submit-unconfirmed';
  err.retryable = false;
  err.nonRetryable = true;
  err.hint = 'Generation state is uncertain. Do not automatically retry to avoid duplicate charges; check workspace status manually.';
  throw err;
}

export function normalizePromptValidationLines(value) {
  return normalizeCheckpointLines(value);
}

export function normalizePromptValidationText(value) {
  return normalizeCheckpointText(value);
}

export {
  buildCheckpointExpectations,
  evaluateContentCheckpoint,
  evaluatePreInputControls,
  evaluatePreparationCheckpoint,
} from './checkpoint.js';

async function waitForPreferenceTooltipClosed(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeJimengAgentSurface(page)).autoPopupOpen) return true;
    await page.sleep(0.1);
  }
  return false;
}

function phaseError(phase, message, hint = 'Inspect the visible Jimeng workspace and retry.', failedAssetIndex) {
  const err = new Error(message);
  err.phase = phase;
  err.hint = hint;
  if (Number.isInteger(failedAssetIndex)) err.failedAssetIndex = failedAssetIndex;
  return err;
}

function normalizePreparationError(err, fallbackFailedAssetIndex) {
  if (err && typeof err === 'object' && typeof err.message === 'string') {
    return {
      message: err.message,
      hint: typeof err.hint === 'string' ? err.hint : 'Inspect the visible Jimeng workspace and retry.',
      phase: typeof err.phase === 'string' ? err.phase : 'surface',
      failedAssetIndex: Number.isInteger(err.failedAssetIndex)
        ? err.failedAssetIndex
        : fallbackFailedAssetIndex,
      retryable: err.retryable !== false && !err.nonRetryable,
    };
  }
  return {
    message: describeError(err),
    hint: 'Inspect the visible Jimeng workspace and retry.',
    phase: 'surface',
    failedAssetIndex: fallbackFailedAssetIndex,
    retryable: true,
  };
}

function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

function nextMarker(prefix) {
  return `jimeng-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

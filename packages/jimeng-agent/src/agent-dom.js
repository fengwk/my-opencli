/**
 * Visible-UI Jimeng Agent preparation, checkpoint, and optional submit.
 *
 * Flow:
 *   dock composer (回到底部 / scroll-to-bottom, idempotent)
 *   -> clear draft
 *   -> Agent/Auto/video configuration
 *   -> pre-input controls check (mode/preference only)
 *   -> upload refs -> write prompt/mentions
 *   -> content checkpoint (references + prompt only)
 *   -> optional formal submit (--submit 1) only when content checkpoint passes
 *
 * Mention selection uses guarded Enter. Generation is never submitted unless
 * the content checkpoint is green and the caller explicitly requests submit.
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

/**
 * Retry decisions are pure to make the "avoid refresh when possible" policy
 * auditable. An in-page retry is allowed once for a healthy failed upload;
 * any later retry opens a fresh workspace and starts from the first asset.
 */
export function chooseRetryPlan({
  retriesUsed,
  retryBudget,
  priorInPlaceRetry,
  errorPhase,
  failedAssetIndex,
  surface,
}) {
  if (retriesUsed >= retryBudget) return { kind: 'stop' };
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
export async function prepareJimengAgentAsk(page, canonical, preparedAssets) {
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
  const mentionDebug = createMentionDebugSession(resolveMentionDebugOptions());

  await openWorkspace(page, workspaceUrl, { fresh: false });

  while (true) {
    try {
      // Always dock first. Safe when already at bottom (idempotent).
      // Covers the common "scrolled history up → composer collapsed" state.
      await ensureComposerDocked(page);
      await waitForAgentSurface(page);
      if (startAssetIndex === 0) {
        await clearInitialDraftState(page);
      }
      await selectAgentMode(page);
      await configureAutoVideoPreference(page);
      // Preference panel is still the source of truth for Auto/Video. Verify it
      // here, then close it before any upload/prompt typing.
      await runPreInputControlsCheck(page);
      await closeVisiblePreferenceTooltip(page);
      await uploadReferenceAssets(page, preparedAssets, uploads, startAssetIndex);
      // Jimeng may insert an uploaded reference chip at the document start.
      // Match the established flow: clear that platform-added draft state
      // before writing the canonical prompt and its explicit @ mentions.
      await ensureComposerDocked(page);
      await clearComposer(page, 'clear-after-upload');
      await fillPromptWithRichMentions(page, canonical.agentPrompt, preparedAssets, mentionDebug);

      const checkpoint = await runContentCheckpoint(
        page,
        canonical.agentPrompt,
        preparedAssets,
        { requireSubmitArmed: !!canonical.submit },
      );
      let submitted = false;
      if (canonical.submit) {
        await submitPreparedGeneration(page);
        submitted = true;
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
      };
    } catch (err) {
      const failure = normalizePreparationError(err, uploads.length);
      const surface = await probeJimengAgentSurface(page).catch(() => ({
        ready: false,
        fileInputCount: 0,
      }));
      if (failure.phase === 'clear-initial' && !clearRefreshUsed) {
        // A stale controlled editor can reject the first keyboard clear. Refresh
        // before mode selection/upload so recovery cannot duplicate references.
        clearRefreshUsed = true;
        priorInPlaceRetry = false;
        startAssetIndex = 0;
        uploads.splice(0);
        await openWorkspace(page, workspaceUrl, { fresh: false });
        continue;
      }
      const plan = chooseRetryPlan({
        retriesUsed,
        retryBudget: canonical.retry ?? 0,
        priorInPlaceRetry,
        errorPhase: failure.phase,
        failedAssetIndex: failure.failedAssetIndex,
        surface,
      });

      if (plan.kind === 'stop') {
        throw new CommandExecutionError(
          `JIMENG_PREPARE_FAILED: ${failure.message}`,
          `No generation was submitted. ${failure.hint} Retry with --retry ${Number(canonical.retry ?? 0) + 1} after checking the visible Jimeng workspace.`,
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
      await openWorkspace(page, workspaceUrl, { fresh: true });
    }
  }
}

/**
 * Visible page health snapshot. It intentionally exposes only UI state and
 * does not call hidden application endpoints or inspect internal stores.
 */
export async function probeJimengAgentSurface(page) {
  return page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const readable = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\\s+/g, ' ')
      .trim();
    const editors = [...document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR)})].filter(visible);
    const editor = findPromptEditor();
    const fileInputs = [...document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)})];
    // Count only explicit remove buttons on reference cards. Thumbnail-based
    // counting over-counts nested media and history tiles.
    const referenceCount = document.querySelectorAll('[data-reference-remove-button="true"]').length;
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
      referenceCount,
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
}

async function openWorkspace(page, workspaceUrl, { fresh: _fresh }) {
  // Always navigate the current automation tab.
  // Never open a new tab: Hub/CDP "Cannot attach to this target" and leftover
  // blank pages came from newTab + selectTab churn on fresh retries.
  await page.goto(workspaceUrl);
}

/**
 * Bring the Agent composer dock into view.
 *
 * Idempotent: safe to call when already at the bottom. Handles the common
 * "history scrolled up → floating 回到底部 → composer collapsed" state by:
 *   1. clicking the visible 「回到底部」 control when present
 *   2. scrolling main overflow containers to the bottom
 *   3. focusing the prompt editor when it is already mounted
 *
 * This is part of the standard CLI prepare path, not an optional recovery.
 */
async function ensureComposerDocked(page) {
  // 1) Click 「回到底部」 if visible (floating pill after scrolling history up).
  const backToBottom = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const compact = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\\s+/g, '');
    const candidates = [...document.querySelectorAll('button, [role="button"], div, span, a')]
      .filter(visible)
      .filter((el) => compact(el).includes('回到底部'));
    // Prefer the smallest leaf-like control (the floating pill, not a huge parent).
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
    const target = candidates[0] || null;
    if (!target) return { ok: false, reason: 'not-found' };
    const rect = target.getBoundingClientRect();
    target.setAttribute(${JSON.stringify(TARGET_ATTR)}, 'back-to-bottom');
    return {
      ok: true,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      text: compact(target).slice(0, 32),
    };
  })()`);

  if (backToBottom?.ok && typeof page.nativeClick === 'function') {
    await page.nativeClick(backToBottom.x, backToBottom.y);
    await page.sleep(0.25);
  } else if (backToBottom?.ok) {
    await page.click(`[${TARGET_ATTR}="back-to-bottom"]`).catch(() => null);
    await page.sleep(0.25);
  }

  // 2) Scroll window + overflow containers to bottom (no-op when already there).
  await page.evaluate(`(() => {
    try { window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0); } catch {}
    const nodes = [...document.querySelectorAll('div, main, section, aside')];
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const style = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY) && !/(auto|scroll)/.test(style.overflow)) continue;
      // Prefer large vertical scrollers (history / chat body).
      if (el.clientHeight < 120) continue;
      try { el.scrollTop = el.scrollHeight; } catch {}
    }
  })()`);
  await page.sleep(0.2);

  // 3) Soft-focus the editor if already mounted (does not throw if missing).
  await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return false;
    try { editor.focus(); } catch {}
    return true;
  })()`).catch(() => null);
  await page.sleep(0.15);
}

async function waitForAgentSurface(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let dockTick = 0;
  while (Date.now() < deadline) {
    last = await probeJimengAgentSurface(page);
    if (last.ready) return last;
    // Periodically re-dock while waiting — history scroll can re-collapse it.
    dockTick += 1;
    if (dockTick % 4 === 0) {
      await ensureComposerDocked(page).catch(() => null);
    }
    await page.sleep(0.25);
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
  await clearReferenceAssets(page);
  const composer = await getComposerClearState(page);
  const surface = await probeJimengAgentSurface(page);
  if (!composer.empty || surface.referenceCount !== 0) {
    throw phaseError(
      'clear-initial',
      `Jimeng initial draft cleanup was incomplete (${composer.textLength} text character(s), ${composer.mentionCount} mention node(s), ${surface.referenceCount} reference card(s))`,
      'No generation was submitted. Inspect the visible composer and reference strip before retrying.',
    );
  }
}

async function clearReferenceAssets(page) {
  const maxReferences = 24;
  for (let removed = 0; removed < maxReferences; removed += 1) {
    const marker = nextMarker(`reference-remove-${removed}`);
    const state = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const controls = [...document.querySelectorAll('[data-reference-remove-button="true"]')];
      if (controls.length === 0) return { done: true, count: 0 };
      const visibleControls = controls.filter(visible);
      if (visibleControls.length === 0) {
        return { done: false, count: controls.length, reason: 'remove-controls-hidden' };
      }
      visibleControls[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
      return {
        done: false,
        count: controls.length,
        selector: '[${TARGET_ATTR}="${marker}"]',
      };
    })()`);
    if (state?.done) return;
    if (!state?.selector) {
      throw phaseError(
        'clear-references',
        `Jimeng retained ${state?.count ?? 'unknown'} reference card(s), but no visible remove control was available`,
        'No generation was submitted. Inspect the visible reference strip and clear stale cards manually.',
      );
    }

    await page.click(state.selector);
    const deadline = Date.now() + 2_000;
    let remaining = state.count;
    while (Date.now() < deadline) {
      remaining = await page.evaluate(
        `document.querySelectorAll('[data-reference-remove-button="true"]').length`,
      );
      if (remaining < state.count) break;
      await page.sleep(0.1);
    }
    if (remaining >= state.count) {
      throw phaseError(
        'clear-references',
        `Jimeng reference count did not decrease after clicking a remove control (${state.count} card(s))`,
        'No generation was submitted. Inspect the visible reference strip and retry.',
      );
    }
  }

  throw phaseError(
    'clear-references',
    `Jimeng still exposes reference cards after ${maxReferences} removal attempts`,
    'No generation was submitted. The reference strip exceeded the safe cleanup bound.',
  );
}

async function uploadReferenceAssets(page, assets, uploads, startAssetIndex) {
  for (let index = startAssetIndex; index < assets.length; index += 1) {
    const asset = assets[index];
    const before = await probeJimengAgentSurface(page);
    if (before.referenceCount !== index) {
      throw phaseError(
        'upload',
        `Expected ${index} confirmed Jimeng reference card(s) before ${asset.label}, found ${before.referenceCount}`,
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

    await waitForUploadCompletion(page, asset, index, index + 1);
    uploads[index] = asset;
    uploads.length = index + 1;
  }
}

async function markCurrentUploadSlot(page, marker) {
  return page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)})];
    const preferred = inputs.filter((input) => /reference-upload/i.test(input.id || ''));
    const candidates = preferred.length > 0
      ? preferred
      : inputs.filter((input) => input.multiple || input.accept.includes('image') || input.accept.includes('video') || input.accept.includes('audio'));
    if (candidates.length !== 1) {
      return { ok: false, count: candidates.length, ids: candidates.map((input) => input.id || '') };
    }
    const input = candidates[0];
    input.setAttribute(${JSON.stringify(UPLOAD_SLOT_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      selector: '[${UPLOAD_SLOT_ATTR}="${marker}"]',
    };
  })()`);
}

async function waitForUploadCompletion(page, asset, failedAssetIndex, expectedReferenceCount) {
  // Images usually index quickly; video/audio often need longer for the
  // reference strip card and duration badge to appear.
  const timeoutMs = asset.kind === 'image' ? 15_000 : 45_000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeJimengAgentSurface(page);
    const failure = last.alerts.find((text) => /上传失败|素材.*失败|upload.*fail/i.test(text));
    if (failure) {
      throw phaseError(
        'upload',
        `Jimeng rejected ${asset.label} (${asset.filename}): ${failure}`,
        'No generation was submitted. The visible UI rejected this file; check account/workspace entitlement and retry later.',
        failedAssetIndex,
      );
    }
    // Accept exact match, or >= expected when remove-button count lags and then
    // catches up without inventing extras beyond a single pending card.
    if (last.referenceCount === expectedReferenceCount) {
      await page.sleep(asset.kind === 'image' ? 0.8 : 1.2);
      return;
    }
    if (last.referenceCount > expectedReferenceCount) {
      // Tolerate one extra transient card only briefly; otherwise fail.
      if (last.referenceCount === expectedReferenceCount + 1) {
        await page.sleep(0.5);
        const again = await probeJimengAgentSurface(page);
        if (again.referenceCount === expectedReferenceCount) {
          last = again;
          await page.sleep(asset.kind === 'image' ? 0.8 : 1.2);
          return;
        }
      }
      throw phaseError(
        'upload',
        `Jimeng created ${last.referenceCount} reference cards while waiting for ${asset.label}; expected ${expectedReferenceCount}`,
        'No generation was submitted. Clear the visible reference strip and retry.',
        failedAssetIndex,
      );
    }
    await page.sleep(0.25);
  }

  throw phaseError(
    'upload',
    `Jimeng did not create a reference card for ${asset.label} (${asset.filename}) within ${Math.round(timeoutMs / 1000)} seconds`,
    'No generation was submitted. The upload was not acknowledged; verify the visible reference strip and file type.',
    failedAssetIndex,
  );
}

async function fillPromptWithRichMentions(page, agentPrompt, assets, mentionDebug) {
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

  // Line structure is re-checked by the mandatory preparation checkpoint.
}

async function clearComposer(page, phase = 'clear-initial') {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.nativeKeyPress('Escape');
    await page.sleep(0.12);
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
 * Insert one rich @mention chip.
 *
 * Flow (as specified):
 *   1. type '@' → wait 0.5s → check picker visible
 *      - invisible: Backspace '@', re-type '@' (max 3). Fail hard if still invisible.
 *   2. type label (e.g. 图片1) → wait → check picker still visible
 *      - invisible: rewind (label.length + 1) and full-retry from step 1 (max 3)
 *   3. picker still visible → Enter on unique candidate → verify chip committed
 *      - fail: rewind (label.length + 1) and full-retry (max 3)
 *
 * Between '@' and Enter we never click the editor (would steal focus / close picker).
 * Visibility checks are pure evaluate and do not move focus.
 */
async function insertRichMention(page, asset, expectedMentionCount, mentionDebug) {
  const maxAtAttempts = mentionDebug.enabled ? 1 : 3;
  const maxFullAttempts = mentionDebug.enabled ? 1 : 3;
  const label = asset.label;

  for (let fullAttempt = 0; fullAttempt < maxFullAttempts; fullAttempt += 1) {
    const before = await getMentionState(page, asset);

    // Prepare a clean caret only at the start of a full attempt.
    await pressKeyWithGap(page, 'Escape', 0.12);
    await ensurePromptEditorCaret(page);
    await page.sleep(MENTION_KEY_GAP_S);

    await captureMentionDebug(page, mentionDebug, 'before-at', asset, {
      fullAttempt: fullAttempt + 1,
      expectedMentionCount,
      before,
    });

    // ---------- Phase 1: type '@', require picker ----------
    let atOpened = false;
    for (let atAttempt = 0; atAttempt < maxAtAttempts; atAttempt += 1) {
      await typeMentionQuery(page, '@');
      await page.sleep(0.5);
      await captureMentionDebug(page, mentionDebug, 'after-at', asset, {
        fullAttempt: fullAttempt + 1,
        atAttempt: atAttempt + 1,
      });

      if (await isMentionPickerVisible(page)) {
        atOpened = true;
        break;
      }

      // '@' did not open picker → remove this '@' and re-try '@'.
      // Prefer single Backspace; fall back to caret restore if focus was lost.
      await pressKeyWithGap(page, 'Backspace');
      const caretOk = await isCaretInPromptEditor(page).catch(() => false);
      if (!caretOk) {
        await ensurePromptEditorCaret(page);
        await page.sleep(MENTION_KEY_GAP_S);
      }
    }

    if (!atOpened) {
      // Hard fail: '@' never opened a real mention picker.
      await stripTrailingBareAt(page);
      throw phaseError(
        'mention',
        `Rich @ mention picker did not open after ${maxAtAttempts} '@' attempt${maxAtAttempts === 1 ? '' : 's'} for ${label} (${asset.filename})`,
        `Ensure Jimeng is focused and reference assets are uploaded before typing '@${label}'.`,
      );
    }

    // ---------- Phase 2: type label, require picker still visible ----------
    // Do NOT click/refocus the editor here — that can close the picker.
    await page.sleep(MENTION_KEY_GAP_S);
    await typeMentionQuery(page, label);
    await page.sleep(0.55);
    await captureMentionDebug(page, mentionDebug, 'after-label', asset, {
      fullAttempt: fullAttempt + 1,
      expectedMentionCount,
    });

    if (!(await isMentionPickerVisible(page))) {
      // Label typing lost the picker → rewind (label chars + '@') and full-retry.
      await rewindMentionKeystrokes(page, label, 'label');
      continue;
    }

    // ---------- Phase 3: unique candidate + Enter ----------
    await page.sleep(MENTION_KEY_GAP_S);
    const marker = nextMarker(`mention-${label}`);
    const candidate = await waitForMarker(
      page,
      marker,
      buildMentionCandidateExpression(asset, marker),
      3_000,
    );

    let committed = false;
    if (candidate.ok) {
      const candidateTarget = await inspectMentionCandidateTarget(page, marker, asset);
      await captureMentionDebug(page, mentionDebug, 'before-enter', asset, {
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

      // Unique visible candidate is enough. Do not re-click the editor before Enter.
      if (candidateTarget?.ok || candidateTarget?.reason === 'candidate-center-obscured') {
        try {
          await page.sleep(MENTION_KEY_GAP_S);
          const enterGuard = await selectMentionCandidateWithGuardedEnter(page, marker, asset);
          await page.sleep(0.4);
          if (enterGuard?.status === 'allowed') {
            await pressKeyWithGap(page, 'Escape', 0.12);
          }
          const after = await getMentionState(page, asset);
          await captureMentionDebug(page, mentionDebug, 'after-enter', asset, {
            fullAttempt: fullAttempt + 1,
            expectedMentionCount,
            candidate,
            candidateTarget,
            enterGuard,
            before,
            after,
          });
          if (mentionDebug.enabled && mentionDebug.stopPhase === 'after-click') {
            throw phaseError(
              'mention',
              `Mention debug checkpoint reached after selecting ${label}; inspect ${mentionDebug.directory}`,
              'No generation was submitted.',
            );
          }
          // Success:
          //  - chip count for this asset increased, OR
          //  - Enter allowed and raw @label gone (repeat mention may not add a 2nd chip)
          if (
            after.matchingMentionCount > before.matchingMentionCount
            || (enterGuard?.status === 'allowed' && !after.hasRaw)
          ) {
            committed = true;
          }
        } catch (err) {
          if (mentionDebug.enabled && mentionDebug.stopPhase === 'after-click') throw err;
          await captureMentionDebug(page, mentionDebug, 'enter-failed', asset, {
            fullAttempt: fullAttempt + 1,
            error: err?.message || String(err),
          });
        }
      }
    }

    // Double-check: chip may have landed even if Enter status was noisy.
    if (!committed) {
      const check = await getMentionState(page, asset);
      if (check.matchingMentionCount > before.matchingMentionCount) {
        committed = true;
      } else if (!check.hasRaw && before.hasRaw === false && check.matchingMentionCount >= 1) {
        // Repeat mention of same asset: raw token gone, at least one chip present.
        // (before.hasRaw is typically false at the start of an attempt.)
      }
      // Repeat-mention case: Enter consumed @label without adding a second chip node.
      if (!committed && !check.hasRaw) {
        const stillHasRawQuery = await page.evaluate(`(() => {
          ${buildPromptEditorLocatorScript()}
          const editor = findPromptEditor();
          if (!editor) return false;
          const text = (editor.innerText || editor.textContent || '').replace(/\\u00a0/g, ' ');
          return text.includes(${JSON.stringify(`@${label}`)});
        })()`);
        if (!stillHasRawQuery && check.matchingMentionCount >= 1) {
          // Only accept if we no longer have the raw token and had a successful Enter path
          // or the picker closed after our attempt (best-effort for duplicate labels).
          committed = true;
        }
      }
    }

    if (committed) {
      // Jimeng sometimes leaves a bare '@' glyph next to the chip.
      await stripTrailingBareAt(page);
      await page.sleep(0.3);
      // Safe to re-focus only AFTER the chip is committed.
      await ensurePromptEditorCaret(page);
      return;
    }

    // Enter/commit failed → rewind (label + '@') and full-retry.
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

/**
 * Remove orphan bare '@' text left beside a committed mention chip.
 * Jimeng sometimes converts only the label into a chip and leaves the '@' glyph.
 * Prefer DOM text-node surgery (select the orphan @ then Backspace) over end-of-editor backspaces.
 */
async function stripTrailingBareAt(page) {
  await page.nativeKeyPress('Escape');
  await page.sleep(0.08);

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
  try {
    await ensurePromptEditorCaret(page);
  } catch {
    await placeCaretAtPromptEditorEnd(page).catch(() => null);
  }
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

async function selectMentionCandidateWithGuardedEnter(page, marker, asset) {
  const guardKey = `__opencliJimengMentionEnterGuard_${marker}`;
  const initial = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const guardKey = ${JSON.stringify(guardKey)};
    const marker = ${JSON.stringify(marker)};
    const label = ${JSON.stringify(asset.label)};
    const prior = window[guardKey];
    prior?.abortController?.abort();

    const abortController = new AbortController();
    const compact = (value) => String(value || '').replace(/[\\u00a0\\u200b\\s]+/g, '');
    const inspect = () => {
      const editor = findPromptEditor();
      const candidate = document.querySelector(
        '[' + ${JSON.stringify(TARGET_ATTR)} + '="' + CSS.escape(marker) + '"]',
      );
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const rect = candidate?.getBoundingClientRect();
      const hit = rect && rect.width > 0 && rect.height > 0
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      const candidateVisible = !!candidate && !!rect
        && rect.width > 0
        && rect.height > 0
        && getComputedStyle(candidate).visibility !== 'hidden'
        && getComputedStyle(candidate).display !== 'none';
      // Enter selection does not need a clear mouse hit on the candidate center.
      // Require a unique visible matching candidate + caret still in the editor.
      const candidateHit = !!candidate && !!hit && (hit === candidate || candidate.contains(hit));
      const candidateMatches = !!candidate && [candidate, ...candidate.querySelectorAll('*')]
        .some((node) => {
          const text = compact(node.innerText || node.textContent);
          return text === compact(label) || text.includes(compact(label));
        });
      const selectionInEditor = !!editor
        && !!selection
        && selection.rangeCount >= 1
        && editor.contains(selection.anchorNode)
        && editor.contains(selection.focusNode);
      const suggestionMatches = !!editor && (
        [...editor.querySelectorAll('.suggestion, [class*="suggestion"]')]
          .some((node) => compact(node.innerText || node.textContent).includes(compact(label)))
        // Raw trailing @label is also a valid pre-commit state.
        || compact(editor.innerText || editor.textContent || '').includes(compact('@' + label))
      );
      const activeInEditor = !!editor
        && (document.activeElement === editor || editor.contains(document.activeElement));
      // Unique visible candidate + editor ownership is enough for Enter.
      // Do not require activeElement/suggestion extras — CJK insertText can
      // briefly blur the editor while the picker is still valid.
      return {
        safe: candidateVisible
          && candidateMatches
          && (selectionInEditor || activeInEditor || suggestionMatches),
        candidateVisible,
        candidateHit,
        candidateMatches,
        selectionInEditor,
        suggestionMatches,
        activeInEditor,
        selectionText: range ? String(range.toString()) : '',
      };
    };
    const state = {
      status: 'armed',
      initial: inspect(),
      keydown: null,
    };
    const block = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const keydown = inspect();
      state.keydown = keydown;
      if (!keydown.safe) {
        state.status = 'blocked';
        block(event);
        return;
      }
      state.status = 'allowed';
    }, { capture: true, signal: abortController.signal });
    window.addEventListener('keyup', (event) => {
      if (event.key !== 'Enter') return;
      if (state.status !== 'allowed') block(event);
    }, { capture: true, signal: abortController.signal });
    window[guardKey] = { abortController, state };
    return state.initial;
  })()`);

  if (!initial.safe) {
    // Soft failure: let the attempt loop restore to pre-@ and retry.
    // Hard-throwing here previously left a dangling '@' in the composer.
    await page.evaluate(`(() => {
      const guard = window[${JSON.stringify(guardKey)}];
      guard?.abortController?.abort();
      delete window[${JSON.stringify(guardKey)}];
    })()`).catch(() => null);
    return { status: 'not-armed', initial };
  }

  await dispatchEnterKey(page);
  // The browser bridge can acknowledge the CDP command before a busy Jimeng
  // renderer has delivered the DOM keydown. Keep the capture guard armed
  // until the event loop has had time to process both key events.
  await page.sleep(0.15);
  const outcome = await page.evaluate(`(() => {
    const guard = window[${JSON.stringify(guardKey)}];
    if (!guard) return { status: 'missing', keydown: null };
    guard.abortController.abort();
    delete window[${JSON.stringify(guardKey)}];
    return {
      status: guard.state.status,
      keydown: guard.state.keydown,
    };
  })()`);
  if (outcome.status !== 'allowed' || outcome.keydown?.safe !== true) {
    // Soft failure for the attempt loop (restore pre-@ + retry).
    return {
      status: outcome.status || 'blocked',
      keydown: outcome.keydown,
      safe: false,
    };
  }
  return outcome;
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
  await clickPromptEditorEnd(page);
  await focusPromptEditorEnd(page);
  // Shift modifier bit = 8. Do not use bare nativeKeyPress('Enter'): current
  // Chrome drops incomplete Enter descriptors (no code / no text).
  await dispatchEnterKey(page, 8);
  await page.sleep(0.25);
}

function buildMentionCandidateExpression(asset, marker) {
  return `(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').toLocaleLowerCase();
    const variants = ${JSON.stringify([asset.label, asset.filename, asset.mentionName])}.map(compact).filter(Boolean);
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
    const matches = named.filter(({ name }) => variants.some((variant) => name.includes(variant)));
    if (matches.length !== 1) {
      return {
        ok: false,
        count: matches.length,
        options: named.map(({ name }) => name).filter(Boolean).slice(0, 8),
      };
    }
    matches[0].option.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    const rect = matches[0].option.getBoundingClientRect();
    return {
      ok: true,
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
    if (!variants.some((variant) => name.includes(variant))) {
      return { ok: false, reason: 'candidate-text-changed', name };
    }
    const rect = option.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    // Center-obscured is non-fatal for Enter-based selection; report it but
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
    if (!editor) return { hasRaw: false, matchingMentionCount: 0, menuVisible: false };
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
    const matchingMentionCount = mentionNodes.filter((node) => {
      const text = compact(read(node));
      return variants.some((variant) => text.includes(variant));
    }).length;
    const menuVisible = [...document.querySelectorAll(${JSON.stringify(MENTION_OPTION_SELECTOR)})]
      .filter(visible)
      .some((node) => {
        const text = compact(read(node));
        return variants.some((variant) => text.includes(variant));
      });
    return {
      hasRaw: tail.includes(compact('@' + ${JSON.stringify(asset.label)})),
      matchingMentionCount,
      menuVisible,
      mentionTotal: mentionNodes.length,
    };
  })()`);
}

/** @deprecated Prefer restoreComposerToBaseline(page, baselineTakenBeforeAt). */
async function rollbackFailedMention(page, label) {
  await page.nativeKeyPress('Escape');
  await page.sleep(0.1);
  await ensurePromptEditorCaret(page);
  const hasRaw = await page.evaluate(`(() => {
    ${buildPromptEditorLocatorScript()}
    const editor = findPromptEditor();
    if (!editor) return false;
    const text = (editor.innerText || editor.textContent || '').replace(/\\u00a0/g, ' ');
    return text.slice(-${Math.max(160, label.length * 8)}).includes(${JSON.stringify(`@${label}`)});
  })()`);
  if (!hasRaw) {
    // Strip a bare trailing @ if present.
    const bareAt = await page.evaluate(`(() => {
      ${buildPromptEditorLocatorScript()}
      const editor = findPromptEditor();
      if (!editor) return false;
      const text = (editor.innerText || editor.textContent || '').replace(/[\\u00a0\\u200b\\s]+$/g, '');
      return /@$/.test(text);
    })()`);
    if (bareAt) {
      await page.nativeKeyPress('Backspace');
      return true;
    }
    return false;
  }
  for (let i = 0; i < label.length + 1; i += 1) {
    await page.nativeKeyPress('Backspace');
  }
  await page.sleep(0.2);
  return true;
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
  snapshot.requireSubmitArmed = options.requireSubmitArmed === true;
  const expectations = buildCheckpointExpectations(agentPrompt, assets);
  const report = evaluateContentCheckpoint(snapshot, expectations);
  if (!report.ok) {
    throw phaseError(
      'checkpoint',
      `Content checkpoint failed: ${report.failures.join(', ')}`,
      'No generation was submitted. Inspect uploaded references and the composed prompt/mentions.',
    );
  }
  return report;
}

/** @deprecated Prefer runContentCheckpoint. */
export async function runPreparationCheckpoint(page, agentPrompt, assets, options = {}) {
  return runContentCheckpoint(page, agentPrompt, assets, options);
}

async function ensurePreferenceSnapshot(page) {
  let surface = await probeJimengAgentSurface(page);
  if (surface.autoPopupOpen) {
    return {
      autoEnabled: surface.autoEnabled === true,
      videoSelected: surface.videoSelected === true,
      preferencePanelReadable: true,
    };
  }

  const marker = nextMarker('preinput-pref');
  const marked = await markPreferenceControl(page, marker);
  if (!marked?.ok) {
    return {
      autoEnabled: false,
      videoSelected: false,
      preferencePanelReadable: false,
    };
  }
  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    surface = await probeJimengAgentSurface(page);
    if (surface.autoPopupOpen) {
      return {
        autoEnabled: surface.autoEnabled === true,
        videoSelected: surface.videoSelected === true,
        preferencePanelReadable: true,
      };
    }
    await page.sleep(0.15);
  }
  return {
    autoEnabled: false,
    videoSelected: false,
    preferencePanelReadable: false,
  };
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
      referenceCount: document.querySelectorAll('[data-reference-remove-button="true"]').length,
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

/**
 * Click the visible generate control only after a green checkpoint.
 * This is the sole path that may start a paid generation.
 */
export async function submitPreparedGeneration(page) {
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
      'button[class*="submit-button"], button[class*="submit"], button.lv-btn-primary.lv-btn-shape-circle',
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
    throw phaseError(
      'submit',
      'Could not locate an enabled Jimeng generate/submit control after checkpoint',
      'Checkpoint passed but formal submission is blocked until the generate button is visible and enabled.',
    );
  }

  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  await page.sleep(2);
  await page.nativeKeyPress('Escape').catch(() => null);
  await page.sleep(0.5);

  const stillReady = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    return [...document.querySelectorAll(
      'button[class*="submit-button"], button[class*="submit"], button.lv-btn-primary.lv-btn-shape-circle',
    )].some((el) => (
      visible(el)
      && !el.disabled
      && el.getAttribute('aria-disabled') !== 'true'
      && !String(el.className || '').includes('disabled')
    ));
  })()`);

  if (!stillReady) return { accepted: true, buttonStillEnabled: false };
  return { accepted: true, buttonStillEnabled: true };
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
    };
  }
  return {
    message: describeError(err),
    hint: 'Inspect the visible Jimeng workspace and retry.',
    phase: 'surface',
    failedAssetIndex: fallbackFailedAssetIndex,
  };
}

function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

function nextMarker(prefix) {
  return `jimeng-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

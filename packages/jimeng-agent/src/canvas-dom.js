/**
 * Visible-UI Jimeng Canvas Agent preparation, checkpoint, and optional submit.
 *
 * Flow:
 *   open canvas (new or existing projectId)
 *   -> wait for canvas surface & sidecar readiness
 *   -> pre-input controls check (canvas ready, sidecar open, editor ready)
 *   -> clear composer
 *   -> upload references through the composer model -> confirm ready chips
 *   -> insert agent prompt text with embedded assetId & directives
 *   -> content checkpoint (chips + prompt text anchors + send armed)
 *   -> optional formal submit (--submit 1) with correlated network/UI evidence
 */

import os from 'node:os';
import path from 'node:path';

import { CommandExecutionError } from '@jackwener/opencli/errors';

import {
  CANVAS_NEW,
  JIMENG_CANVAS_PATH,
  buildCanvasUrl,
  evaluateCanvasContentCheckpoint,
  evaluateCanvasPreInputControls,
  parseProjectIdFromHref,
} from './canvas-contract.js';

import {
  JIMENG_CANVAS_CAPTURE_PATTERN,
  classifyCanvasSubmitAck,
  isCanvasSendUrl,
} from './canvas-submit-ack.js';

import {
  observeCurrentUploadFailure,
} from './upload-state.js';

import { normalizeCaptureEntry } from './submit-ack.js';
import { updateCanvasProjectTitle } from './canvas-api.js';

export const CANVAS_EDITOR_SELECTOR = '[data-testid="prompt-composer"] .tiptap.ProseMirror[contenteditable="true"], .tiptap.ProseMirror[contenteditable="true"]';
export const CANVAS_SIDECAR_SELECTOR = '[data-testid="canvas-feature-sidecar"]';
export const CANVAS_LAUNCHER_SELECTOR = '[data-testid="canvas-sidecar-launcher"], [data-testid="assistant-sidecar-launcher-placeholder"]';
export const CANVAS_ADD_SELECTOR = '[data-testid="canvas-agent-composer-add"]';
export const CANVAS_SEND_SELECTOR = '[data-testid="canvas-agent-send"]';
export const CANVAS_STOP_SELECTOR = '[data-testid="canvas-agent-stop"]';
export const CANVAS_MENTION_SELECTOR = '[data-testid="canvas-agent-composer-mention"]';
export const CANVAS_CHIP_SELECTOR = '[data-testid*="composer-chip-"][data-composer-chip-id], [data-testid="composer-chip-agentAttachment"], [data-composer-chip-id]';

const TARGET_ATTR = 'data-opencli-jimeng-canvas-target';
const CANVAS_UPLOAD_MENU_SELECTOR = '[data-testid="canvas-agent-composer-upload"]';
const CANVAS_MENTION_PANEL_SELECTOR = '[data-testid="generation-mention-panel"]';
const CANVAS_MENTION_SUBMENU_SELECTOR = '[data-testid="generation-mention-submenu"]';
const CANVAS_SUBJECT_MENTION_MENU_SELECTOR = '[data-testid="agent-subject-mention-menu"]';
const CANVAS_SUBJECT_MENTION_PANEL_SELECTOR = '[data-testid="agent-subject-mention-panel"]';
const CANVAS_RICH_MENTION_SELECTOR = [
  '.node-reference-mention-tag',
  '[data-type*="reference"][data-type*="mention"]',
  '[data-node-type*="reference"][data-node-type*="mention"]',
  '[data-testid*="mention-tag"]',
].join(', ');
const CANVAS_INLINE_REFERENCE_SELECTOR = '[data-testid="composer-chip-agentAttachment"]';
const CANVAS_UPLOAD_INPUT_SELECTOR = 'input[type="file"]';
const CANVAS_UPLOAD_INPUT_BASELINE_ATTR = 'data-opencli-jimeng-canvas-upload-baseline';
const CANVAS_UPLOAD_INPUT_TARGET_ATTR = 'data-opencli-jimeng-canvas-upload-input';
const CANVAS_UPLOAD_BRIDGE_KEY = '__opencliJimengCanvasUploadBridge';
const UPLOAD_ALERT_BASELINE_ATTR = 'data-opencli-jimeng-canvas-alert-baseline';
const UPLOAD_ALERT_ID_ATTR = 'data-opencli-jimeng-canvas-alert-id';
const UPLOAD_ALERT_REGISTRY_KEY = '__opencliJimengCanvasAlertBaselineRegistry';

let markerCounter = 0;
// Composer-model insertion keeps the caret itself; the CDP fallback does not.
const COMPOSER_ATOMIC_INSERTION = 'insertSegments-atomic';
const COMPOSER_MODEL_INSERTION = 'insertSegments';
let lastPromptInsertionMethod = '';
function nextMarker(prefix) {
  markerCounter += 1;
  return `jimeng-canvas-${prefix}-${Date.now()}-${markerCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

export function canvasMentionTextMatchesVariant(name, variant) {
  const compact = (value) => String(value || '')
    .replace(/[\s\u00a0\u200b]/g, '')
    .toLocaleLowerCase();
  const haystack = compact(name);
  const needle = compact(variant);
  if (!haystack || !needle) return false;
  if (haystack === needle || haystack === `@${needle}`) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@?${escaped}(?!\\p{N})`, 'u').test(haystack);
}

export function buildCanvasMentionSegments(agentPrompt, assets) {
  if (typeof agentPrompt !== 'string') {
    throw new TypeError('agentPrompt must be a string');
  }
  if (!Array.isArray(assets)) {
    throw new TypeError('assets must be an array');
  }

  const byLabel = new Map(assets.map((asset) => [asset.label, asset]));
  const segments = [];
  const tokenPattern = /@(图片|视频|音频)([1-9]\d*)/g;
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(agentPrompt)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', value: agentPrompt.slice(cursor, match.index) });
    }
    const label = `${match[1]}${match[2]}`;
    const asset = byLabel.get(label);
    if (!asset) {
      throw new Error(`Prompt references '${label}' but no prepared upload matches it`);
    }
    segments.push({ type: 'mention', label, asset });
    cursor = tokenPattern.lastIndex;
  }
  if (cursor < agentPrompt.length) {
    segments.push({ type: 'text', value: agentPrompt.slice(cursor) });
  }
  return segments;
}

function buildCanvasLocatorScript() {
  return `
    const canvasVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const findCanvasPromptEditor = () => {
      const selectors = [
        ${JSON.stringify(CANVAS_EDITOR_SELECTOR)},
        '[data-testid="prompt-composer"] [contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"]',
      ];
      const seen = new Set();
      const editors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
        .filter((editor) => {
          if (seen.has(editor) || !canvasVisible(editor)) return false;
          seen.add(editor);
          return true;
        });
      if (editors.length === 0) return null;
      const score = (editor) => {
        let value = document.activeElement === editor ? 10 : 0;
        if (editor.closest('[data-testid="prompt-composer"]')) value += 200;
        if (editor.closest(${JSON.stringify(CANVAS_SIDECAR_SELECTOR)})) value += 120;
        if (editor.closest('aside, [role="complementary"], [role="dialog"]')) value += 60;
        if (editor.matches('.tiptap.ProseMirror')) value += 30;
        if (editor.getAttribute('role') === 'textbox') value += 20;
        const rect = editor.getBoundingClientRect();
        return value + Math.max(0, Math.min(10, rect.bottom / Math.max(1, window.innerHeight) * 10));
      };
      return editors
        .map((editor) => ({ editor, score: score(editor) }))
        .sort((a, b) => b.score - a.score)[0].editor;
    };

    const findCanvasCommonAncestor = (left, right) => {
      if (!left || !right) return null;
      const leftAncestors = new Set();
      for (let node = left; node; node = node.parentElement) leftAncestors.add(node);
      for (let node = right; node; node = node.parentElement) {
        if (leftAncestors.has(node)) return node;
      }
      return null;
    };

    const findCanvasComposerRoot = () => {
      const editor = findCanvasPromptEditor();
      if (!editor) return null;
      const sessionComposer = editor.closest('[data-testid="canvas-agent-session-composer"]');
      if (sessionComposer && canvasVisible(sessionComposer)) return sessionComposer;
      const actionRow = document.querySelector('[data-testid="canvas-agent-composer-action-row"]');
      const sharedRoot = findCanvasCommonAncestor(editor, actionRow);
      if (sharedRoot && canvasVisible(sharedRoot)) return sharedRoot;
      let fallback = editor.closest('[data-testid="prompt-composer"], form, [role="group"]')
        || editor.parentElement;
      let node = editor.parentElement;
      for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
        if (
          node.querySelector(${JSON.stringify(CANVAS_ADD_SELECTOR)})
          || node.querySelector(${JSON.stringify(CANVAS_SEND_SELECTOR)})
          || node.querySelector('[data-testid="canvas-agent-composer-action-row"]')
          || node.querySelector('button[type="submit"]')
        ) {
          return node;
        }
        if (!fallback && node.matches('form, [role="group"]')) fallback = node;
      }
      return fallback;
    };

    const findCanvasSidecar = () => {
      const primary = document.querySelector(${JSON.stringify(CANVAS_SIDECAR_SELECTOR)});
      if (primary && canvasVisible(primary)) return primary;
      const editor = findCanvasPromptEditor();
      if (editor) {
        const owner = editor.closest(
          '[data-testid*="sidecar"], [data-testid*="assistant"], aside, [role="complementary"], [role="dialog"]'
        );
        if (owner && canvasVisible(owner)) return owner;
      }
      const semantic = [...document.querySelectorAll(
        'aside, [role="complementary"], [role="dialog"]'
      )].filter((el) => {
        if (!canvasVisible(el)) return false;
        const label = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('data-testid'),
        ].filter(Boolean).join(' ');
        return /\\bAI\\b|assistant|agent|助手|智能体|对话/i.test(label);
      });
      return semantic.length === 1 ? semantic[0] : null;
    };

    const canvasButtonEnabled = (button) => (
      button instanceof HTMLElement
      && canvasVisible(button)
      && !(button.matches(':disabled') || ('disabled' in button && button.disabled))
      && button.getAttribute('aria-disabled') !== 'true'
      && button.getAttribute('data-disabled') !== 'true'
      && !button.classList.contains('disabled')
    );

    const findCanvasAddButton = () => {
      const root = findCanvasComposerRoot();
      if (!root) return null;
      const exact = [...document.querySelectorAll(${JSON.stringify(CANVAS_ADD_SELECTOR)})]
        .filter((button) => root.contains(button) && canvasVisible(button));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
      const candidates = [...root.querySelectorAll('button, [role="button"]')].filter((button) => {
        if (!canvasVisible(button)) return false;
        const label = [
          button.getAttribute('data-testid'),
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.innerText,
          button.textContent,
        ].filter(Boolean).join(' ').trim();
        return /^(\\+|添加|添加附件|上传|add|attach|upload)$/i.test(label)
          || /添加|附件|上传|attach|upload/i.test(label);
      });
      return candidates.length === 1 ? candidates[0] : null;
    };

    const findCanvasSendButton = (requireEnabled = false) => {
      const root = findCanvasComposerRoot();
      if (!root) return null;
      const exact = [...document.querySelectorAll(${JSON.stringify(CANVAS_SEND_SELECTOR)})]
        .filter((button) => (
          root.contains(button)
          && canvasVisible(button)
          && (!requireEnabled || canvasButtonEnabled(button))
        ));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;

      const buttons = [...root.querySelectorAll('button, [role="button"]')].filter(canvasVisible);
      const semantic = buttons.filter((button) => {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.innerText,
          button.textContent,
        ].filter(Boolean).join(' ').trim();
        return /发送|send|提交|submit/i.test(label)
          && (!requireEnabled || canvasButtonEnabled(button));
      });
      if (semantic.length === 1) return semantic[0];

      const submitButtons = buttons.filter((button) => (
        button.getAttribute('type') === 'submit'
        && (!requireEnabled || canvasButtonEnabled(button))
      ));
      return submitButtons.length === 1 ? submitButtons[0] : null;
    };
  `;
}

function buildCanvasModelLocatorScript() {
  return `
    ${buildCanvasLocatorScript()}
    const canvasModelScore = (model) => {
      if (!model || typeof model !== 'object') return 0;
      let score = 0;
      if (model.composerRef?.current) score += 20;
      if (typeof model.composerRef?.current?.clear === 'function') score += 10;
      if (typeof model.composerRef?.current?.insertSegments === 'function') score += 10;
      if (typeof model.admitFiles === 'function') score += 100;
      if (typeof model.attachmentUploads?.importFiles === 'function') score += 100;
      if (typeof model.attachmentUploads?.getSnapshot === 'function') score += 100;
      if (typeof model.handleAttachmentsAccepted === 'function') score += 100;
      return score;
    };
    const findCanvasModelOnNode = (node) => {
      if (!node) return null;
      const keys = Object.keys(node);
      let best = null;
      let bestScore = 0;
      const consider = (model) => {
        const score = canvasModelScore(model);
        if (score > bestScore) {
          best = model;
          bestScore = score;
        }
      };
      for (const key of keys) {
        if (key.startsWith('__reactProps')) {
          consider(node[key]?.model);
        }
      }
      for (const key of keys) {
        if (!key.startsWith('__reactFiber')) continue;
        let fiber = node[key];
        for (let depth = 0; fiber && depth < 120; depth += 1, fiber = fiber.return) {
          consider(fiber.memoizedProps?.model);
          consider(fiber.pendingProps?.model);
          consider(fiber.stateNode?.model);
          if (bestScore >= 400) return best;
        }
      }
      return best;
    };
    const findCanvasComposerModel = () => {
      const editor = findCanvasPromptEditor();
      const root = findCanvasComposerRoot();
      const anchors = [
        document.querySelector('[data-testid="canvas-agent-composer-action-row"]'),
        root,
        editor,
      ].filter(Boolean);
      let node = editor?.parentElement || null;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        anchors.push(node);
      }
      const seen = new Set();
      let best = null;
      let bestScore = 0;
      for (const anchor of anchors) {
        if (seen.has(anchor)) continue;
        seen.add(anchor);
        const model = findCanvasModelOnNode(anchor);
        const score = canvasModelScore(model);
        if (score > bestScore) {
          best = model;
          bestScore = score;
        }
        if (bestScore >= 400) return best;
      }
      return best;
    };
  `;
}

function phaseError(phase, message, hint = 'Inspect the visible Jimeng canvas and retry.', failedAssetIndex) {
  const err = new Error(message);
  err.phase = phase;
  err.hint = hint;
  if (Number.isInteger(failedAssetIndex)) err.failedAssetIndex = failedAssetIndex;
  return err;
}

function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

export function assertCanvasPageCapabilities(page) {
  const missing = ['goto', 'evaluate', 'click', 'sleep', 'nativeKeyPress']
    .filter((name) => typeof page?.[name] !== 'function');
  if (typeof page?.nativeType !== 'function' && typeof page?.insertText !== 'function') {
    missing.push('nativeType|insertText');
  }
  if (missing.length > 0) {
    throw new CommandExecutionError(
      `JIMENG_BROWSER_UNSUPPORTED: missing page capability ${missing.join(', ')}`,
      'Use the OpenCLI Browser Bridge extension with canvas support.',
    );
  }
}

export function chooseCanvasRetryPlan({
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
    && surface?.editorReady === true
  ) {
    return { kind: 'resume', startAssetIndex: failedAssetIndex };
  }
  return { kind: 'fresh', startAssetIndex: 0 };
}

export async function probeJimengCanvasSurface(page) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const sidecar = findCanvasSidecar();
    const sidecarOpen = !!sidecar
      && sidecar.getAttribute('aria-hidden') !== 'true'
      && canvasVisible(sidecar);
    const launcher = document.querySelector(${JSON.stringify(CANVAS_LAUNCHER_SELECTOR)});
    const launcherVisible = !!launcher && canvasVisible(launcher);
    const editor = findCanvasPromptEditor();
    const editorReady = !!editor && canvasVisible(editor);
    const addBtn = findCanvasAddButton();
    const addControlReady = !!addBtn && canvasButtonEnabled(addBtn);
    const sendBtn = findCanvasSendButton(false);
    const sendVisible = !!sendBtn && canvasVisible(sendBtn);
    const sendDisabled = sendBtn ? (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') : true;
    const composerRoot = findCanvasComposerRoot();
    const chips = composerRoot
      ? [...composerRoot.querySelectorAll(${JSON.stringify(CANVAS_CHIP_SELECTOR)})]
      : [];
    const preparingElement = document.querySelector('[data-testid="workspace-preparing-state"]');
    const preparing = !!preparingElement && canvasVisible(preparingElement);
    const shell = document.querySelector(
      '[data-testid="canvas-workbench-shell"], [data-testid="workspace-workbench-shell"], main[aria-label="Canvas workspace"]'
    );
    const flow = document.querySelector('[data-testid="rf__wrapper"]');
    const flowReady = !!flow
      && flow.getAttribute('data-initial-content-ready') === 'true'
      && canvasVisible(flow);
    const realLauncher = document.querySelector('[data-testid="canvas-sidecar-launcher"]');
    const realLauncherReady = !!realLauncher && canvasVisible(realLauncher);
    // Jimeng can leave the preparing overlay mounted forever in automation
    // tabs even though the hydrated flow and real Agent launcher are ready.
    // The placeholder launcher is intentionally excluded from this override.
    const hydratedReady = flowReady && (realLauncherReady || editorReady || sidecarOpen);
    const canvasReady = hydratedReady || (!preparing && (!!shell || editorReady || launcherVisible));

    const chipData = chips.map((c) => {
      const status = c.getAttribute('data-chip-status') || c.querySelector('[data-chip-status]')?.getAttribute('data-chip-status') || 'ready';
      const label = (c.innerText || c.textContent || '').replace(/\\s+/g, ' ').trim();
      return { status, label };
    });

    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast-"], [class^="toast"], [class*="Toast"]')]
      .filter(canvasVisible)
      .map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(),
        baselineId: el.getAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)}) || '',
      }))
      .filter((entry) => entry.text);

    return {
      href: location.href,
      canvasReady,
      preparing,
      flowReady,
      hydratedReady,
      sidecarOpen,
      launcherVisible,
      editorReady,
      addControlReady,
      sendVisible,
      sendDisabled,
      chipCount: chips.length,
      chipData,
      alerts,
      ready: canvasReady && (sidecarOpen || launcherVisible),
    };
  })()`);
}

export async function openCanvasWorkspace(page, targetUrl) {
  await page.goto(targetUrl);
}

export async function materializeNewCanvasProject(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    last = await page.evaluate(`(async () => {
      const rootElement = document.getElementById('root');
      const containerKey = rootElement
        ? Object.keys(rootElement).find((key) => key.startsWith('__reactContainer'))
        : '';
      let rootFiber = containerKey ? rootElement[containerKey] : null;
      if (rootFiber?.stateNode?.current) rootFiber = rootFiber.stateNode.current;
      if (!rootFiber) return { ok: false, reason: 'react-root-not-ready' };

      const candidates = [];
      const candidateSet = new Set();
      const addCandidate = (value) => {
        const possible = [
          value,
          Array.isArray(value) ? value[0] : null,
          value && typeof value === 'object' ? value.current : null,
        ];
        for (const candidate of possible) {
          if (!candidate || typeof candidate !== 'object' || candidateSet.has(candidate)) continue;
          const input = candidate.input;
          let score = 0;
          if (typeof candidate.materialize === 'function') score += 200;
          if (typeof candidate.ensureProject === 'function') score += 100;
          if (input && typeof input === 'object') score += 20;
          if (typeof input?.projectId === 'string' && input.projectId.trim()) score += 80;
          if (typeof input?.createProject === 'function') score += 80;
          if (typeof input?.replaceWorkspaceUrl === 'function') score += 40;
          if (typeof input?.getEditor === 'function') score += 20;
          if (score < 500) continue;
          candidateSet.add(candidate);
          candidates.push({ candidate, score });
        }
      };

      const fibers = [rootFiber];
      const visitedFibers = new Set();
      let visitedCount = 0;
      while (fibers.length > 0 && visitedCount < 100000) {
        const fiber = fibers.pop();
        if (!fiber || visitedFibers.has(fiber)) continue;
        visitedFibers.add(fiber);
        visitedCount += 1;

        let hook = fiber.memoizedState;
        const visitedHooks = new Set();
        let hookCount = 0;
        while (
          hook
          && typeof hook === 'object'
          && !visitedHooks.has(hook)
          && hookCount < 100
        ) {
          visitedHooks.add(hook);
          addCandidate(hook.memoizedState);
          hook = hook.next;
          hookCount += 1;
        }
        if (fiber.sibling) fibers.push(fiber.sibling);
        if (fiber.child) fibers.push(fiber.child);
      }

      if (candidates.length === 0) {
        return {
          ok: false,
          reason: 'materializer-not-ready',
          visitedFibers: visitedCount,
        };
      }
      candidates.sort((left, right) => right.score - left.score);
      const bestScore = candidates[0].score;
      const best = candidates.filter((entry) => entry.score === bestScore);
      if (best.length !== 1) {
        return {
          ok: false,
          reason: 'materializer-ambiguous',
          candidateCount: best.length,
          bestScore,
        };
      }

      const materializer = best[0].candidate;
      const projectId = String(materializer.input.projectId || '').trim();
      if (materializer.projectMaterialized === true) {
        return {
          ok: true,
          projectId,
          projectCreated: materializer.projectCreated === true,
          projectExposed: materializer.projectExposed === true,
          projectMaterialized: true,
          alreadyMaterialized: true,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        await materializer.materialize(controller.signal);
      } catch (error) {
        return {
          ok: false,
          reason: 'materialize-failed',
          projectId,
          projectCreated: materializer.projectCreated === true,
          projectExposed: materializer.projectExposed === true,
          projectMaterialized: materializer.projectMaterialized === true,
          errorName: error instanceof Error ? error.name : '',
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
      return {
        ok: materializer.projectMaterialized === true,
        reason: materializer.projectMaterialized === true ? '' : 'materialize-incomplete',
        projectId,
        projectCreated: materializer.projectCreated === true,
        projectExposed: materializer.projectExposed === true,
        projectMaterialized: materializer.projectMaterialized === true,
      };
    })()`).catch((error) => ({
      ok: false,
      reason: 'materializer-evaluate-failed',
      error: describeError(error),
    }));

    if (last?.ok && last.projectId) return last;
    if (
      last?.reason === 'materialize-failed'
      || last?.reason === 'materialize-incomplete'
      || last?.reason === 'materializer-ambiguous'
      || last?.reason === 'materializer-evaluate-failed'
    ) {
      break;
    }
    await page.sleep(0.25);
  }

  const error = phaseError(
    'materialize',
    `Could not materialize a new Jimeng canvas project (${last?.reason || 'timeout'}${last?.error ? `: ${last.error}` : ''})`,
    'The blank canvas may have been created partially. Inspect the visible canvas before retrying.',
  );
  error.retryable = false;
  error.nonRetryable = true;
  throw error;
}

export async function waitForCanvasSurface(page, timeoutMs = 30_000) {
  let deadline = Date.now() + timeoutMs;
  let last = null;
  let recoveredStaleTab = false;
  while (Date.now() < deadline) {
    last = await probeJimengCanvasSurface(page).catch(() => null);
    if (last?.ready) return last;
    if (
      !recoveredStaleTab
      && last?.preparing === true
      && parseProjectIdFromHref(last?.href)
      && typeof page?.newTab === 'function'
      && typeof page?.setActivePage === 'function'
      && Date.now() >= deadline - timeoutMs + Math.min(5_000, timeoutMs / 3)
    ) {
      recoveredStaleTab = true;
      const oldPage = typeof page.getActivePage === 'function'
        ? page.getActivePage()
        : null;
      const newPage = await page.newTab(last.href).catch(() => null);
      if (newPage) {
        page.setActivePage(newPage);
        if (
          oldPage
          && oldPage !== newPage
          && typeof page.closeTab === 'function'
        ) {
          await page.closeTab(oldPage).catch(() => undefined);
        }
        deadline = Math.max(deadline, Date.now() + 15_000);
      }
    }
    await page.sleep(0.4);
  }
  throw phaseError(
    'surface',
    `Jimeng canvas did not become ready (preparing=${last?.preparing ?? 'unknown'}, ready=${last?.ready ?? false})`,
    'Open the Jimeng canvas URL in the automation tab, ensure network access, and retry.',
  );
}

export async function probeCanvasAgentBusy(page) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const sidecar = findCanvasSidecar();
    if (!sidecar) {
      return {
        busy: false,
        reason: 'sidecar-not-found',
        stopVisible: false,
      };
    }
    const exactStops = [...sidecar.querySelectorAll(${JSON.stringify(CANVAS_STOP_SELECTOR)})]
      .filter(canvasVisible);
    const semanticStops = [...sidecar.querySelectorAll('button, [role="button"]')]
      .filter(canvasVisible)
      .filter((button) => {
        const text = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.innerText,
          button.textContent,
        ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
        return /^(?:停止生成|停止|stop generating|stop)$/i.test(text);
      });
    // Historical messages can permanently retain text such as "正在生成".
    // Only a currently visible stop control is authoritative for turn activity.
    const stopVisible = exactStops.length > 0 || semanticStops.length > 0;
    return {
      busy: stopVisible,
      reason: exactStops.length > 0
        ? 'canvas-agent-stop'
        : (semanticStops.length > 0 ? 'semantic-stop' : 'idle'),
      stopVisible,
      exactStopCount: exactStops.length,
      semanticStopCount: semanticStops.length,
    };
  })()`);
}

export async function waitForCanvasSubmitReady(page, timeoutMs = 10 * 60_000) {
  const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : 10 * 60_000;
  const deadline = Date.now() + normalizedTimeoutMs;
  let last = null;
  let consecutiveIdle = 0;
  let lastFrameAt = 0;

  while (Date.now() < deadline) {
    last = await probeCanvasAgentBusy(page).catch((error) => ({
      busy: true,
      reason: `busy-probe-failed:${describeError(error)}`,
    }));
    if (last?.busy === false) {
      consecutiveIdle += 1;
      if (consecutiveIdle >= 3) return last;
    } else {
      consecutiveIdle = 0;
    }

    const now = Date.now();
    if (now - lastFrameAt >= 5_000 && typeof page.screenshot === 'function') {
      lastFrameAt = now;
      await page.screenshot({
        path: path.join(os.tmpdir(), `jimeng-canvas-busy-poll-${process.pid}.png`),
      }).catch(() => null);
    }
    await page.sleep(0.5);
  }

  const error = phaseError(
    'agent-busy',
    `Canvas Agent did not become idle within ${Math.round(normalizedTimeoutMs / 1000)} seconds (${last?.reason || 'unknown'})`,
    'No generation was submitted. Wait for the active Canvas Agent turn to finish, then retry.',
  );
  error.retryable = false;
  error.nonRetryable = true;
  throw error;
}

export async function waitForCanvasProjectId(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastHref = '';
  while (Date.now() < deadline) {
    lastHref = await page.evaluate(() => location.href).catch(() => '');
    const projectId = parseProjectIdFromHref(lastHref);
    if (projectId) return { projectId, href: lastHref };
    await page.sleep(0.25);
  }
  const error = phaseError(
    'project-title',
    `New Jimeng canvas did not resolve a project id (href=${lastHref || 'unknown'})`,
    'Wait for canvas creation to finish, then retry.',
  );
  error.retryable = false;
  error.nonRetryable = true;
  throw error;
}

export async function applyNewCanvasTitle(page, canonical, resolvedProjectId = '') {
  if (canonical.canvasMode !== 'new' || !canonical.title) return null;
  const resolved = resolvedProjectId
    ? { projectId: resolvedProjectId, href: '' }
    : await waitForCanvasProjectId(page);
  try {
    await updateCanvasProjectTitle(page, resolved.projectId, canonical.title);
  } catch (error) {
    const wrapped = phaseError(
      'project-title',
      `Could not name new canvas '${canonical.title}': ${describeError(error)}`,
      'The canvas was created but could not be named. Check access and retry explicitly.',
    );
    wrapped.retryable = false;
    wrapped.nonRetryable = true;
    throw wrapped;
  }
  return resolved;
}

export async function ensureCanvasSidecarOpen(page, timeoutMs = 15_000) {
  let surface = await probeJimengCanvasSurface(page);
  if (surface.sidecarOpen && surface.editorReady) return;

  const marker = nextMarker('launcher');
  const marked = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const launcher = document.querySelector(${JSON.stringify(CANVAS_LAUNCHER_SELECTOR)})
      || [...document.querySelectorAll('button, [role="button"]')].find((el) => {
        if (!canvasVisible(el)) return false;
        const label = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.innerText,
          el.textContent,
        ].filter(Boolean).join(' ');
        return /与\\s*AI\\s*对话|AI\\s*对话|AI\\s*助手|assistant|agent/i.test(label);
      });
    if (!launcher) return { ok: false };
    launcher.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);

  if (!marked?.ok) {
    throw phaseError(
      'surface',
      'Could not locate the "与 AI 对话" sidecar launcher button on the canvas',
      'Verify that the canvas page has loaded completely.',
    );
  }

  await page.click(`[${TARGET_ATTR}="${marker}"]`).catch(() => null);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    surface = await probeJimengCanvasSurface(page);
    if (surface.sidecarOpen && surface.editorReady) return;
    await page.sleep(0.3);
  }

  throw phaseError(
    'surface',
    'Jimeng canvas AI sidecar did not open after clicking launcher',
    'Click "与 AI 对话" in the visible canvas and retry.',
  );
}

export async function runCanvasPreInputControlsCheck(page, options = {}) {
  const surface = await probeJimengCanvasSurface(page);
  const snapshot = {
    canvasReady: surface.canvasReady,
    sidecarOpen: surface.sidecarOpen,
    editorReady: surface.editorReady,
    addControlReady: surface.addControlReady,
    requireAddControl: options.requireAddControl !== false,
  };
  const report = evaluateCanvasPreInputControls(snapshot);
  if (!report.ok) {
    throw phaseError(
      'pre-input',
      `Canvas pre-input check failed: ${report.failures.join(', ')}`,
      'Ensure the canvas and AI dialogue sidecar are fully open before uploading or composing.',
    );
  }
  return report;
}

export async function readCanvasComposerState(page) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const editor = findCanvasPromptEditor();
    if (!editor) return { empty: false, editorFound: false, textLength: 0, chips: 0 };
    const root = findCanvasComposerRoot() || editor;
    const text = (editor.innerText || editor.textContent || '').replace(/[\\u00a0\\u200b\\s]+/g, '');
    const chips = root.querySelectorAll(${JSON.stringify(CANVAS_CHIP_SELECTOR)}).length;
    return {
      empty: text.length === 0 && chips === 0,
      editorFound: true,
      textLength: text.length,
      chips,
    };
  })()`);
}

export async function clearCanvasComposer(page, phase = 'clear-initial') {
  await page.evaluate(`(() => {
    ${buildCanvasModelLocatorScript()}
    const model = findCanvasComposerModel();
    if (model?.composerRef?.current?.clear) {
      model.composerRef.current.clear();
    }
  })()`).catch(() => null);

  const cleared = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const editor = findCanvasPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    editor.focus();
    return { ok: true };
  })()`);
  if (!cleared.ok) {
    throw phaseError(phase, 'Prompt editor not found for clearing');
  }

  await page.nativeKeyPress('a', ['Ctrl']);
  await page.nativeKeyPress('Backspace');
  await page.sleep(0.3);

  let state = await readCanvasComposerState(page);

  if (!state.empty) {
    await page.nativeKeyPress('a', ['Ctrl']);
    await page.nativeKeyPress('Delete');
    await page.sleep(0.2);
    state = await readCanvasComposerState(page);
  }
  if (!state.empty) {
    throw phaseError(
      phase,
      `Canvas composer could not be cleared (editorFound=${state.editorFound}, textLength=${state.textLength}, chips=${state.chips})`,
      'Clear the visible canvas composer and attached references, then retry.',
    );
  }
}

async function markCanvasUploadAlertBaseline(page, marker) {
  return page.evaluate(`(() => {
    const registryKey = ${JSON.stringify(UPLOAD_ALERT_REGISTRY_KEY)};
    const registries = window[registryKey] || (window[registryKey] = Object.create(null));
    const registry = Object.create(null);
    registries[${JSON.stringify(marker)}] = registry;
    const alerts = [...document.querySelectorAll(
      '[role="alert"], [class*="toast-"], [class^="toast"], [class*="Toast"]'
    )];
    return alerts.map((el, index) => {
      const id = ${JSON.stringify(marker)} + '-' + index;
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      el.setAttribute(${JSON.stringify(UPLOAD_ALERT_BASELINE_ATTR)}, ${JSON.stringify(marker)});
      el.setAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)}, id);
      registry[id] = el;
      return { id, text };
    }).filter((a) => a.text);
  })()`);
}

async function clearCanvasUploadAlertBaseline(page, marker) {
  await page.evaluate(`(() => {
    const registryKey = ${JSON.stringify(UPLOAD_ALERT_REGISTRY_KEY)};
    const registries = window[registryKey];
    if (registries) delete registries[${JSON.stringify(marker)}];
    for (const el of document.querySelectorAll('[${UPLOAD_ALERT_BASELINE_ATTR}="${marker}"]')) {
      el.removeAttribute(${JSON.stringify(UPLOAD_ALERT_BASELINE_ATTR)});
      el.removeAttribute(${JSON.stringify(UPLOAD_ALERT_ID_ATTR)});
    }
  })()`).catch(() => null);
}

async function waitForCanvasUploadCompletion(page, asset, index, baselineChipCount, baselineAlerts = []) {
  const deadline = Date.now() + 60_000;
  let lastFailure = null;
  let activeBaselineAlertIds = baselineAlerts.map((alert) => alert.id);

  while (Date.now() < deadline) {
    const current = await probeJimengCanvasSurface(page);
    const failureObservation = observeCurrentUploadFailure({
      cards: [],
      alerts: current.alerts,
      baselineAlerts,
      activeBaselineAlertIds,
    });
    activeBaselineAlertIds = failureObservation.activeBaselineAlertIds;
    if (failureObservation.failureText) {
      const moderationRejected = /审核|未通过|不通过|违规|敏感|拒绝|content.*review|violat/i.test(
        failureObservation.failureText,
      );
      lastFailure = {
        reason: failureObservation.failureText,
        moderationRejected,
      };
      break;
    }

    // Canvas upload produces chips inside the composer
    if (current.chipCount > baselineChipCount) {
      // Check if the newest chip is ready (not uploading/processing)
      const allReady = current.chipData.every((c) => c.status !== 'uploading' && c.status !== 'processing');
      if (allReady) return;
    }

    await page.sleep(0.4);
  }

  if (lastFailure) {
    const err = phaseError(
      'upload',
      `Jimeng canvas upload failed for ${asset.label} (${asset.filename}): ${lastFailure.reason || 'rejection'}`,
      'Check asset content and retry with a conforming image/video/audio file.',
      index,
    );
    if (lastFailure.moderationRejected) {
      err.retryable = false;
      err.nonRetryable = true;
    }
    throw err;
  }

  throw phaseError(
    'upload',
    `Upload timed out for ${asset.label} (${asset.filename}) after 60s`,
    'Verify network connectivity and asset format, then retry.',
    index,
  );
}

export function getCanvasMimeType(filename, kind) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    heic: 'image/heic',
    heif: 'image/heif',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  return map[ext] || (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg');
}

async function installCanvasUploadBridge(page) {
  const result = await page.evaluate(`(() => {
    const key = ${JSON.stringify(CANVAS_UPLOAD_BRIDGE_KEY)};
    const bridge = window[key] || (window[key] = {
      fsaDisabled: false,
      pickerSuppressed: false,
    });
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        delete window.showOpenFilePicker;
        bridge.fsaDisabled = true;
      } catch (_) {
        // The capability check below fails closed if deletion was rejected.
      }
    }
    if (typeof window.showOpenFilePicker === 'function') {
      return { ok: false, reason: 'file-system-access-not-suppressed' };
    }
    const proto = HTMLInputElement.prototype;
    if (!proto.__opencliJimengCanvasFilePickerSuppressed) {
      const originalShowPicker = typeof proto.showPicker === 'function' ? proto.showPicker : null;
      const originalClick = proto.click;
      Object.defineProperty(proto, '__opencliJimengCanvasFilePickerSuppressed', {
        value: true,
        configurable: true,
      });
      proto.showPicker = function (...args) {
        if (this instanceof HTMLInputElement && String(this.type).toLowerCase() === 'file') {
          return undefined;
        }
        return originalShowPicker ? originalShowPicker.apply(this, args) : undefined;
      };
      proto.click = function (...args) {
        if (this instanceof HTMLInputElement && String(this.type).toLowerCase() === 'file') {
          return undefined;
        }
        return originalClick.apply(this, args);
      };
      bridge.pickerSuppressed = true;
    }
    return {
      ok: true,
      fsaDisabled: bridge.fsaDisabled,
      pickerSuppressed: bridge.pickerSuppressed,
    };
  })()`).catch((error) => ({ ok: false, reason: describeError(error) }));
  if (!result?.ok) {
    throw phaseError(
      'upload',
      `Jimeng canvas upload bridge could not suppress the native file chooser (${result?.reason || 'unknown'})`,
      'No generation was submitted. Verify the visible Canvas upload menu and retry.',
    );
  }
  return result;
}

async function markCanvasUploadInputBaseline(page, marker) {
  return page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(CANVAS_UPLOAD_INPUT_SELECTOR)})];
    for (const input of inputs) {
      input.setAttribute(
        ${JSON.stringify(CANVAS_UPLOAD_INPUT_BASELINE_ATTR)},
        ${JSON.stringify(marker)},
      );
    }
    return { count: inputs.length };
  })()`);
}

async function markCanvasAddControl(page, marker) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const button = findCanvasAddButton();
    if (!button) return { ok: false, reason: 'add-control-not-found' };
    if (!canvasButtonEnabled(button)) return { ok: false, reason: 'add-control-disabled' };
    button.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      selector: '[${TARGET_ATTR}="${marker}"]',
    };
  })()`);
}

async function markCanvasUploadMenuItem(page, marker) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const exact = [...document.querySelectorAll(${JSON.stringify(CANVAS_UPLOAD_MENU_SELECTOR)})]
      .filter(canvasVisible);
    let candidates = exact;
    if (candidates.length === 0) {
      candidates = [...document.querySelectorAll('[role="menuitem"]')]
        .filter((item) => {
          if (!canvasVisible(item)) return false;
          const label = [
            item.getAttribute('aria-label'),
            item.getAttribute('title'),
            item.innerText,
            item.textContent,
          ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
          return /^(上传|upload)$/i.test(label);
        });
    }
    if (candidates.length !== 1) {
      return {
        ok: false,
        reason: candidates.length === 0 ? 'upload-menu-item-not-found' : 'upload-menu-item-ambiguous',
        count: candidates.length,
      };
    }
    const item = candidates[0];
    item.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      selector: '[${TARGET_ATTR}="${marker}"]',
    };
  })()`);
}

async function markNewCanvasUploadInput(page, baselineMarker, inputMarker) {
  return page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(CANVAS_UPLOAD_INPUT_SELECTOR)})];
    const candidates = inputs.filter((input) => (
      input.getAttribute(${JSON.stringify(CANVAS_UPLOAD_INPUT_BASELINE_ATTR)})
        !== ${JSON.stringify(baselineMarker)}
    ));
    if (candidates.length !== 1) {
      return {
        ok: false,
        reason: candidates.length === 0 ? 'upload-input-missing' : 'upload-input-ambiguous',
        count: candidates.length,
      };
    }
    const input = candidates[0];
    input.setAttribute(
      ${JSON.stringify(CANVAS_UPLOAD_INPUT_TARGET_ATTR)},
      ${JSON.stringify(inputMarker)},
    );
    return {
      ok: true,
      selector: '[${CANVAS_UPLOAD_INPUT_TARGET_ATTR}="${inputMarker}"]',
    };
  })()`);
}

async function waitForNewCanvasUploadInput(
  page,
  baselineMarker,
  inputMarker,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await markNewCanvasUploadInput(page, baselineMarker, inputMarker);
    if (last?.ok) return last;
    if (last?.reason === 'upload-input-ambiguous') return last;
    await page.sleep(0.2);
  }
  return last || { ok: false, reason: 'upload-input-missing', count: 0 };
}

async function acquireCanvasUploadInput(page, index) {
  if (typeof page?.setFileInput !== 'function') {
    throw phaseError(
      'upload',
      'Canvas reference upload requires page.setFileInput',
      'Use the OpenCLI Browser Bridge extension with native file upload support.',
      index,
    );
  }

  const inputMarker = nextMarker(`upload-input-${index}`);
  const input = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const root = findCanvasComposerRoot();
    if (!root) return { ok: false, reason: 'composer-root-missing' };
    for (const stale of document.querySelectorAll(
      '[${CANVAS_UPLOAD_INPUT_TARGET_ATTR}="${inputMarker}"]',
    )) {
      stale.remove();
    }
    const element = document.createElement('input');
    element.type = 'file';
    element.tabIndex = -1;
    element.hidden = true;
    element.setAttribute(
      ${JSON.stringify(CANVAS_UPLOAD_INPUT_TARGET_ATTR)},
      ${JSON.stringify(inputMarker)},
    );
    root.appendChild(element);
    return {
      ok: true,
      selector: '[${CANVAS_UPLOAD_INPUT_TARGET_ATTR}="${inputMarker}"]',
    };
  })()`);
  return {
    ...input,
    inputMarker,
  };
}

async function importCanvasUploadInput(page, selector) {
  return page.evaluate(`(async () => {
    ${buildCanvasModelLocatorScript()}
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) {
      return { ok: false, reason: 'upload-input-missing' };
    }
    const file = input.files?.[0];
    if (!(file instanceof File)) {
      return { ok: false, reason: 'upload-input-empty' };
    }

    const model = findCanvasComposerModel();
    if (!model) return { ok: false, reason: 'canvas-model-missing' };
    if (
      typeof model.admitFiles !== 'function'
      || typeof model.attachmentUploads?.importFiles !== 'function'
      || typeof model.attachmentUploads?.getSnapshot !== 'function'
      || typeof model.handleAttachmentsAccepted !== 'function'
    ) {
      return { ok: false, reason: 'canvas-model-upload-api-missing' };
    }

    const admitted = model.admitFiles([file]);
    if (!admitted || admitted.length === 0) {
      return { ok: false, reason: 'asset-not-admitted' };
    }

    const uploadRes = await model.attachmentUploads.importFiles(admitted);
    const attachmentId = uploadRes.acceptedAttachmentIds?.[0];
    if (!attachmentId) {
      return {
        ok: false,
        reason: 'asset-upload-rejected',
        rejected: uploadRes.rejectedFiles,
      };
    }

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const item = model.attachmentUploads.getSnapshot().items
        .find((candidate) => candidate.attachmentId === attachmentId);
      if (item) {
        if (item.status === 'completed' && item.resource?.storageKey) {
          model.handleAttachmentsAccepted([item]);
          return {
            ok: true,
            attachmentId,
            storageKey: item.resource.storageKey,
            filename: file.name,
          };
        }
        if (item.status === 'failed') {
          return {
            ok: false,
            reason: 'asset-upload-failed',
            failure: item.failureReason,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ok: false, reason: 'asset-upload-timeout' };
  })()`);
}

async function clearCanvasUploadInputMarkers(page, inputMarker) {
  await page.evaluate(`(() => {
    for (const input of document.querySelectorAll(
      '[${CANVAS_UPLOAD_INPUT_TARGET_ATTR}="${inputMarker}"]',
    )) {
      input.remove();
    }
  })()`).catch(() => null);
}

export async function uploadCanvasReferenceAssets(page, assets, uploads, startAssetIndex = 0) {
  for (let index = startAssetIndex; index < assets.length; index += 1) {
    const asset = assets[index];
    const surfaceBefore = await probeJimengCanvasSurface(page);

    const alertBaselineMarker = nextMarker(`alerts-${index}`);
    const baselineAlerts = await markCanvasUploadAlertBaseline(page, alertBaselineMarker);
    let uploadResult = null;

    try {
      const uploadInput = await acquireCanvasUploadInput(page, index);
      if (!uploadInput?.ok) {
        throw phaseError(
          'upload',
          `Could not locate the Canvas Agent file input for ${asset.label} (${asset.filename}): ${uploadInput?.reason || 'unknown'}`,
          'No generation was submitted. Verify the Canvas Agent composer is open and retry.',
          index,
        );
      }
      try {
        try {
          await page.setFileInput([asset.browserPath], uploadInput.selector);
        } catch (err) {
          throw phaseError(
            'upload',
            `setFileInput failed for ${asset.label} (${asset.filename}): ${describeError(err)}`,
            'Verify the file is readable by the browser host and retry.',
            index,
          );
        }

        try {
          uploadResult = await importCanvasUploadInput(page, uploadInput.selector);
        } catch (err) {
          throw phaseError(
            'upload',
            `Canvas composer upload failed for ${asset.label} (${asset.filename}): ${describeError(err)}`,
            'Verify network connectivity and retry.',
            index,
          );
        }
        if (!uploadResult?.ok) {
          throw phaseError(
            'upload',
            `Upload failed for ${asset.label} (${asset.filename}): ${uploadResult?.reason || 'unknown'}`,
            'Verify the file format and network connectivity, then retry.',
            index,
          );
        }
      } finally {
        await clearCanvasUploadInputMarkers(page, uploadInput.inputMarker);
      }

      await waitForCanvasUploadCompletion(
        page,
        asset,
        index,
        surfaceBefore.chipCount,
        baselineAlerts,
      );
    } finally {
      await clearCanvasUploadAlertBaseline(page, alertBaselineMarker);
    }

    uploads[index] = {
      ...asset,
      attachmentId: uploadResult.attachmentId,
      storageKey: uploadResult.storageKey,
    };
    uploads.length = index + 1;
  }
}

async function placeCanvasPromptCaretAtEnd(page) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const editor = findCanvasPromptEditor();
    if (!editor) return { ok: false, reason: 'editor-not-found' };
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return { ok: false, reason: 'selection-unavailable' };
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true };
  })()`);
}

/**
 * The composer model and CDP insertion both land in the editor asynchronously.
 * Inserting a rich mention while the previous text is still in flight drops or
 * reorders that text, so every text segment must be observed in the editor
 * before the next mention is bound.
 */
async function waitForCanvasPromptText(page, text, timeoutMs = 6_000) {
  const expectedText = String(text || '').replace(/[\u00a0\u200b\s]+/g, '');
  if (!expectedText) return;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCanvasComposerText(page);
    if (last?.ok && last.text.endsWith(expectedText)) return;
    await page.sleep(0.12);
  }
  last = await readCanvasComposerText(page).catch(() => last);
  throw phaseError(
    'prompt',
    `Canvas prompt segment did not append to the composer (chars=${last?.text?.length ?? 'unknown'}, expectedTail=${JSON.stringify(expectedText.slice(-40))}, composerTail=${JSON.stringify(String(last?.text || '').slice(-80))}${last?.reason ? `, reason=${last.reason}` : ''})`,
    'No generation was submitted. The composer rejected the prompt text; retry the run.',
  );
}

/**
 * Composer model helpers. `focusEnd` is the editor's own "focus at end"
 * command, so appending never depends on where the last DOM caret landed.
 */
async function focusCanvasComposerEnd(page) {
  return page.evaluate(`(() => {
    ${buildCanvasModelLocatorScript()}
    const target = findCanvasComposerModel()?.composerRef?.current;
    if (typeof target?.focusEnd !== 'function') return { ok: false, reason: 'focus-end-unavailable' };
    target.focusEnd();
    return { ok: true };
  })()`).catch((error) => ({ ok: false, reason: describeError(error) }));
}

/**
 * Read the composer document (not the DOM) as whitespace-free text, with every
 * chip collapsed to `@chip`. The model document is what the canvas submits, so
 * it is immune to rendering artifacts that confuse DOM text matching.
 */
async function readCanvasComposerText(page) {
  return page.evaluate(`(() => {
    ${buildCanvasModelLocatorScript()}
    const target = findCanvasComposerModel()?.composerRef?.current;
    if (typeof target?.getDocument !== 'function') return { ok: false, reason: 'document-unavailable' };
    const parts = target.getDocument()?.parts || [];
    const text = parts.map((part) => (
      typeof part?.text === 'string' ? part.text : '@chip'
    )).join('');
    return { ok: true, text: text.replace(/[\\u00a0\\u200b\\s]+/g, '') };
  })()`).catch((error) => ({ ok: false, reason: describeError(error) }));
}

async function insertCanvasPromptText(page, text) {
  if (!text) return '';
  const focus = await focusCanvasComposerEnd(page);
  const inserted = focus?.ok
    ? await page.evaluate(`((promptText) => {
      ${buildCanvasModelLocatorScript()}
      const model = findCanvasComposerModel();
      if (model?.composerRef?.current?.insertSegments) {
        const accepted = model.composerRef.current.insertSegments([{ type: 'text', text: promptText }]);
        return { ok: accepted !== false, via: 'insertSegments' };
      }
      return { ok: false };
    })(${JSON.stringify(text)})`)
    : { ok: false, reason: focus?.reason };
  if (inserted?.ok) return COMPOSER_MODEL_INSERTION;

  const caret = await placeCanvasPromptCaretAtEnd(page);
  if (!caret?.ok) {
    throw phaseError(
      'prompt',
      `Could not place a caret in the canvas prompt editor (${caret?.reason || 'unknown'})`,
      'No generation was submitted. Reopen the AI dialog and retry.',
    );
  }
  if (typeof page.insertText === 'function') {
    await page.insertText(text);
    return 'insertText';
  }
  if (typeof page.nativeType === 'function') {
    await page.nativeType(text);
    return 'nativeType';
  }
  throw phaseError(
    'prompt',
    'No supported native text insertion method is available for the canvas prompt editor',
    'No generation was submitted. Update OpenCLI and retry.',
  );
}

export async function collectCanvasRichMentionState(page) {
  return page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const editor = findCanvasPromptEditor();
    const panel = document.querySelector(${JSON.stringify(CANVAS_MENTION_PANEL_SELECTOR)});
    const submenu = document.querySelector(${JSON.stringify(CANVAS_MENTION_SUBMENU_SELECTOR)});
    const subjectMenu = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_MENU_SELECTOR)});
    const subjectPanel = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_PANEL_SELECTOR)});
    if (!editor) {
      return {
        editorFound: false,
        count: 0,
        labels: [],
        menuVisible: canvasVisible(panel)
          || canvasVisible(submenu)
          || canvasVisible(subjectMenu)
          || canvasVisible(subjectPanel),
      };
    }
    const readNode = (node) => {
      const values = [
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        node.innerText,
        node.textContent,
      ];
      for (const child of node.querySelectorAll('[aria-label], [title], img[alt]')) {
        values.push(
          child.getAttribute('aria-label'),
          child.getAttribute('title'),
          child.getAttribute('alt'),
        );
      }
      const readable = values.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
      return readable.match(/(?:图片|视频|音频)\\d+/)?.[0] || readable;
    };
    const separator = [...editor.children].find((node) => (
      (node.innerText || node.textContent || '').replace(/[\\u00a0\\u200b\\s]+/g, '') === '---'
    ));
    const followsSeparator = (node) => !!separator
      && !!(separator.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    const inlineNodes = separator
      ? [...editor.querySelectorAll(${JSON.stringify(CANVAS_INLINE_REFERENCE_SELECTOR)})]
        .filter(canvasVisible)
        .filter(followsSeparator)
      : [];
    const hintedNodes = [...editor.querySelectorAll(${JSON.stringify(CANVAS_RICH_MENTION_SELECTOR)})]
      .filter(canvasVisible)
      .filter((node) => !separator || followsSeparator(node))
      .filter((node) => !inlineNodes.some((inline) => inline.contains(node) || node.contains(inline)));
    const nodes = [...new Set([...inlineNodes, ...hintedNodes])];
    return {
      editorFound: true,
      count: nodes.length,
      labels: nodes.map(readNode),
      menuVisible: canvasVisible(panel)
        || canvasVisible(submenu)
        || canvasVisible(subjectMenu)
        || canvasVisible(subjectPanel),
    };
  })()`);
}

async function openCanvasMentionPicker(page) {
  const marker = nextMarker('mention-button');
  const marked = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const root = findCanvasComposerRoot();
    if (!root) return { ok: false, reason: 'composer-root-not-found' };
    const exact = [...root.querySelectorAll(${JSON.stringify(CANVAS_MENTION_SELECTOR)})]
      .filter(canvasVisible)
      .filter(canvasButtonEnabled);
    if (exact.length !== 1) {
      return {
        ok: false,
        reason: exact.length === 0 ? 'mention-button-not-found' : 'mention-button-ambiguous',
        count: exact.length,
      };
    }
    exact[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) return marked;

  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  const deadline = Date.now() + 8_000;
  let visible = false;
  while (Date.now() < deadline) {
    visible = await page.evaluate(`(() => {
      ${buildCanvasLocatorScript()}
      const panel = document.querySelector(${JSON.stringify(CANVAS_MENTION_PANEL_SELECTOR)});
      const submenu = document.querySelector(${JSON.stringify(CANVAS_MENTION_SUBMENU_SELECTOR)});
      const subjectMenu = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_MENU_SELECTOR)});
      const subjectPanel = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_PANEL_SELECTOR)});
      return canvasVisible(panel)
        || canvasVisible(submenu)
        || canvasVisible(subjectMenu)
        || canvasVisible(subjectPanel);
    })()`).catch(() => false);
    if (visible) break;
    await page.sleep(0.15);
  }
  return visible
    ? { ok: true }
    : { ok: false, reason: 'mention-panel-not-open' };
}

function canvasMentionKindMeta(asset) {
  if (asset?.kind === 'image') return { token: 'image', label: '图片' };
  if (asset?.kind === 'video') return { token: 'video', label: '视频' };
  if (asset?.kind === 'audio') return { token: 'audio', label: '音频' };
  return null;
}

async function selectCanvasMentionCategory(page, asset) {
  const meta = canvasMentionKindMeta(asset);
  if (!meta) {
    return { ok: false, reason: `unsupported-mention-kind:${asset?.kind || 'unknown'}` };
  }
  const marker = nextMarker(`mention-category-${meta.token}`);
  const marked = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const subjectMenu = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_MENU_SELECTOR)});
    const subjectPanel = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_PANEL_SELECTOR)});
    if (canvasVisible(subjectMenu) || canvasVisible(subjectPanel)) {
      return { ok: true, via: 'direct-subject-menu' };
    }
    const panel = document.querySelector(${JSON.stringify(CANVAS_MENTION_PANEL_SELECTOR)});
    if (!canvasVisible(panel)) return { ok: false, reason: 'mention-panel-not-visible' };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').toLocaleLowerCase();
    const token = ${JSON.stringify(meta.token)};
    const label = compact(${JSON.stringify(meta.label)});
    const options = [...panel.querySelectorAll('[role="option"]')].filter(canvasVisible);
    const matches = options.filter((option) => {
      const id = decodeURIComponent(option.id || '').toLocaleLowerCase();
      const text = compact([
        option.getAttribute('aria-label'),
        option.getAttribute('title'),
        option.innerText,
        option.textContent,
      ].filter(Boolean).join(' '));
      return id.includes('category:' + token) || text === label;
    });
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: matches.length === 0 ? 'mention-category-not-found' : 'mention-category-ambiguous',
        count: matches.length,
        options: options.map((option) => ({
          id: option.id || '',
          text: compact(option.innerText || option.textContent || '').slice(0, 80),
        })),
      };
    }
    matches[0].setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) return marked;
  if (marked.via === 'direct-subject-menu') return marked;

  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`(() => {
      ${buildCanvasLocatorScript()}
      const submenu = document.querySelector(${JSON.stringify(CANVAS_MENTION_SUBMENU_SELECTOR)});
      return canvasVisible(submenu);
    })()`).catch(() => false);
    if (ready) return { ok: true };
    await page.sleep(0.15);
  }
  return { ok: false, reason: 'mention-submenu-not-open' };
}

function buildCanvasMentionCandidateExpression(asset, marker) {
  const variants = [asset?.label, asset?.filename, asset?.mentionName].filter(Boolean);
  return `(() => {
    ${buildCanvasLocatorScript()}
    const panel = document.querySelector(${JSON.stringify(CANVAS_MENTION_PANEL_SELECTOR)});
    const submenu = document.querySelector(${JSON.stringify(CANVAS_MENTION_SUBMENU_SELECTOR)});
    const subjectMenu = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_MENU_SELECTOR)});
    const subjectPanel = document.querySelector(${JSON.stringify(CANVAS_SUBJECT_MENTION_PANEL_SELECTOR)});
    const scopes = [panel, submenu, subjectMenu, subjectPanel].filter(canvasVisible);
    if (scopes.length === 0) return { ok: false, reason: 'mention-candidate-surface-not-visible' };
    const read = (option) => {
      const values = [
        option.getAttribute('aria-label'),
        option.getAttribute('title'),
        option.innerText,
        option.textContent,
      ];
      for (const child of option.querySelectorAll('[aria-label], [title], img[alt]')) {
        values.push(
          child.getAttribute('aria-label'),
          child.getAttribute('title'),
          child.getAttribute('alt'),
        );
      }
      return values.filter(Boolean).join(' ');
    };
    const decodeId = (value) => {
      const text = String(value || '');
      try { return decodeURIComponent(text); } catch { return text; }
    };
    const variants = ${JSON.stringify(variants)};
    const attachmentId = ${JSON.stringify(asset?.attachmentId || '')};
    const matchesVariant = ${canvasMentionTextMatchesVariant.toString()};
    const options = [...new Set(scopes.flatMap((scope) => [...scope.querySelectorAll('[role="option"]')]))]
      .filter(canvasVisible)
      .filter((option) => option.getAttribute('aria-disabled') !== 'true')
      .filter((option) => !decodeId(option.id || '').toLowerCase().includes('category:'));
    const named = options.map((option) => ({
      option,
      name: read(option),
      identity: [
        decodeId(option.id),
        option.getAttribute('data-attachment-id'),
        option.getAttribute('data-id'),
        option.getAttribute('data-value'),
      ].filter(Boolean).join(' '),
    }));
    const matches = attachmentId
      ? named.filter(({ identity }) => identity.includes(attachmentId))
      : named.filter(({ name }) => variants.some((variant) => matchesVariant(name, variant)));
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: attachmentId
          ? (matches.length === 0
            ? 'mention-attachment-candidate-not-found'
            : 'mention-attachment-candidate-ambiguous')
          : (matches.length === 0 ? 'mention-candidate-not-found' : 'mention-candidate-ambiguous'),
        attachmentId,
        count: matches.length,
        options: named.map(({ option, name, identity }) => ({
          id: option.id || '',
          identity,
          label: option.getAttribute('aria-label') || '',
          text: String(name || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        })).slice(0, 20),
      };
    }
    matches[0].option.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      text: String(matches[0].name || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`;
}

async function waitForCanvasMentionCandidate(page, asset, marker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastFrameAt = 0;
  while (Date.now() < deadline) {
    last = await page.evaluate(buildCanvasMentionCandidateExpression(asset, marker)).catch((error) => ({
      ok: false,
      reason: `candidate-evaluate-failed:${describeError(error)}`,
    }));
    if (last?.ok) return last;
    const now = Date.now();
    if (now - lastFrameAt >= 1_000 && typeof page.screenshot === 'function') {
      lastFrameAt = now;
      await page.screenshot({
        path: path.join(os.tmpdir(), `jimeng-canvas-mention-poll-${process.pid}.png`),
      }).catch(() => null);
    }
    await page.sleep(0.2);
  }
  return last || { ok: false, reason: 'mention-candidate-timeout' };
}

async function insertCanvasRichMention(page, asset, expectedCount) {
  const before = await collectCanvasRichMentionState(page);
  const opened = await openCanvasMentionPicker(page);
  if (!opened?.ok) {
    throw phaseError(
      'mention',
      `Canvas rich mention picker did not open for ${asset.label} (${opened?.reason || 'unknown'})`,
      'No generation was submitted. Ensure the visible @ control is available and retry.',
    );
  }

  const marker = nextMarker(`mention-candidate-${asset.label}`);
  let candidate = await waitForCanvasMentionCandidate(page, asset, marker, 4_000);
  if (!candidate?.ok) {
    const category = await selectCanvasMentionCategory(page, asset);
    if (!category?.ok) {
      throw phaseError(
        'mention',
        `Canvas mention category could not be selected for ${asset.label} (${category?.reason || 'unknown'}; ${JSON.stringify(category?.options || []).slice(0, 500)})`,
        'No generation was submitted. Inspect the visible @ category menu and retry.',
      );
    }
    candidate = await waitForCanvasMentionCandidate(page, asset, marker);
  }
  if (!candidate?.ok) {
    throw phaseError(
      'mention',
      `Canvas mention candidate was not uniquely available for ${asset.label} (${candidate?.reason || 'unknown'}; ${JSON.stringify(candidate?.options || []).slice(0, 700)})`,
      `No generation was submitted. Ensure '${asset.label}' is visible as exactly one @ candidate.`,
    );
  }

  await page.click(`[${TARGET_ATTR}="${marker}"]`);
  const deadline = Date.now() + 8_000;
  let last = before;
  let escaped = false;
  while (Date.now() < deadline) {
    last = await collectCanvasRichMentionState(page);
    const appended = last.count === expectedCount
      && last.count === before.count + 1
      && canvasMentionTextMatchesVariant(last.labels[last.labels.length - 1], asset.label);
    if (appended && !last.menuVisible) {
      const document = await readCanvasComposerText(page);
      if (document?.ok && document.text.endsWith('@chip')) return last;
    }
    if (appended && last.menuVisible && !escaped) {
      escaped = true;
      await page.nativeKeyPress('Escape').catch(() => null);
    }
    await page.sleep(0.2);
  }

  throw phaseError(
    'mention',
    `Canvas did not commit rich mention ${asset.label} after candidate selection (before=${JSON.stringify(before)}, after=${JSON.stringify(last)})`,
    'No generation was submitted. Inspect the visible prompt for an uncommitted @ token.',
  );
}

/**
 * Compose the canvas prompt, preferring the single composer transaction.
 *
 * The mention picker inserts chips through the canvas' own asynchronous state,
 * so interleaving it with model text insertions can reorder the prompt. One
 * `insertSegments` call carrying every text and chip segment cannot interleave;
 * the picker flow stays as the fallback when the composer model is unavailable.
 */
export async function composeCanvasPrompt(page, agentPrompt, assets = []) {
  const baseline = await readCanvasComposerText(page);
  const atomic = await composeCanvasPromptAtomic(page, agentPrompt, assets);
  if (atomic?.ok) {
    const expected = buildCanvasPromptDocumentSuffix(agentPrompt, assets);
    const after = await readCanvasComposerText(page);
    const composed = after?.ok === true
      && (after.text === `${baseline?.ok ? baseline.text : ''}${expected}`
        || after.text.endsWith(expected));
    if (composed) {
      lastPromptInsertionMethod = COMPOSER_ATOMIC_INSERTION;
      return COMPOSER_ATOMIC_INSERTION;
    }
    const untouched = baseline?.ok === true && after?.ok === true && after.text === baseline.text;
    if (!untouched) {
      throw phaseError(
        'prompt',
        `Canvas composed the prompt but the composer document did not match (expectedTail=${JSON.stringify(expected.slice(-60))}, composerTail=${JSON.stringify(String(after?.text || '').slice(-80))})`,
        'No generation was submitted. Reopen the AI dialog and retry.',
      );
    }
  }
  await fillCanvasPrompt(page, agentPrompt, assets);
  return lastPromptInsertionMethod;
}

/**
 * Expected composer text for the prompt, with every mention collapsed to the
 * `@chip` marker used by `readCanvasComposerText`.
 */
function buildCanvasPromptDocumentSuffix(agentPrompt, assets) {
  return buildCanvasMentionSegments(agentPrompt, assets)
    .map((segment) => (segment.type === 'text' ? segment.value : '@chip'))
    .join('')
    .replace(/[\u00a0\u200b\s]+/g, '');
}

/**
 * Compose the whole prompt in one composer transaction.
 *
 * Mention chips are ordinary `agentAttachment` chips whose descriptors already
 * exist for the uploaded attachments, so the atomic insertion never races the
 * canvas mention picker and cannot interleave text with chips.
 */
export async function composeCanvasPromptAtomic(page, agentPrompt, assets) {
  const segments = buildCanvasMentionSegments(agentPrompt, assets);
  const payload = segments.map((segment) => (
    segment.type === 'text'
      ? { type: 'text', text: segment.value }
      : { type: 'mention', attachmentId: segment.asset.attachmentId, label: segment.asset.label }
  ));
  return page.evaluate(`((segments) => {
    ${buildCanvasModelLocatorScript()}
    const target = findCanvasComposerModel()?.composerRef?.current;
    if (typeof target?.insertSegments !== 'function') {
      return { ok: false, reason: 'composer-model-unavailable' };
    }
    if (typeof target?.getDocument !== 'function') {
      return { ok: false, reason: 'composer-document-unavailable' };
    }
    const chips = new Map();
    for (const part of target.getDocument()?.parts || []) {
      const attachmentId = part?.type === 'chip' ? part?.data?.attachmentId : null;
      if (attachmentId && !chips.has(attachmentId)) chips.set(attachmentId, part);
    }
    const newChipId = () => 'chip_' + (
      globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2)
    );
    const built = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        built.push({ type: 'text', text: segment.text });
        continue;
      }
      const source = chips.get(segment.attachmentId);
      if (!source) return { ok: false, reason: 'attachment-chip-missing', label: segment.label };
      built.push({
        type: 'chip',
        chipId: newChipId(),
        kind: source.kind,
        phase: source.phase,
        data: { ...source.data },
      });
    }
    if (typeof target.focusEnd === 'function') target.focusEnd();
    const accepted = target.insertSegments(built);
    return { ok: accepted !== false, via: 'insertSegments-atomic', segments: built.length };
  })(${JSON.stringify(payload)})`).catch((error) => ({ ok: false, reason: describeError(error) }));
}

export async function fillCanvasPrompt(page, agentPrompt, assets = []) {
  if (!agentPrompt) return;

  const segments = buildCanvasMentionSegments(agentPrompt, assets);
  let expectedMentionCount = 0;
  let insertionVia = '';
  for (const segment of segments) {
    if (segment.type === 'text') {
      insertionVia = await insertCanvasPromptText(page, segment.value);
      lastPromptInsertionMethod = insertionVia || lastPromptInsertionMethod;
      await waitForCanvasPromptText(page, segment.value);
      continue;
    }
    expectedMentionCount += 1;
    // Without the composer model, typed text leaves the caret wherever the
    // editor put it; rich mentions would then land mid-prompt. Anchor the
    // caret at the end first so mentions append in prompt order.
    if (insertionVia && insertionVia !== COMPOSER_MODEL_INSERTION) {
      await placeCanvasPromptCaretAtEnd(page);
    }
    await insertCanvasRichMention(page, segment.asset, expectedMentionCount);
  }

  await page.sleep(0.3);
  const mentionState = await collectCanvasRichMentionState(page);
  if (mentionState.menuVisible) {
    await page.nativeKeyPress('Escape').catch(() => null);
    await page.sleep(0.15);
  }
}

export async function collectCanvasContentCheckpointSnapshot(page, canonical, assets = []) {
  const expectedAttachmentIds = (assets || [])
    .map((asset) => asset?.attachmentId)
    .filter(Boolean);
  return page.evaluate(`(() => {
    ${buildCanvasModelLocatorScript()}
    const editor = findCanvasPromptEditor();
    const composerRoot = findCanvasComposerRoot();
    const chips = composerRoot
      ? [...composerRoot.querySelectorAll(${JSON.stringify(CANVAS_CHIP_SELECTOR)})]
      : [];
    const sendBtn = findCanvasSendButton(false);
    const surfaceReady = !!editor;

    const model = findCanvasComposerModel();
    const uploadSnapshot = model?.attachmentUploads?.getSnapshot?.();
    const allUploadItems = Array.isArray(uploadSnapshot?.items) ? uploadSnapshot.items : null;
    const expectedAttachmentIds = ${JSON.stringify(expectedAttachmentIds)};
    const uploadItems = allUploadItems === null
      ? []
      : (expectedAttachmentIds.length > 0
        ? allUploadItems.filter((item) => expectedAttachmentIds.includes(item.attachmentId))
        : allUploadItems);

    const separator = editor
      ? [...editor.children].find((node) => (
        (node.innerText || node.textContent || '').replace(/[\\u00a0\\u200b\\s]+/g, '') === '---'
      ))
      : null;
    const followsSeparator = (node) => !!separator
      && !!(separator.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    const attachmentDomChips = chips.filter((chip) => !separator || !followsSeparator(chip));

    const chipLabels = allUploadItems !== null
      ? uploadItems.map((item) => (
        item.fileName
        || item.filename
        || item.resource?.fileName
        || item.resource?.filename
        || ''
      )).filter(Boolean)
      : attachmentDomChips.map((chip) => (
        chip.getAttribute('title') || chip.innerText || chip.textContent || ''
      )).map((label) => label.replace(/\\s+/g, ' ').trim()).filter(Boolean);

    const processingCount = allUploadItems !== null
      ? uploadItems.filter((item) => item.status === 'uploading' || item.status === 'processing').length
      : attachmentDomChips.filter((chip) => {
        const status = chip.getAttribute('data-chip-status')
          || chip.querySelector('[data-chip-status]')?.getAttribute('data-chip-status');
        return status === 'uploading' || status === 'processing';
      }).length;

    const readMention = (node) => {
      const values = [
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        node.innerText,
        node.textContent,
      ];
      for (const child of node.querySelectorAll('[aria-label], [title], img[alt]')) {
        values.push(
          child.getAttribute('aria-label'),
          child.getAttribute('title'),
          child.getAttribute('alt'),
        );
      }
      const readable = values.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
      return readable.match(/(?:图片|视频|音频)\\d+/)?.[0] || readable;
    };
    const inlineMentionNodes = editor && separator
      ? [...editor.querySelectorAll(${JSON.stringify(CANVAS_INLINE_REFERENCE_SELECTOR)})]
        .filter(canvasVisible)
        .filter(followsSeparator)
      : [];
    const hintedMentionNodes = editor
      ? [...editor.querySelectorAll(${JSON.stringify(CANVAS_RICH_MENTION_SELECTOR)})]
        .filter(canvasVisible)
        .filter((node) => !separator || followsSeparator(node))
        .filter((node) => !inlineMentionNodes.some((inline) => (
          inline.contains(node) || node.contains(inline)
        )))
      : [];
    const mentionNodes = [...new Set([...inlineMentionNodes, ...hintedMentionNodes])];
    const richMentionLabels = mentionNodes.map(readMention);

    const semanticClone = editor ? editor.cloneNode(true) : null;
    if (semanticClone) {
      const cloneSeparator = [...semanticClone.children].find((node) => (
        (node.textContent || '').replace(/[\\u00a0\\u200b\\s]+/g, '') === '---'
      ));
      const cloneFollowsSeparator = (node) => !!cloneSeparator
        && !!(cloneSeparator.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
      const cloneAllInline = [...semanticClone.querySelectorAll(
        ${JSON.stringify(CANVAS_INLINE_REFERENCE_SELECTOR)},
      )];
      const cloneInline = cloneSeparator
        ? cloneAllInline.filter(cloneFollowsSeparator)
        : [];
      for (const node of cloneAllInline.filter((candidate) => !cloneInline.includes(candidate))) {
        node.remove();
      }
      const cloneHinted = [...semanticClone.querySelectorAll(${JSON.stringify(CANVAS_RICH_MENTION_SELECTOR)})]
        .filter((node) => !cloneSeparator || cloneFollowsSeparator(node))
        .filter((node) => !cloneInline.some((inline) => inline.contains(node) || node.contains(inline)));
      for (const node of [...new Set([...cloneInline, ...cloneHinted])]) {
        if (!node.isConnected && !semanticClone.contains(node)) continue;
        const label = readMention(node);
        if (label) node.replaceWith(document.createTextNode('@' + label));
      }
    }
    const editorText = semanticClone
      ? (semanticClone.textContent || '').replace(/\\u00a0/g, ' ')
      : '';
    const assetId = ${JSON.stringify(canonical.assetId || '')};
    const assetIdPresent = assetId ? editorText.includes(assetId) : true;

    const menuVisible = [...document.querySelectorAll(
      '[role="menu"], [role="listbox"], [data-radix-menu-content][data-state="open"]'
    )].some(canvasVisible);

    const submitEnabled = !!sendBtn && canvasButtonEnabled(sendBtn);

    return {
      surfaceReady,
      promptSeparatorFound: !!separator,
      referenceCount: allUploadItems !== null ? uploadItems.length : attachmentDomChips.length,
      observedChipLabels: chipLabels,
      processingCount,
      menuVisible,
      assetIdPresent,
      editorTextNormalized: editorText.replace(/[\\u00a0\\u200b\\s]+/g, ''),
      richMentionCount: mentionNodes.length,
      richMentionLabels,
      submitEnabled,
    };
  })()`);
}

function chunkCanvasPromptAnchors(value, chunkSize = 48) {
  const normalized = String(value || '').replace(/[\u00a0\u200b\s]+/g, '');
  const anchors = [];
  for (let offset = 0; offset < normalized.length; offset += chunkSize) {
    anchors.push(normalized.slice(offset, offset + chunkSize));
  }
  return anchors;
}

export async function runCanvasContentCheckpoint(page, canonical, assets, options = {}) {
  const snapshot = await collectCanvasContentCheckpointSnapshot(page, canonical, assets);
  snapshot.requireSubmitArmed = options.requireSubmitArmed === true;

  const expectations = {
    expectedReferences: Array.isArray(assets) ? assets.length : 0,
    expectedChipLabels: (assets || []).map((asset) => (
      [...new Set([asset.filename, asset.label].filter(Boolean))]
    )),
    expectedMentionLabels: (canonical.mentions || []).map((mention) => mention.label),
    textAnchors: chunkCanvasPromptAnchors(canonical.agentPrompt),
  };

  const report = evaluateCanvasContentCheckpoint(snapshot, expectations);
  if (!report.ok) {
    const mismatch = report.anchorMismatch
      ? `, anchor#${report.anchorMismatch.index}=${JSON.stringify(report.anchorMismatch.anchor)}, editor=${JSON.stringify(report.anchorMismatch.editorAtCursor)}, editorFull=${JSON.stringify(snapshot.editorTextNormalized || '')}`
      : '';
    throw phaseError(
      'checkpoint',
      `Canvas content checkpoint failed: ${report.failures.join(', ')} (observed chips=${snapshot.referenceCount}, expected=${expectations.expectedReferences}, labels=${JSON.stringify(snapshot.observedChipLabels || []).slice(0, 300)}, mentions=${JSON.stringify(snapshot.richMentionLabels || []).slice(0, 300)}, sendArmed=${snapshot.submitEnabled}, promptVia=${lastPromptInsertionMethod || 'unknown'}, separator=${snapshot.promptSeparatorFound === true}, editorChars=${(snapshot.editorTextNormalized || '').length}${mismatch})`,
      'No generation was submitted. Inspect the canvas composer chips and prompt.',
    );
  }
  return report;
}

export function evaluateCanvasSubmitUIState(snapshot) {
  const assetIdInComposer = snapshot?.assetIdInComposer === true;
  const assetIdOutsideComposer = snapshot?.assetIdOutsideComposer === true;
  const confirmed = assetIdOutsideComposer && !assetIdInComposer;
  return {
    confirmed,
    reason: confirmed ? 'message_bubble_rendered' : 'none',
    assetIdInComposer,
    assetIdOutsideComposer,
    composerEmpty: snapshot?.composerEmpty === true,
    agentBusy: snapshot?.agentBusy === true,
    error: typeof snapshot?.error === 'string' ? snapshot.error : '',
  };
}

export async function detectCanvasSubmitUIConfirmation(page, assetId) {
  if (typeof page?.evaluate !== 'function') {
    return evaluateCanvasSubmitUIState({ error: 'page.evaluate unavailable' });
  }
  const snapshot = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const assetId = ${JSON.stringify(String(assetId || ''))};
    if (!assetId) {
      return {
        assetIdInComposer: false,
        assetIdOutsideComposer: false,
        composerEmpty: false,
        agentBusy: false,
        error: 'assetId unavailable',
      };
    }

    const marker = '资产编号：' + assetId;
    const sidecar = findCanvasSidecar();
    const editor = findCanvasPromptEditor();
    if (!sidecar || !editor) {
      return {
        assetIdInComposer: false,
        assetIdOutsideComposer: false,
        composerEmpty: false,
        agentBusy: false,
        error: !sidecar ? 'sidecar not found' : 'prompt editor not found',
      };
    }

    const editorText = editor.innerText || editor.textContent || '';
    const assetIdInComposer = editorText.includes(marker);
    const composerEmpty = editorText.replace(/[\\u00a0\\u200b\\s]+/g, '').length === 0;

    let assetIdOutsideComposer = false;
    const candidates = [...sidecar.querySelectorAll('div, p, span, li')];
    for (const el of candidates) {
      if (!canvasVisible(el)) continue;
      if (editor.contains(el) || el.contains(editor)) continue;
      const text = el.innerText || el.textContent || '';
      if (text.includes(marker)) {
        assetIdOutsideComposer = true;
        break;
      }
    }

    const sendBtn = findCanvasSendButton(false);
    const stopBtn = sidecar.querySelector(${JSON.stringify(CANVAS_STOP_SELECTOR)});
    const semanticStop = [...sidecar.querySelectorAll('button, [role="button"]')]
      .filter(canvasVisible)
      .find((button) => /^(?:停止生成|停止|stop generating|stop)$/i.test([
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.innerText,
        button.textContent,
      ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim()));
    const agentBusy = (!!stopBtn && canvasVisible(stopBtn))
      || !!semanticStop
      || (!!sendBtn && /停止|stop/i.test([
        sendBtn.getAttribute('aria-label'),
        sendBtn.getAttribute('title'),
      ].filter(Boolean).join(' ')));

    return {
      assetIdInComposer,
      assetIdOutsideComposer,
      composerEmpty,
      agentBusy,
    };
  })()`).catch(() => ({
    assetIdInComposer: false,
    assetIdOutsideComposer: false,
    composerEmpty: false,
    agentBusy: false,
    error: 'evaluate failed',
  }));
  return evaluateCanvasSubmitUIState(snapshot);
}

export async function submitCanvasPreparedGeneration(page, canonical, options = {}) {
  const assetId = canonical.assetId;
  if (!assetId) {
    const err = new Error('assetId is required for canvas submit ACK validation');
    err.phase = 'submit';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  assertCanvasPageCapabilities(page);

  if (typeof page.startNetworkCapture !== 'function' || typeof page.readNetworkCapture !== 'function') {
    const err = new Error('Browser driver does not support network capture required for canvas submit ACK');
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  const captureStarted = await page.startNetworkCapture(JIMENG_CANVAS_CAPTURE_PATTERN).catch(() => false);
  if (!captureStarted) {
    const err = new Error('Network capture could not be started for canvas submit ACK');
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  // Drain pre-click capture entries
  let drained;
  try {
    drained = await page.readNetworkCapture();
    if (!Array.isArray(drained)) {
      throw new Error('network capture drain returned a non-array payload');
    }
  } catch (drainErr) {
    const err = new Error(`Pre-click canvas network capture drain failed: ${describeError(drainErr)}`);
    err.phase = 'submit-capture-unavailable';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }
  const priorMatching = drained.map(normalizeCaptureEntry).filter((entry) => (
    isCanvasSendUrl(entry.url) && (!entry.method || entry.method === 'POST')
  ));
  if (priorMatching.length > 0) {
    const priorAck = classifyCanvasSubmitAck({ entries: priorMatching, assetId, timedOut: true });
    if (priorAck.kind === 'confirmed') {
      return {
        accepted: true,
        confirmation: 'ack_confirmed',
        sessionId: priorAck.sessionId || '',
        submitRequestCount: 1,
      };
    }
    const err = new Error('Prior canvas submit evidence was observed before clicking send');
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  const preClickUI = await detectCanvasSubmitUIConfirmation(page, assetId);
  if (preClickUI.confirmed) {
    return {
      accepted: true,
      confirmation: 'ui_confirmed',
      sessionId: '',
      submitRequestCount: 0,
      uiEvidence: preClickUI.reason,
    };
  }
  if (!preClickUI.assetIdInComposer) {
    const err = new Error('Canvas prompt assetId disappeared before the send click');
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  // Locate send button
  const marker = nextMarker('send');
  const marked = await page.evaluate(`(() => {
    ${buildCanvasLocatorScript()}
    const btn = findCanvasSendButton(true);
    if (!btn) {
      return { ok: false };
    }
    btn.setAttribute(${JSON.stringify(TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);

  if (!marked?.ok) {
    const err = new Error('Canvas send button is not visible or not enabled after checkpoint');
    err.phase = 'submit-button-missing';
    err.retryable = true;
    err.nonRetryable = false;
    throw err;
  }

  let clickError = null;
  try {
    await page.click(`[${TARGET_ATTR}="${marker}"]`);
  } catch (clickErr) {
    clickError = clickErr;
  }

  // Network capture reads are destructive. Poll only the DOM during the ACK
  // window, then read and classify the capture buffer exactly once.
  const requestedTimeoutMs = Number(options.timeoutMs ?? 15_000);
  const requestedPollIntervalMs = Number(options.pollIntervalMs ?? 500);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, requestedTimeoutMs)
    : 15_000;
  const pollIntervalMs = Number.isFinite(requestedPollIntervalMs)
    ? Math.max(50, requestedPollIntervalMs)
    : 500;
  const deadline = Date.now() + timeoutMs;
  let uiAck = preClickUI;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      await page.sleep(Math.min(pollIntervalMs, remainingMs) / 1000);
    } catch (sleepErr) {
      const err = new Error(`Canvas submit ACK wait failed after the send click: ${describeError(sleepErr)}`);
      err.phase = 'submit-unconfirmed';
      err.retryable = false;
      err.nonRetryable = true;
      throw err;
    }
    uiAck = await detectCanvasSubmitUIConfirmation(page, assetId).catch(() => null);
    if (uiAck?.confirmed) {
      break;
    }
  }

  let capturedEntries;
  let captureReadError = null;
  try {
    capturedEntries = await page.readNetworkCapture();
    if (!Array.isArray(capturedEntries)) {
      throw new Error('network capture read returned a non-array payload');
    }
  } catch (readErr) {
    capturedEntries = [];
    captureReadError = readErr;
  }

  let finalAck = null;
  if (!captureReadError) {
    try {
      finalAck = classifyCanvasSubmitAck({
        entries: capturedEntries,
        assetId,
        timedOut: true,
      });
    } catch (classifyErr) {
      captureReadError = classifyErr;
    }
  }

  if (finalAck?.kind === 'confirmed') {
    return {
      accepted: true,
      confirmation: 'ack_confirmed',
      sessionId: finalAck.sessionId || '',
      submitRequestCount: finalAck.matchingRequestCount || 1,
    };
  }

  if (finalAck?.kind === 'rejected') {
    const err = new Error(`Server rejected canvas send (code: ${finalAck.errorCode}, msg: ${finalAck.errorMsg || 'rejected'})`);
    err.phase = 'submit-rejected';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  if (!uiAck?.confirmed) {
    uiAck = await detectCanvasSubmitUIConfirmation(page, assetId).catch(() => null);
  }
  if (uiAck?.confirmed) {
    return {
      accepted: true,
      confirmation: 'ui_confirmed',
      sessionId: finalAck?.sessionId || '',
      submitRequestCount: finalAck?.matchingRequestCount || 0,
      uiEvidence: uiAck.reason,
    };
  }

  if (captureReadError) {
    const err = new Error(`Network capture could not be read after send (${describeError(captureReadError)})`);
    err.phase = 'submit-unconfirmed';
    err.retryable = false;
    err.nonRetryable = true;
    throw err;
  }

  if (
    finalAck?.kind === 'not_sent'
    && uiAck?.assetIdInComposer === true
    && uiAck?.assetIdOutsideComposer !== true
  ) {
    const clickDetail = clickError ? ` (${describeError(clickError)})` : '';
    const err = new Error(`Send click did not move the prompt or trigger a captured request${clickDetail}`);
    err.phase = 'submit-not-sent';
    err.retryable = true;
    err.nonRetryable = false;
    throw err;
  }

  const reason = finalAck?.reason
    || (clickError ? `send click failed: ${describeError(clickError)}` : '')
    || 'Canvas send request or page state could not be confirmed safely';
  const err = new Error(reason);
  err.phase = 'submit-unconfirmed';
  err.retryable = false;
  err.nonRetryable = true;
  throw err;
}

/**
 * Create a blank canvas project and return its identity for later runs.
 *
 * Materialization is the only step: nothing is uploaded, typed or submitted,
 * so the returned `projectId` can be reused by `canvas-video --canvas <id>`
 * without carrying any draft state.
 *
 * @returns {Promise<Array<{ status: string, projectId: string, canvasTitle: string, canvasUrl: string }>>}
 */
export async function runJimengCanvasCreate(page, canonical = {}) {
  assertCanvasPageCapabilities(page);
  const title = typeof canonical.title === 'string' ? canonical.title.trim() : '';

  await openCanvasWorkspace(page, buildCanvasUrl(CANVAS_NEW));
  const materialized = await materializeNewCanvasProject(page);
  const projectId = String(materialized?.projectId || '').trim();
  if (!projectId) {
    throw phaseError(
      'materialize',
      'Jimeng canvas project id was not exposed after materialization',
      'The blank canvas may have been created partially. Inspect the visible canvas before retrying.',
    );
  }

  if (title) {
    await applyNewCanvasTitle(page, { canvasMode: 'new', title }, projectId);
  }

  // Blank-canvas materialization updates history in place but may leave the
  // preparing shell mounted. Reload the now-real project route so the canvas is
  // fully mounted before its id is handed to later canvas-video runs.
  const canvasUrl = buildCanvasUrl({ mode: 'existing', value: projectId, projectId });
  await openCanvasWorkspace(
    page,
    `${canvasUrl}?enter_from=page_click&from_page=create&opencli_materialized=1`,
  );
  const surface = await waitForCanvasSurface(page);

  return [{
    status: 'created',
    projectId: parseProjectIdFromHref(surface?.href) || projectId,
    canvasTitle: title,
    canvasUrl,
  }];
}

export async function prepareJimengCanvasAsk(page, canonical, preparedAssets, options = {}) {
  assertCanvasPageCapabilities(page);

  const initialUrl = buildCanvasUrl(canonical.canvas, { projectId: canonical.projectId });
  const uploads = [];
  let retriesUsed = 0;
  let priorInPlaceRetry = false;
  let startAssetIndex = 0;
  let titledProjectId = '';
  let activeProjectId = canonical.projectId || '';

  await openCanvasWorkspace(page, initialUrl);

  while (true) {
    try {
      if (canonical.canvasMode === 'new' && !activeProjectId) {
        const materialized = await materializeNewCanvasProject(page);
        activeProjectId = materialized.projectId;
        if (activeProjectId !== titledProjectId) {
          const titled = await applyNewCanvasTitle(page, canonical, activeProjectId);
          titledProjectId = titled?.projectId || '';
        }
        // Blank-canvas materialization updates history in place but may leave
        // the preparing shell mounted. Reload the now-real project route.
        await openCanvasWorkspace(
          page,
          `${buildCanvasUrl({
            mode: 'existing',
            value: activeProjectId,
            projectId: activeProjectId,
          })}?enter_from=page_click&from_page=create&opencli_materialized=1`,
        );
      }
      await waitForCanvasSurface(page);
      await ensureCanvasSidecarOpen(page);
      if (canonical.submit) {
        await waitForCanvasSubmitReady(page);
      }
      await runCanvasPreInputControlsCheck(page, {
        requireAddControl: preparedAssets.length > 0,
      });

      if (startAssetIndex === 0) {
        await clearCanvasComposer(page, 'clear-initial');
      }

      await uploadCanvasReferenceAssets(page, preparedAssets, uploads, startAssetIndex);
      await composeCanvasPrompt(page, canonical.agentPrompt, uploads);

      const checkpoint = await runCanvasContentCheckpoint(
        page,
        canonical,
        uploads,
        { requireSubmitArmed: !!canonical.submit },
      );

      let submitted = false;
      let submitResult = null;
      if (canonical.submit) {
        submitResult = await submitCanvasPreparedGeneration(page, canonical, options);
        submitted = submitResult?.accepted === true;
        if (!submitted) {
          const err = new Error('Canvas submit returned without acceptance confirmation');
          err.phase = 'submit-unconfirmed';
          err.retryable = false;
          err.nonRetryable = true;
          throw err;
        }
      }

      // Read final project id from URL or runtime
      const finalHref = await page.evaluate(() => location.href).catch(() => '');
      const resolvedProjectId = parseProjectIdFromHref(finalHref)
        || activeProjectId
        || canonical.projectId
        || '';
      const finalCanvasUrl = resolvedProjectId
        ? buildCanvasUrl({ mode: 'existing', value: resolvedProjectId, projectId: resolvedProjectId })
        : finalHref;

      return {
        status: submitted ? 'submitted' : 'prepared',
        canvas: canonical.canvas,
        canvasMode: canonical.canvasMode,
        projectId: resolvedProjectId,
        canvasTitle: canonical.title || '',
        canvasUrl: finalCanvasUrl,
        uploaded: uploads.map((asset) => asset.filename),
        references: checkpoint.expected.references,
        assetId: canonical.assetId,
        retryUsed: retriesUsed,
        submitted,
        checkpointOk: true,
        confirmation: submitResult?.confirmation ?? 'none',
        sessionId: submitResult?.sessionId ?? '',
        submitRequestCount: submitResult?.submitRequestCount ?? (submitted ? 1 : 0),
      };
    } catch (err) {
      const failure = {
        message: describeError(err),
        hint: typeof err?.hint === 'string' ? err.hint : 'Inspect the visible canvas and retry.',
        phase: typeof err?.phase === 'string' ? err.phase : 'surface',
        failedAssetIndex: Number.isInteger(err?.failedAssetIndex) ? err.failedAssetIndex : uploads.length,
        retryable: err?.retryable !== false && !err?.nonRetryable,
      };

      const surface = await probeJimengCanvasSurface(page).catch(() => ({ ready: false, editorReady: false }));

      const plan = chooseCanvasRetryPlan({
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

        let prefix = 'JIMENG_CANVAS_PREPARE_FAILED';
        let hint = failure.hint;
        if (isUnconfirmed) {
          prefix = 'JIMENG_CANVAS_SUBMIT_UNCONFIRMED';
          hint = `${failure.hint} 可能已受理时请勿重试，手动核对画布。`;
        } else if (isRejected) {
          prefix = 'JIMENG_CANVAS_SUBMIT_REJECTED';
          hint = `${failure.hint} 服务端已明确拒绝，请勿重试。`;
        } else if (isSubmitFailure) {
          prefix = 'JIMENG_CANVAS_SUBMIT_FAILED';
          hint = `No generation was submitted. ${failure.hint}`;
        }

        throw new CommandExecutionError(
          `${prefix}: ${failure.message}`,
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
      const retryUrl = canonical.canvasMode === 'new' && activeProjectId
        ? buildCanvasUrl({
          mode: 'existing',
          value: activeProjectId,
          projectId: activeProjectId,
        })
        : initialUrl;
      await openCanvasWorkspace(page, retryUrl);
    }
  }
}

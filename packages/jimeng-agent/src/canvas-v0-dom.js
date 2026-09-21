/**
 * Visible-UI Jimeng legacy canvas (v0, /ai-tool/canvas) preparation, checkpoint
 * and optional submit.
 *
 * Verified surface contract (recon on the live legacy canvas):
 *   - composer root      : [class*="content-generator"]  (panel + canvas share one document)
 *   - prompt editor      : .tiptap.ProseMirror[contenteditable="true"]
 *   - references         : [class*="reference-item"] with an <img>; upload input is input[type=file]
 *   - creation type      : [role="combobox"] in the composer toolbar (Agent 模式 / 图片生成 / 视频生成)
 *   - generation prefs   : toolbar button 自动 / 自定义 opens a 生成偏好 popover (图片|视频 + 选择比例)
 *   - send               : primary button inside [class*="toolbar-actions"]
 *
 * The legacy canvas carries uploaded files as attachments (no document mention
 * chip), so the prompt is plain text; `资产编号：<assetId>` is still the ACK anchor.
 */

import { CommandExecutionError } from '@jackwener/opencli/errors';

import { chooseCanvasRetryPlan } from './canvas-dom.js';
import { classifyCanvasSubmitAck } from './canvas-submit-ack.js';
import {
  JIMENG_CANVAS_V0_ASSET_URL as CANVAS_V0_ASSET_URL,
  buildCanvasV0Url,
  buildCanvasV0CreateProjectBody,
  evaluateCanvasV0Checkpoint,
  evaluateCanvasV0PreInputControls,
  evaluateCanvasV0SubmitReadiness,
  normalizeV0EditorText,
  readCanvasV0CreatedProject,
  V0_CANVAS_CREATE_QUERY,
  V0_CREATE_PROJECT_PATH,
  V0_CREATE_PROJECT_QUERY,
} from './canvas-v0-contract.js';
import { requestJimengJson } from './canvas-api.js';

export const CANVAS_V0_SEND_ACK_TIMEOUT_MS = 15_000;
export const CANVAS_V0_UPLOAD_TIMEOUT_MS = 90_000;
const CANVAS_V0_TARGET_ATTR = 'data-opencli-jimeng-v0-target';
const CANVAS_V0_UPLOAD_INPUT_ATTR = 'data-opencli-jimeng-v0-upload';
const CANVAS_V0_CAPTURE_PATTERN = 'jimeng.jianying.com/';
const CANVAS_V0_AGENT_MODE = 'Agent 模式';
const CANVAS_V0_VIDEO_MODE = '视频';
const CANVAS_V0_SETTINGS_TITLE = '生成偏好';

export function assertCanvasV0PageCapabilities(page) {
  const missing = ['goto', 'evaluate', 'click', 'sleep', 'nativeKeyPress', 'setFileInput']
    .filter((name) => typeof page?.[name] !== 'function');
  if (typeof page?.insertText !== 'function' && typeof page?.nativeType !== 'function') {
    missing.push('insertText|nativeType');
  }
  if (missing.length > 0) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_UNSUPPORTED: missing page capability ${missing.join(', ')}`,
      'Use the OpenCLI Browser Bridge extension with canvas support.',
    );
  }
}

function phaseError(phase, message, hint = 'Inspect the visible legacy canvas and retry.', failedAssetIndex) {
  const error = new Error(message);
  error.phase = phase;
  if (typeof failedAssetIndex === 'number') error.failedAssetIndex = failedAssetIndex;
  if (hint) error.hint = hint;
  return error;
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}

/**
 * In-page locator helpers shared by every evaluate call.
 *
 * Class names on the legacy canvas are hashed (`content-generator-PReCtV`), so
 * every locator matches the stable class *prefix* or a design-system class.
 *
 * The closed 对话 panel stays mounted at `left === window.innerWidth`, i.e. it
 * has a real box but sits outside the viewport. Size plus CSS visibility alone
 * would therefore report a closed panel as open, which silently sent every
 * prompt into the canvas bottom composer instead of the panel, so `v0Visible`
 * also requires the element to intersect the viewport.
 */
function buildCanvasV0LocatorScript() {
  return `
    const v0Styled = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const v0OnScreen = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.left < window.innerWidth && rect.right > 0
        && rect.top < window.innerHeight && rect.bottom > 0;
    };
    const v0Visible = (el) => v0Styled(el) && v0OnScreen(el);
    /** Docked means most of the element actually made it into the viewport. */
    const v0Docked = (el) => {
      if (!v0Styled(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return false;
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      return visibleWidth >= rect.width * 0.6;
    };
    const v0Roots = (scope) => [...(scope || document).querySelectorAll('[class*="content-generator"]')].filter(v0Visible);
    const v0Sidecar = () => [...document.querySelectorAll('aside[class*="right-panel"]')].filter(v0Docked)[0] || null;
    /** The only composer this run may type into: the docked 对话 panel composer. */
    const v0SidecarComposer = () => {
      const sidecar = v0Sidecar();
      return sidecar ? (v0Roots(sidecar)[0] || null) : null;
    };
    const v0ComposerRoot = () => v0SidecarComposer();
    const v0Editor = (root) => {
      const scope = root || document;
      const candidates = [...scope.querySelectorAll('.tiptap.ProseMirror[contenteditable="true"]')].filter(v0Visible);
      return candidates.find((el) => {
        const chain = String(el.parentElement?.className || '') + ' ' + String(el.parentElement?.parentElement?.className || '');
        return !/sizer/i.test(chain);
      }) || candidates[0] || null;
    };
    const v0EditorText = (editor) => {
      if (!editor) return '';
      const clone = editor.cloneNode(true);
      for (const node of [...clone.querySelectorAll('[class*="placeholder"], [class*="Placeholder"]')]) {
        node.remove();
      }
      return clone.textContent || '';
    };
    const v0SendButton = (root) => {
      const scope = root || document;
      for (const box of [...scope.querySelectorAll('[class*="toolbar-actions"]')].filter(v0Visible)) {
        const button = [...box.querySelectorAll('button')].filter(v0Visible)[0];
        if (button) return button;
      }
      for (const box of [...scope.querySelectorAll('[class*="collapsed-submit-button-container"]')].filter(v0Visible)) {
        const button = [...box.querySelectorAll('button')].filter(v0Visible)[0];
        if (button) return button;
      }
      return null;
    };
    const v0ButtonByText = (root, pattern) => {
      const scope = root || document;
      return [...scope.querySelectorAll('button')].filter(v0Visible).find((button) => pattern.test((button.innerText || '').replace(/\\s+/g, ''))) || null;
    };
    const v0CanvasComposer = () => {
      const sidecar = v0Sidecar();
      return v0Roots(document).find((root) => !(sidecar && sidecar.contains(root))) || null;
    };
    /** Any visible composer, whichever dock currently renders it. */
    const v0AnyComposer = () => v0Roots(document)[0] || null;
    const v0PanelReady = () => !!v0Sidecar() && !!v0SidecarComposer();
    /**
     * Reading helper for the docked 对话 toolbar: it renders its labels as icons while
     * the canvas keeps a zero-sized composer that still renders the text variants, so
     * label reads tolerate any rendered node while clicks stay restricted to the panel.
     */
    const v0Rendered = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const v0IconKey = (node) => [...((node && node.querySelectorAll('path')) || [])]
      .map((path) => path.getAttribute('d') || '')
      .join('|');
    const v0CreationTypeSelects = () => {
      const found = [];
      for (const root of [v0ComposerRoot(), v0CanvasComposer(), document]) {
        if (!root) continue;
        for (const select of root.querySelectorAll('[role="combobox"]')) {
          if (!found.includes(select) && v0Rendered(select)) found.push(select);
        }
      }
      return found;
    };
    /** The 创作类型 label, read from whichever rendered composer still shows it. */
    const v0CreationTypeRead = () => {
      const selects = v0CreationTypeSelects();
      for (const select of selects) {
        const text = (select.innerText || '').replace(/\\s+/g, ' ').trim();
        if (text) return { text, select };
      }
      return { text: '', select: selects.find(v0OnScreen) || selects[0] || null };
    };
    /**
     * 生成偏好 自动 state mirror. The docked panel renders its trigger as an icon and
     * the canvas keeps a zero-sized composer that still renders the text variant, so
     * 自动/自定义 is read from any rendered clone (same trick as the 创作类型 label).
     */
    const v0AutoPreference = () => {
      const label = [...document.querySelectorAll('button')]
        .map((button) => (button.innerText || '').replace(/\\s+/g, ''))
        .find((text) => text === '自动' || text === '自定义');
      if (label === '自动') return true;
      if (label === '自定义') return false;
      return null;
    };
    /** The 创作类型 trigger this run may click: the docked panel's own selector. */
    const v0CreationTypeTarget = () => v0CreationTypeSelects().find(v0OnScreen) || null;
    const v0CreationTypeMenu = () => [...document.querySelectorAll('[role="option"]')].filter(v0Rendered);
    const v0CreationTypeSelected = () => {
      const selected = [...document.querySelectorAll('[role="option"][aria-selected="true"]')].filter(v0Rendered)[0] || null;
      return selected ? (selected.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    };
    const v0CreationTypeOption = (label) => v0CreationTypeMenu()
      .find((option) => (option.innerText || '').replace(/\\s+/g, ' ').trim() === label) || null;
    const v0ToolbarTrigger = (root, pattern) => {
      const scope = root || document;
      return [...scope.querySelectorAll('button')].filter(v0Rendered)
        .find((button) => pattern.test((button.innerText || '').replace(/\\s+/g, ''))) || null;
    };
    /**
     * 生成偏好 trigger. The docked panel renders it as an icon alone, so it is located by
     * the icon it shares with the composer that still renders the 自动/自定义 label.
     */
    const v0SettingsTrigger = () => {
      const docked = v0ComposerRoot();
      const labelled = docked ? v0ToolbarTrigger(docked, /^(自动|自定义)$/) : null;
      if (labelled) return labelled;
      const reference = v0ToolbarTrigger(v0CanvasComposer(), /^(自动|自定义)$/)
        || v0ToolbarTrigger(document, /^(自动|自定义)$/);
      if (!reference || !docked) return reference;
      const key = v0IconKey(reference);
      if (!key) return reference;
      return [...docked.querySelectorAll('button')].filter(v0Rendered)
        .find((button) => v0IconKey(button) === key) || reference;
    };
    const v0UploadInput = (scope) => [...(scope || document).querySelectorAll('input[type="file"]')][0] || null;
    const v0ReferenceItems = (root) => {
      const scope = root || document;
      return [...scope.querySelectorAll('[class*="reference-item"]')]
        .filter(v0Visible)
        .filter((item) => item.querySelector('img'));
    };
    const v0UploadControl = (root) => {
      const scope = root || document;
      return [...scope.querySelectorAll('[class*="reference-upload"]')].filter(v0Visible)[0] || null;
    };
    const v0Popover = (titleText) => [...document.querySelectorAll('.lv-popover-content, [class*="lv-popover-content"]')]
      .filter(v0Visible)
      .find((node) => (node.innerText || '').includes(titleText)) || null;
    const v0SettingsPanel = () => {
      const nodes = [...document.querySelectorAll('.lv-popover-content, [class*="lv-popover-content"], [class*="agentic-settings-panel"], [class*="settings-panel"]')]
        .filter(v0Visible);
      return nodes.find((node) => (node.innerText || '').includes(${JSON.stringify(CANVAS_V0_SETTINGS_TITLE)})
        && (node.innerText || '').includes('选择比例')) || null;
    };
    const v0RadioLabel = (scope, label) => [...(scope || document).querySelectorAll('label')].filter(v0Visible)
      .find((node) => (node.innerText || '').trim() === label) || null;
    const v0RadioChecked = (label) => !!label
      && (label.querySelector('input')?.checked === true || /checked/.test(String(label.className || '')));
    const v0Alerts = () => [...document.querySelectorAll('[role="alert"], [class*="toast-"], [class^="toast"], [class*="Toast"]')]
      .filter(v0Visible)
      .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const v0StopButton = (root) => [...(root || document).querySelectorAll('button, [role="button"]')]
      .filter(v0Visible)
      .find((node) => /^(?:停止生成|停止|stop generating|stop)$/i.test([node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim())) || null;
  `;
}

export async function probeJimengCanvasV0Surface(page) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const sidecar = v0Sidecar();
    const composer = v0ComposerRoot();
    const anyComposer = v0AnyComposer();
    const launcher = [...document.querySelectorAll('button')]
      .filter(v0Visible)
      .find((node) => /^对话$/.test((node.innerText || '').trim())) || null;
    const editor = composer ? v0Editor(composer) : null;
    const anyEditor = anyComposer ? v0Editor(anyComposer) : null;
    const send = composer ? v0SendButton(composer) : null;
    const input = v0UploadInput(sidecar || document);
    const creationType = v0CreationTypeRead();
    const references = composer ? v0ReferenceItems(composer).length : 0;
    return {
      href: location.href,
      surfaceReady: !!anyComposer,
      composerReady: !!composer,
      composerInSidecar: !!sidecar && !!composer && sidecar.contains(composer),
      sidecarOpen: !!sidecar,
      panelReady: v0PanelReady(),
      editorReady: !!editor,
      anyEditorReady: !!anyEditor,
      launcherVisible: !!launcher,
      uploadControlReady: !!(composer && v0UploadControl(composer)) || !!input,
      creationType: creationType.text,
      autoEnabled: v0AutoPreference(),
      referenceCount: references,
      sendVisible: !!send,
      sendEnabled: send ? !(send.disabled === true || send.getAttribute('aria-disabled') === 'true') : false,
      ready: !!composer && !!editor,
    };
  })()`);
}

export async function openCanvasV0Workspace(page, targetUrl) {
  await page.goto(targetUrl);
}

/**
 * Create a blank legacy canvas project through the page transport.
 *
 * The signed `sign` / `x-secsdk-*` headers are injected by the page's own fetch
 * wrapper, so the request runs through it instead of raw HTTP.
 */
export async function createCanvasV0Project(page, canonical = {}) {
  assertCanvasV0PageCapabilities(page);
  const href = await page.evaluate(() => location.href).catch(() => '');
  if (!/^https?:\/\/jimeng\.jianying\.com/.test(String(href || ''))) {
    await page.goto(CANVAS_V0_ASSET_URL);
  }
  const envelope = await requestJimengJson(
    page,
    `${V0_CREATE_PROJECT_PATH}?${V0_CREATE_PROJECT_QUERY}`,
    buildCanvasV0CreateProjectBody({ name: canonical.title }),
    { pathPrefixes: ['/mweb/v1/'] },
  );
  let created;
  try {
    created = readCanvasV0CreatedProject(envelope);
  } catch (error) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_CREATE_FAILED: ${describeError(error)}`,
      'Confirm the Jimeng browser session is logged in, then retry.',
    );
  }
  const canvasUrl = buildCanvasV0Url(
    { mode: 'existing', value: created.projectId, projectId: created.projectId },
    { projectId: created.projectId },
  );
  return {
    status: 'created',
    projectId: created.projectId,
    draftId: created.draftId,
    version: created.version,
    canvasTitle: typeof canonical.title === 'string' ? canonical.title : '',
    canvasUrl,
    canvasUrlWithEntry: `${canvasUrl}?${V0_CANVAS_CREATE_QUERY}`,
  };
}

/**
 * Wait for the canvas app itself. A fresh project opens with the 「对话」 panel
 * still closed and its composer living at the canvas bottom, so this only asserts
 * that some composer with an editor is on screen; `ensureCanvasV0SidecarOpen`
 * docks the panel right after and the pre-input controls check enforces it.
 */
export async function waitForCanvasV0Surface(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeJimengCanvasV0Surface(page).catch((error) => ({ error: describeError(error) }));
    if (last?.surfaceReady && (last?.anyEditorReady || last?.editorReady)) return last;
    await page.sleep(0.5);
  }
  throw phaseError(
    'surface',
    `Legacy canvas surface never became ready (href=${last?.href || 'unknown'}, surfaceReady=${last?.surfaceReady === true}, anyEditorReady=${last?.anyEditorReady === true}, sidecarEditorReady=${last?.editorReady === true})`,
    'Confirm the legacy canvas URL opens in the logged-in browser session, then retry.',
  );
}

const V0_SIDECAR_LAUNCHER_MARKER = 'sidecar-launcher';

const V0_SIDECAR_LAUNCHER_LOCATE = `
  const target = [...document.querySelectorAll('button')]
    .filter(v0Visible)
    .find((node) => /^对话$/.test((node.innerText || '').trim())) || null;
`;

/**
 * The 对话 panel slides in with a CSS transition, and a stalled slide-in leaves the
 * app convinced the panel is open while it stays parked off-screen. Activating the
 * leased tab (these commands already declare a foreground window) keeps the panel's
 * animation honest before any click is trusted.
 */
export async function activateCanvasV0Tab(page) {
  if (!page || typeof page.cdp !== 'function') return false;
  return page.cdp('Page.bringToFront').then(() => true, () => false);
}

/** Collapse the stalled panel through its own header control so the launcher returns. */
async function collapseStalledCanvasV0Sidecar(page) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const panel = [...document.querySelectorAll('aside[class*="right-panel"]')][0];
    if (!panel) return false;
    const buttons = [...panel.querySelectorAll('[class*="operation-button"]')].filter(v0Visible);
    const collapse = buttons[buttons.length - 1];
    if (!collapse) return false;
    collapse.click();
    return true;
  })()`).catch(() => false);
}

/**
 * Recover a panel that reports itself open while its slide-in never landed: first
 * collapse it so the launcher comes back, then (once) reload the project, which
 * re-mounts the panel from the state the app persisted for it.
 *
 * Returns `none` when the panel is not stalled, `recovered` when another probe is
 * worth taking, and `exhausted` when the stalled panel cannot be repaired here.
 */
async function recoverStalledCanvasV0Sidecar(page, last, state, deadline) {
  const stalled = !!last && last.surfaceReady === true && !last.sidecarOpen && !last.launcherVisible;
  if (!stalled) return 'none';
  if (state.collapses === 0) {
    state.collapses += 1;
    if (await collapseStalledCanvasV0Sidecar(page)) return 'recovered';
  }
  if (state.reloads === 0 && Date.now() + 15_000 < deadline) {
    state.reloads += 1;
    await page.evaluate('location.reload()').catch(() => null);
    await waitForCanvasV0Surface(page, Math.min(30_000, Math.max(1_000, deadline - Date.now()))).catch(() => null);
    await activateCanvasV0Tab(page);
    return 'recovered';
  }
  return 'exhausted';
}

/**
 * Dock the 对话 sidecar and keep it open.
 *
 * The panel must stay docked for the whole run: the prompt is typed into the
 * panel composer, and `canvas-v0-video` only reports a prepared draft when the
 * panel is still open. Every phase therefore re-asserts this state, and a
 * closed panel is a hard failure instead of silently falling back to the canvas
 * bottom composer. A slide-in that stalls off-screen is repaired in-place (or by
 * one reload) before the phase is allowed to fail.
 */
export async function ensureCanvasV0SidecarOpen(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  const state = { clicks: 0, collapses: 0, reloads: 0 };
  let last = await probeJimengCanvasV0Surface(page).catch((error) => ({ error: describeError(error) }));
  await activateCanvasV0Tab(page);

  while (Date.now() < deadline) {
    if (last?.panelReady && last?.editorReady) return { ...last, opened: state.clicks > 0 };
    const recovery = await recoverStalledCanvasV0Sidecar(page, last, state, deadline);
    if (recovery !== 'none') {
      // Nothing left to try: spinning until the deadline would only hide the cause.
      if (recovery === 'exhausted') break;
      last = await probeJimengCanvasV0Surface(page).catch((error) => ({ error: describeError(error) }));
      continue;
    }
    // The launcher only exists while the panel is closed, so re-marking it before
    // every click guarantees a repeat click can never toggle a docked panel shut.
    const located = last?.launcherVisible
      ? await markCanvasV0Control(page, V0_SIDECAR_LAUNCHER_MARKER, V0_SIDECAR_LAUNCHER_LOCATE)
        .catch((error) => ({ ok: false, reason: describeError(error) }))
      : { ok: false, reason: 'launcher-not-found' };
    if (located?.ok) {
      // Same document as the marker, so a toolbar re-render cannot invalidate it.
      const clicked = await page.evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(located.selector)});
        if (!node) return false;
        node.click();
        return true;
      })()`).catch(() => false);
      if (clicked) state.clicks += 1;
      await page.sleep(0.6);
    } else {
      await page.sleep(0.4);
    }
    last = await probeJimengCanvasV0Surface(page).catch(() => null);
  }

  throw phaseError(
    'sidecar',
    `Legacy canvas 对话 panel is not docked (sidecarOpen=${last?.sidecarOpen === true}, composerInSidecar=${last?.composerInSidecar === true}, editorReady=${last?.editorReady === true}, clicks=${state.clicks}, collapses=${state.collapses}, reloads=${state.reloads}, reason=${last?.error || 'none'})`,
    'No generation was submitted. Open the 对话 panel manually, confirm its composer is visible, then retry.',
  );
}

export async function runCanvasV0PreInputControlsCheck(page, options = {}) {
  const surface = await probeJimengCanvasV0Surface(page);
  const verdict = evaluateCanvasV0PreInputControls({
    surfaceReady: surface.surfaceReady,
    sidecarOpen: surface.sidecarOpen,
    composerInSidecar: surface.composerInSidecar,
    editorReady: surface.editorReady,
    composerReady: surface.composerReady,
    uploadControlReady: surface.uploadControlReady,
    requireUploadControl: options.requireUploadControl !== false,
  });
  if (!verdict.ok) {
    throw phaseError(
      'pre-input',
      `Legacy canvas pre-input controls failed: ${verdict.failures.join(', ')}`,
      'No generation was submitted. Confirm the docked 对话 panel composer, the 创作类型 selector and the reference control are visible.',
    );
  }
  return { ...verdict, observed: surface };
}

/**
 * Mark a control for a click and run an in-page probe until it passes.
 *
 * The legacy canvas toolbar mixes CDP-clickable buttons with controls that only
 * react to a programmatic click (their React handler sits behind the tooltip
 * wrapper), so every interaction is verified instead of assumed.
 */
async function probeCanvasV0(page, probeSource) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    ${probeSource}
  })()`).catch((error) => ({ ok: false, detail: describeError(error) }));
}

async function clickCanvasV0Control(page, locateSource, probeSource, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8_000;
  const label = options.label || 'control';
  const marker = options.marker || `control-${Math.abs(hashCode(label))}`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let located = null;

  // The legacy canvas re-renders its toolbar (and therefore replaces the trigger
  // node) around clicks, so every attempt re-locates the control. The first attempt
  // locates and clicks in a single round-trip: a marked selector survives long
  // enough for a CDP click only sometimes.
  const attempts = [
    async (selector, source) => page.evaluate(`(() => {
      ${buildCanvasV0LocatorScript()}
      ${source}
      if (!target) return false;
      target.click();
      return true;
    })()`),
    async (selector) => page.click(selector),
  ];

  for (const attempt of attempts) {
    if (Date.now() >= deadline) break;
    located = await markCanvasV0Control(page, marker, locateSource).catch((error) => ({ ok: false, reason: describeError(error) }));
    if (!located?.ok) {
      last = { ok: false, detail: `relocate-failed:${located?.reason || 'unknown'}` };
      continue;
    }
    await attempt(located.selector, locateSource).catch((error) => {
      last = { ok: false, detail: `click-failed:${describeError(error)}` };
      return null;
    });
    const pollDeadline = Math.min(deadline, Date.now() + Math.ceil(timeoutMs / 2));
    while (Date.now() < pollDeadline) {
      await page.sleep(0.25);
      last = await probeCanvasV0(page, probeSource);
      if (last?.ok) return { ...last, selector: located.selector };
    }
  }

  throw phaseError(
    options.phase || 'controls',
    `Legacy canvas ${label} did not react to the interaction (${last?.detail || 'no detail'}; located=${located?.ok === true})`,
    'No generation was submitted. Inspect the visible legacy canvas composer and retry.',
  );
}

function hashCode(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

async function markCanvasV0Control(page, marker, source) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    ${source}
    if (!target) return { ok: false, reason: 'control-not-found' };
    target.setAttribute(${JSON.stringify(CANVAS_V0_TARGET_ATTR)}, ${JSON.stringify(marker)});
    return { ok: true, selector: '[${CANVAS_V0_TARGET_ATTR}="' + ${JSON.stringify(marker)} + '"]' };
  })()`);
}

const V0_POPOVER_PROBE = `
  const popover = v0SettingsPanel();
  if (popover) return { ok: true, detail: 'settings-panel-open' };
  const anyPopover = [...document.querySelectorAll('.lv-popover-content, [class*="lv-popover-content"], [class*="settings-panel"]')]
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(',');
    });
  const trigger = v0SettingsTrigger();
  const triggerRect = trigger
    ? (() => { const rect = trigger.getBoundingClientRect(); return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(','); })()
    : 'none';
  return {
    ok: false,
    detail: 'popover-missing popovers=' + JSON.stringify(anyPopover)
      + ' trigger=' + triggerRect
      + ' sidecar=' + (!!v0Sidecar())
      + ' composer=' + (!!v0ComposerRoot())
      + ' canvasComposer=' + (!!v0CanvasComposer()),
  };
`;

function radioProbeSource(label) {
  return `
    const popover = v0SettingsPanel();
    if (!popover) return { ok: false, detail: 'popover-missing' };
    const groups = [...popover.querySelectorAll('[role="radiogroup"], [class*="lv-radio-group"]')].filter(v0Visible);
    const label = ${JSON.stringify(label)};
    for (const group of groups) {
      const item = v0RadioLabel(group, label);
      if (item) {
        const checked = v0RadioChecked(item);
        return { ok: checked, detail: 'checked=' + checked };
      }
    }
    return { ok: false, detail: 'radio-not-found' };
  `;
}

const V0_CREATION_MENU_PROBE = `
  const options = v0CreationTypeMenu();
  return {
    ok: options.length > 0,
    detail: (options.length ? 'options-open' : 'options-missing') + ' selected=' + (v0CreationTypeSelected() || 'unknown'),
  };
`;

async function readCanvasV0CreationState(page) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const read = v0CreationTypeRead();
    return {
      text: read.text,
      hasTarget: !!v0CreationTypeTarget(),
      options: v0CreationTypeMenu().length,
      selected: v0CreationTypeSelected(),
    };
  })()`);
}

async function openCanvasV0CreationMenu(page) {
  return clickCanvasV0Control(page, 'const target = v0CreationTypeTarget();', V0_CREATION_MENU_PROBE, {
    label: '创作类型 selector',
    marker: 'creation-type',
  });
}

async function closeCanvasV0CreationMenu(page) {
  let probe = await probeCanvasV0(page, V0_CREATION_MENU_PROBE);
  if (!probe?.ok) return { ...probe, ok: true, detail: 'options-already-closed' };
  await page.nativeKeyPress('Escape').catch(() => null);
  await page.sleep(0.3);
  probe = await probeCanvasV0(page, V0_CREATION_MENU_PROBE);
  if (!probe?.ok) return { ...probe, ok: true, detail: 'options-closed' };
  // This listbox does not handle Escape; clicking the trigger again closes it.
  await page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const target = v0CreationTypeTarget();
    if (target) target.click();
  })()`).catch(() => null);
  await page.sleep(0.3);
  probe = await probeCanvasV0(page, V0_CREATION_MENU_PROBE);
  return probe?.ok ? { ...probe, ok: false, detail: 'options-still-open' } : { ...probe, ok: true, detail: 'options-closed' };
}

async function ensureCanvasV0CreationType(page) {
  const current = await readCanvasV0CreationState(page);
  if (String(current?.text || '').includes(CANVAS_V0_AGENT_MODE)) {
    return { creationType: CANVAS_V0_AGENT_MODE, changed: false, source: 'label' };
  }
  if (!current?.hasTarget) {
    throw phaseError(
      'controls',
      'Legacy canvas 创作类型 selector was not found',
      'No generation was submitted. Open the 对话 panel composer and retry.',
    );
  }

  // The docked 对话 toolbar renders 创作类型 as an icon, so the open option list is the
  // only place that reports which mode the panel composer will actually submit with.
  await openCanvasV0CreationMenu(page);
  const opened = await readCanvasV0CreationState(page);
  const previous = String(opened?.selected || '');
  if (previous.includes(CANVAS_V0_AGENT_MODE)) {
    await closeCanvasV0CreationMenu(page);
    return { creationType: CANVAS_V0_AGENT_MODE, changed: false, source: 'listbox', previous };
  }

  await clickCanvasV0Control(page, `const target = v0CreationTypeOption(${JSON.stringify(CANVAS_V0_AGENT_MODE)});`, `
    const options = v0CreationTypeMenu();
    return { ok: options.length === 0, detail: options.length ? 'option-list-still-open' : 'option-list-closed' };
  `, { label: `创作类型 ${CANVAS_V0_AGENT_MODE} option`, marker: 'creation-type-agent' });

  await openCanvasV0CreationMenu(page);
  const confirmed = await readCanvasV0CreationState(page);
  await closeCanvasV0CreationMenu(page);
  if (!String(confirmed?.selected || '').includes(CANVAS_V0_AGENT_MODE)) {
    throw phaseError(
      'controls',
      `Legacy canvas 创作类型 did not switch to ${CANVAS_V0_AGENT_MODE} (selected=${confirmed?.selected || 'unknown'})`,
      `No generation was submitted. Pick ${CANVAS_V0_AGENT_MODE} in the 对话 panel composer and retry.`,
    );
  }
  return { creationType: CANVAS_V0_AGENT_MODE, changed: true, source: 'listbox', previous };
}

async function openCanvasV0GenerationSettings(page) {
  // The popover may already be open (a previous run or the operator left it that
  // way), and clicking its trigger would only close it again.
  const existing = await probeCanvasV0(page, V0_POPOVER_PROBE);
  if (existing?.ok) {
    const marked = await markCanvasV0Control(page, 'generation-settings', 'const target = v0SettingsTrigger();');
    return { ...existing, triggerSelector: marked?.ok ? marked.selector : '' };
  }
  const opened = await clickCanvasV0Control(page, 'const target = v0SettingsTrigger();', V0_POPOVER_PROBE, {
    label: '生成偏好 trigger',
    marker: 'generation-settings',
  });
  return { ...opened, triggerSelector: opened.selector };
}

async function closeCanvasV0GenerationSettings(page, triggerSelector) {
  await page.nativeKeyPress('Escape').catch(() => null);
  let probe = await probeCanvasV0(page, V0_POPOVER_PROBE);
  if (probe?.ok && triggerSelector) {
    await page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(triggerSelector)});
      if (node) node.click();
    })()`).catch(() => null);
    await page.sleep(0.3);
    probe = await probeCanvasV0(page, V0_POPOVER_PROBE);
  }
  return probe;
}

const V0_AUTO_SWITCH_PROBE = `
  const popover = v0SettingsPanel();
  const toggle = popover ? popover.querySelector('button[role="switch"]') : null;
  if (!toggle) return { ok: false, detail: 'auto-switch-not-found' };
  const enabled = toggle.getAttribute('aria-checked') === 'true';
  return { ok: enabled, detail: 'auto-switch aria-checked=' + String(toggle.getAttribute('aria-checked')) };
`;

/**
 * 自动 is what the original `generate` flow selects: the agent resolves the
 * output for the prompt, while 选择比例 stays an explicit setting and the model
 * with it. Picking 视频 or a ratio drops the trigger back to 自定义, so 自动 is
 * applied last and confirmed on the mirror label (the canvas keeps a zero-sized
 * composer whose text variant still renders 自动/自定义).
 */
async function ensureCanvasV0AutoPreference(page) {
  const locateSwitch = `
    const popover = v0SettingsPanel();
    const target = popover ? popover.querySelector('button[role="switch"]') : null;
  `;
  const state = await probeCanvasV0(page, V0_AUTO_SWITCH_PROBE);
  if (state?.detail === 'auto-switch-not-found') {
    throw phaseError(
      'preference',
      'Legacy canvas 生成偏好 panel does not expose the 自动 switch',
      'No generation was submitted. Confirm the 生成偏好 popover opens in the docked 对话 panel and retry.',
    );
  }
  const toggled = !state?.ok;
  if (toggled) {
    await clickCanvasV0Control(page, locateSwitch, V0_AUTO_SWITCH_PROBE, {
      label: '生成偏好 自动 switch',
      marker: 'auto-switch',
    });
  }
  // The mirror label is the state the next phase reads, so require it here too.
  const mirrorDeadline = Date.now() + 3_000;
  let mirror = null;
  while (Date.now() < mirrorDeadline) {
    mirror = await page.evaluate(`(() => {
      ${buildCanvasV0LocatorScript()}
      return { autoEnabled: v0AutoPreference() };
    })()`).catch(() => null);
    if (mirror?.autoEnabled !== false) break;
    await page.sleep(0.4);
  }
  if (mirror?.autoEnabled === false) {
    throw phaseError(
      'preference',
      'Legacy canvas 自动 preference did not stick (the 生成偏好 trigger still reads 自定义)',
      'No generation was submitted. Switch 生成偏好 to 自动 in the docked 对话 panel and retry.',
    );
  }
  return { autoEnabled: true, toggled };
}

export async function configureCanvasV0Generation(page, canonical = {}) {
  const creation = await ensureCanvasV0CreationType(page);
  const settings = await openCanvasV0GenerationSettings(page);

  const videoProbe = radioProbeSource(CANVAS_V0_VIDEO_MODE);
  let videoState = await probeCanvasV0(page, videoProbe);
  if (!videoState?.ok) {
    const locateVideo = `
      const popover = v0SettingsPanel();
      const groups = popover ? [...popover.querySelectorAll('[role="radiogroup"], [class*="lv-radio-group"]')].filter(v0Visible) : [];
      const group = groups.find((node) => (node.innerText || '').includes(${JSON.stringify(CANVAS_V0_VIDEO_MODE)}));
      const target = group ? v0RadioLabel(group, ${JSON.stringify(CANVAS_V0_VIDEO_MODE)}) : null;`;
    videoState = await clickCanvasV0Control(page, locateVideo, videoProbe, {
      label: '生成偏好 video switch',
      marker: 'video-radio',
    });
  }

  const ratio = String(canonical?.ratio || '').trim();
  let ratioMode = 'prompt-only';
  if (ratio && ratio !== '智能') {
    // Switching 图片→视频 re-renders the composer and can close the panel.
    const panelState = await probeCanvasV0(page, V0_POPOVER_PROBE);
    if (!panelState?.ok) {
      await clickCanvasV0Control(page, 'const target = v0SettingsTrigger();', V0_POPOVER_PROBE, {
        label: '生成偏好 trigger (reopen)',
        marker: 'generation-settings-reopen',
      });
    }
    const ratioProbe = radioProbeSource(ratio);
    let ratioState = await probeCanvasV0(page, ratioProbe);
    if (!ratioState?.ok && ratioState?.detail === 'radio-not-found') {
      const offered = await page.evaluate(`(() => {
        ${buildCanvasV0LocatorScript()}
        const popover = v0SettingsPanel();
        if (!popover) return [];
        return [...popover.querySelectorAll('label')].filter(v0Visible).map((node) => (node.innerText || '').trim()).filter(Boolean);
      })()`);
      throw phaseError(
        'controls',
        `Legacy canvas 选择比例 does not offer ${ratio} (offered=${(offered || []).join('/') || 'unknown'})`,
        'No generation was submitted. Pick a ratio the legacy canvas offers (智能/21:9/16:9/4:3/1:1/3:4/9:16) and retry.',
      );
    }
    if (!ratioState?.ok) {
      const locateRatio = `
        const popover = v0SettingsPanel();
        const groups = popover ? [...popover.querySelectorAll('[role="radiogroup"], [class*="lv-radio-group"]')].filter(v0Visible) : [];
        const group = groups.find((node) => (node.innerText || '').includes(${JSON.stringify(ratio)}));
        const target = group ? v0RadioLabel(group, ${JSON.stringify(ratio)}) : null;`;
      ratioState = await clickCanvasV0Control(page, locateRatio, ratioProbe, {
        label: `选择比例 ${ratio}`,
        marker: 'ratio-radio',
      });
    }
    ratioMode = 'settings';
  }

  // 自动 last: the video/ratio clicks above drop the trigger to 自定义.
  const auto = await ensureCanvasV0AutoPreference(page);

  await closeCanvasV0GenerationSettings(page, settings.triggerSelector);
  return {
    creationType: creation.creationType,
    videoMode: true,
    autoEnabled: auto.autoEnabled,
    autoToggled: auto.toggled,
    ratio: ratio || '智能',
    ratioMode,
  };
}

export async function readCanvasV0ComposerState(page) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const composer = v0ComposerRoot();
    const editor = composer ? v0Editor(composer) : null;
    if (!editor) return { ok: false, editorFound: false, textLength: 0, empty: false, references: 0 };
    const text = v0EditorText(editor).replace(/[\\u00a0\\u200b\\s]+/g, '');
    return {
      ok: true,
      editorFound: true,
      textLength: text.length,
      text,
      empty: text.length === 0,
      references: composer ? v0ReferenceItems(composer).length : 0,
    };
  })()`);
}

export async function clearCanvasV0Composer(page, phase = 'clear-initial') {
  const locateEditor = 'const target = (() => { const composer = v0SidecarComposer(); return composer ? v0Editor(composer) : null; })();';
  const marked = await markCanvasV0Control(page, 'prompt-editor', locateEditor);
  if (!marked?.ok) {
    throw phaseError(
      phase,
      `Legacy canvas 对话 panel composer was not found for clearing (${marked?.reason || 'unknown'})`,
      'No generation was submitted. Dock the 对话 panel and retry.',
    );
  }

  // A real click moves DOM focus into the composer; CDP key presses then land
  // in the editor instead of the previously focused toolbar control.
  await page.click(marked.selector).catch(() => null);
  await page.nativeKeyPress('a', ['Ctrl']);
  await page.nativeKeyPress('Backspace');
  await page.sleep(0.3);
  let state = await readCanvasV0ComposerState(page);
  if (!state.empty) {
    await page.nativeKeyPress('a', ['Ctrl']);
    await page.nativeKeyPress('Delete');
    await page.sleep(0.3);
    state = await readCanvasV0ComposerState(page);
  }
  if (!state.empty) {
    await page.evaluate(`(() => {
      ${buildCanvasV0LocatorScript()}
      const composer = v0ComposerRoot();
      const editor = composer ? v0Editor(composer) : null;
      if (!editor) return false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return document.execCommand('delete');
    })()`).catch(() => null);
    await page.sleep(0.3);
    state = await readCanvasV0ComposerState(page);
  }
  if (!state.empty) {
    throw phaseError(
      phase,
      `Legacy canvas composer could not be cleared (editorFound=${state.editorFound}, textLength=${state.textLength}, text=${JSON.stringify(String(state.text || '').slice(0, 40))})`,
      'Clear the visible legacy canvas composer manually, then retry.',
    );
  }
  return state;
}

/**
 * Remove leftover reference attachments left by an earlier draft.
 *
 * The legacy canvas keeps uploaded files outside the prompt document, so
 * clearing the text alone leaves stale references that would be submitted with
 * the next run (canvas-video clears both for the same reason).
 */
export async function clearCanvasV0References(page, phase = 'clear-references') {
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCanvasV0References(page);
    if (last?.panelDocked === false) {
      throw phaseError(
        phase,
        `Legacy canvas 对话 panel closed while clearing references (panelDocked=false)`,
        'No generation was submitted. Dock the 对话 panel and retry.',
      );
    }
    if (Number(last?.count) === 0) return { references: 0 };
    const removed = await page.evaluate(`(() => {
      ${buildCanvasV0LocatorScript()}
      const composer = v0SidecarComposer();
      const items = composer ? v0ReferenceItems(composer) : [];
      const item = items[0];
      if (!item) return { ok: false, reason: 'reference-item-missing' };
      item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const remove = item.querySelector('[class*="remove-button"]') || item.querySelector('button');
      if (!remove) return { ok: false, reason: 'remove-control-missing' };
      remove.click();
      return { ok: true };
    })()`);
    if (!removed?.ok) {
      throw phaseError(
        phase,
        `Legacy canvas reference could not be removed (${removed?.reason || 'unknown'}, remaining=${last?.count ?? 'unknown'})`,
        'Remove the leftover references manually, then retry.',
      );
    }
    await page.sleep(0.4);
  }
  throw phaseError(
    phase,
    `Legacy canvas references could not be cleared (remaining=${last?.count ?? 'unknown'})`,
    'Remove the leftover references manually, then retry.',
  );
}

async function markCanvasV0UploadInput(page, marker) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const sidecar = v0Sidecar();
    if (!sidecar) return { ok: false, reason: 'panel-not-docked' };
    const input = v0UploadInput(sidecar);
    if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'upload-input-missing' };
    input.setAttribute(${JSON.stringify(CANVAS_V0_UPLOAD_INPUT_ATTR)}, ${JSON.stringify(marker)});
    return {
      ok: true,
      selector: 'input[${CANVAS_V0_UPLOAD_INPUT_ATTR}="' + ${JSON.stringify(marker)} + '"]',
      accept: input.getAttribute('accept') || '',
      multiple: input.multiple === true,
    };
  })()`);
}

async function readCanvasV0References(page) {
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const composer = v0SidecarComposer();
    const items = composer ? v0ReferenceItems(composer) : [];
    return {
      panelDocked: v0PanelReady(),
      count: items.length,
      alerts: v0Alerts(),
      states: items.map((item) => ({
        label: (item.getAttribute('data-index') || '') + '',
        pending: /upload|loading|progress|pending/i.test(String(item.className || '')),
        failed: /fail|error/i.test(String(item.className || '')),
      })),
    };
  })()`);
}

async function waitForCanvasV0Reference(page, expectedCount, phase, asset, index) {
  const deadline = Date.now() + CANVAS_V0_UPLOAD_TIMEOUT_MS;
  let last = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    last = await readCanvasV0References(page).catch((error) => ({ count: 0, alerts: [describeError(error)], states: [] }));
    const failure = (last.alerts || []).find((text) => /上传失败|上传出错|不支持|过大|超出|格式|失败|失败，请/.test(text));
    if (failure) {
      throw phaseError(
        phase,
        `Legacy canvas rejected ${asset.label} (${asset.filename}): ${failure}`,
        'No generation was submitted. Fix the reference file and retry.',
        index,
      );
    }
    if (Number(last.count) >= expectedCount) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 1_000) return last;
    } else {
      stableSince = 0;
    }
    await page.sleep(0.4);
  }
  throw phaseError(
    phase,
    `Legacy canvas reference did not appear for ${asset.label} (${asset.filename}); references=${last?.count ?? 'unknown'} expected=${expectedCount}`,
    'No generation was submitted. Confirm the legacy canvas accepts this reference type and retry.',
    index,
  );
}

export async function uploadCanvasV0ReferenceAssets(page, assets, uploads, startAssetIndex = 0) {
  for (let index = startAssetIndex; index < assets.length; index += 1) {
    const asset = assets[index];
    const marker = `upload-${index}`;
    const input = await markCanvasV0UploadInput(page, marker);
    if (!input?.ok) {
      throw phaseError(
        'upload',
        `Could not locate the legacy canvas file input for ${asset.label} (${asset.filename}): ${input?.reason || 'unknown'}`,
        'No generation was submitted. Confirm the 对话 panel is docked with its composer visible, then retry.',
        index,
      );
    }
    try {
      await page.setFileInput([asset.browserPath], input.selector);
    } catch (error) {
      throw phaseError(
        'upload',
        `setFileInput failed for ${asset.label} (${asset.filename}): ${describeError(error)}`,
        'Verify the file is readable by the browser host and retry.',
        index,
      );
    }
    await waitForCanvasV0Reference(page, uploads.length + 1, 'upload', asset, index);
    uploads.push(asset);
  }
  return uploads;
}

export async function composeCanvasV0Prompt(page, agentPrompt) {
  const text = String(agentPrompt || '');
  if (!text.trim()) {
    throw phaseError('prompt', 'Legacy canvas prompt is empty', 'Pass a non-empty --prompt.');
  }
  const focused = await page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const composer = v0SidecarComposer();
    const editor = composer ? v0Editor(composer) : null;
    if (!editor) return { ok: false, reason: v0Sidecar() ? 'editor-not-found' : 'panel-not-docked' };
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: true };
  })()`);
  if (!focused?.ok) {
    throw phaseError(
      'prompt',
      `Could not focus the legacy canvas prompt editor (${focused?.reason || 'unknown'})`,
      'No generation was submitted. Reopen the 对话 panel and retry.',
    );
  }
  if (typeof page.insertText !== 'function') {
    throw phaseError(
      'prompt',
      'No supported native text insertion method is available for the legacy canvas prompt editor',
      'No generation was submitted. Update OpenCLI and retry.',
    );
  }
  await page.insertText(text);
  const expected = normalizeV0EditorText(text);
  const deadline = Date.now() + 8_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCanvasV0ComposerState(page).catch(() => null);
    if (last?.ok && normalizeV0EditorText(last.text).includes(expected)) return { mode: 'insertText' };
    await page.sleep(0.2);
  }
  throw phaseError(
    'prompt',
    `Legacy canvas prompt did not land in the composer (chars=${last?.textLength ?? 'unknown'}, expected=${expected.length})`,
    'No generation was submitted. Retry the run.',
  );
}

export async function collectCanvasV0CheckpointSnapshot(page, canonical, assets = []) {
  const marker = String(canonical?.assetId || '');
  return page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const composer = v0SidecarComposer();
    const sidecar = v0Sidecar();
    const editor = composer ? v0Editor(composer) : null;
    const send = composer ? v0SendButton(composer) : null;
    const marker = ${JSON.stringify(marker)};
    const editorText = v0EditorText(editor);
    const editorTextNormalized = editorText.replace(/[\\u00a0\\u200b\\s]+/g, '');
    const stop = v0StopButton(sidecar || document);
    return {
      surfaceReady: !!composer && !!editor,
      sidecarOpen: !!sidecar,
      composerInSidecar: !!sidecar && !!composer && sidecar.contains(composer),
      editorTextNormalized,
      autoEnabled: v0AutoPreference(),
      referenceCount: composer ? v0ReferenceItems(composer).length : 0,
      assetIdPresent: marker ? editorTextNormalized.includes(marker) : true,
      processingCount: stop ? 1 : 0,
      submitEnabled: send ? !(send.disabled === true || send.getAttribute('aria-disabled') === 'true') : false,
      sendVisible: !!send,
      alerts: v0Alerts(),
    };
  })()`);
}

export async function runCanvasV0ContentCheckpoint(page, canonical, assets = [], options = {}) {
  const snapshot = await collectCanvasV0CheckpointSnapshot(page, canonical, assets);
  const textAnchors = [];
  if (String(canonical?.assetId || '')) textAnchors.push(`资产编号：${canonical.assetId}`);
  if (String(canonical?.prompt || '').trim()) textAnchors.push(String(canonical.prompt).trim());
  const verdict = evaluateCanvasV0Checkpoint(
    { ...snapshot, requireSubmitArmed: options.requireSubmitArmed === true },
    { expectedReferences: assets.length, textAnchors },
  );
  if (!verdict.ok) {
    let hint = 'No generation was submitted. Inspect the visible legacy canvas composer and retry.';
    if (verdict.failures.includes('referenceCount')) {
      hint = 'No generation was submitted. Confirm every reference finished uploading, then retry.';
    } else if (verdict.failures.includes('sidecarOpen') || verdict.failures.includes('composerInSidecar')) {
      hint = 'No generation was submitted. The 对话 panel must stay docked with the prompt inside its composer.';
    }
    const error = phaseError('checkpoint', `Legacy canvas checkpoint failed: ${verdict.failures.join(', ')} (observed=${JSON.stringify(verdict.observed)})`, hint);
    error.checkpoint = verdict;
    throw error;
  }
  return { ...verdict, snapshot };
}

export async function detectCanvasV0SubmitUIConfirmation(page, assetId) {
  const marker = String(assetId || '');
  const snapshot = await page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const marker = ${JSON.stringify(marker)};
    const composer = v0SidecarComposer();
    const sidecar = v0Sidecar();
    const editor = composer ? v0Editor(composer) : null;
    if (!composer || !editor) {
      return { assetIdInComposer: false, assetIdOutsideComposer: false, composerEmpty: false, agentBusy: false, error: sidecar ? 'composer-not-found' : 'panel-not-docked' };
    }
    const editorText = v0EditorText(editor);
    const composerEmpty = editorText.replace(/[\\u00a0\\u200b\\s]+/g, '').length === 0;
    const assetIdInComposer = !!marker && editorText.includes(marker);
    let assetIdOutsideComposer = false;
    if (marker && sidecar) {
      for (const node of [...sidecar.querySelectorAll('div, p, span, li')]) {
        if (!v0Visible(node)) continue;
        if (editor.contains(node) || node.contains(editor)) continue;
        if ((node.innerText || node.textContent || '').includes(marker)) {
          assetIdOutsideComposer = true;
          break;
        }
      }
    }
    return {
      assetIdInComposer,
      assetIdOutsideComposer,
      composerEmpty,
      agentBusy: !!v0StopButton(sidecar || document),
    };
  })()`).catch((error) => ({
    assetIdInComposer: false,
    assetIdOutsideComposer: false,
    composerEmpty: false,
    agentBusy: false,
    error: describeError(error),
  }));
  const confirmed = snapshot?.assetIdOutsideComposer === true && snapshot?.assetIdInComposer !== true;
  return {
    confirmed,
    reason: confirmed ? 'message_bubble_rendered' : 'none',
    ...snapshot,
  };
}

export async function submitCanvasV0PreparedGeneration(page, canonical, options = {}) {
  const assetId = canonical.assetId;
  if (!assetId) {
    throw phaseError(
      'submit',
      'assetId is required for legacy canvas submit ACK validation',
      'Re-run without --submit 1 so an assetId is generated by the command.',
    );
  }
  assertCanvasV0PageCapabilities(page);

  if (typeof page.startNetworkCapture !== 'function' || typeof page.readNetworkCapture !== 'function') {
    throw phaseError(
      'submit-capture-unavailable',
      'Browser driver does not support network capture required for legacy canvas submit ACK',
      'Update OpenCLI so the canvas send request can be classified.',
    );
  }

  const captureStarted = await page.startNetworkCapture(CANVAS_V0_CAPTURE_PATTERN).catch(() => false);
  if (!captureStarted) {
    throw phaseError(
      'submit-capture-unavailable',
      'Network capture could not be started for the legacy canvas submit ACK',
      'Update OpenCLI and retry; nothing was submitted.',
    );
  }

  let drained;
  try {
    drained = await page.readNetworkCapture();
    if (!Array.isArray(drained)) throw new Error('network capture drain returned a non-array payload');
  } catch (error) {
    throw phaseError(
      'submit-capture-unavailable',
      `Pre-click legacy canvas network capture drain failed: ${describeError(error)}`,
      'Update OpenCLI and retry; nothing was submitted.',
    );
  }
  const priorAck = classifyCanvasSubmitAck({ entries: drained, assetId, timedOut: true });
  if (priorAck.kind === 'confirmed') {
    return {
      accepted: true,
      confirmation: 'ack_confirmed',
      sessionId: priorAck.sessionId || '',
      submitRequestCount: 1,
    };
  }

  const preClickUI = await detectCanvasV0SubmitUIConfirmation(page, assetId);
  if (preClickUI.confirmed) {
    return {
      accepted: true,
      confirmation: 'ui_confirmed',
      sessionId: '',
      submitRequestCount: 0,
      uiEvidence: preClickUI.reason,
    };
  }
  if (preClickUI.assetIdInComposer !== true) {
    throw phaseError(
      'submit-unconfirmed',
      `Legacy canvas prompt assetId was not in the docked 对话 composer before the send click (panel=${preClickUI.error || 'not-docked'})`,
      'No generation was submitted. Re-run the preparation and retry.',
    );
  }

  // Sending happens inside the 对话 panel, so the panel must still be docked and
  // the composer must still hold the prepared prompt at this point.
  const readiness = await probeJimengCanvasV0Surface(page);
  const readinessVerdict = evaluateCanvasV0SubmitReadiness({
    editorHasPrompt: true,
    sendEnabled: readiness.sendEnabled,
    sidecarOpen: readiness.sidecarOpen,
    composerInSidecar: readiness.composerInSidecar,
  });
  if (!readinessVerdict.ok) {
    throw phaseError(
      'submit-button-missing',
      `Legacy canvas 对话 panel is not ready for submit (${readinessVerdict.failures.join(', ')})`,
      'No generation was submitted. Reopen the 对话 panel with the prepared prompt and retry.',
    );
  }

  const marked = await page.evaluate(`(() => {
    ${buildCanvasV0LocatorScript()}
    const sidecar = v0Sidecar();
    const composer = v0SidecarComposer();
    const send = composer ? v0SendButton(composer) : null;
    if (!send) return { ok: false, reason: sidecar ? 'send-button-not-found' : 'panel-not-docked' };
    if (!sidecar || !sidecar.contains(send)) return { ok: false, reason: 'send-button-outside-panel' };
    if (send.disabled === true || send.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'send-button-disabled' };
    }
    send.setAttribute(${JSON.stringify(CANVAS_V0_TARGET_ATTR)}, 'send');
    return { ok: true };
  })()`);
  if (!marked?.ok) {
    throw phaseError(
      'submit-button-missing',
      `Legacy canvas 对话 panel send button is not usable after the checkpoint (${marked?.reason || 'unknown'})`,
      'No generation was submitted. Confirm the panel composer holds the prepared prompt and retry.',
    );
  }

  let clickError = null;
  try {
    await page.click(`[${CANVAS_V0_TARGET_ATTR}="send"]`);
  } catch (error) {
    clickError = error;
  }

  const requestedTimeoutMs = Number(options.timeoutMs ?? CANVAS_V0_SEND_ACK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(0, requestedTimeoutMs) : CANVAS_V0_SEND_ACK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let uiAck = null;
  let finalAck = null;

  while (Date.now() < deadline) {
    await page.sleep(0.5);
    uiAck = await detectCanvasV0SubmitUIConfirmation(page, assetId).catch(() => null);
    if (uiAck?.confirmed) break;
  }

  let capturedEntries = [];
  let captureReadError = null;
  try {
    capturedEntries = await page.readNetworkCapture();
    if (!Array.isArray(capturedEntries)) throw new Error('network capture read returned a non-array payload');
  } catch (error) {
    captureReadError = error;
  }
  if (!captureReadError) {
    try {
      finalAck = classifyCanvasSubmitAck({ entries: capturedEntries, assetId, timedOut: true });
    } catch (error) {
      captureReadError = error;
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
    const error = new Error(`Legacy canvas send was rejected (code: ${finalAck.errorCode}, msg: ${finalAck.errorMsg || 'rejected'})`);
    error.phase = 'submit-rejected';
    error.retryable = false;
    error.nonRetryable = true;
    error.hint = 'The server rejected the request explicitly; do not retry.';
    throw error;
  }

  if (!uiAck?.confirmed) {
    uiAck = await detectCanvasV0SubmitUIConfirmation(page, assetId).catch(() => null);
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
    throw phaseError(
      'submit-unconfirmed',
      `Legacy canvas network capture could not be read after send (${describeError(captureReadError)})`,
      'The request may have been accepted: inspect the canvas manually; do not retry blindly.',
    );
  }

  if (
    finalAck?.kind === 'not_sent'
    && uiAck?.assetIdInComposer === true
    && uiAck?.assetIdOutsideComposer !== true
  ) {
    throw phaseError(
      'submit-not-sent',
      `Legacy canvas send click did not move the prompt or trigger a captured request${clickError ? ` (${describeError(clickError)})` : ''}`,
      'No generation was submitted. Retry the run.',
    );
  }

  throw phaseError(
    'submit-unconfirmed',
    finalAck?.reason || (clickError ? `send click failed: ${describeError(clickError)}` : 'Legacy canvas send request or page state could not be confirmed safely'),
    'The request may have been accepted: inspect the canvas manually and do not retry blindly.',
  );
}

/**
 * `canvas-v0-create`: blank legacy canvas only.
 */
export async function runJimengCanvasV0Create(page, canonical = {}) {
  assertCanvasV0PageCapabilities(page);
  const created = await createCanvasV0Project(page, canonical);
  await openCanvasV0Workspace(page, created.canvasUrl);
  await waitForCanvasV0Surface(page);
  return [{
    status: created.status,
    projectId: created.projectId,
    draftId: created.draftId,
    canvasTitle: created.canvasTitle,
    canvasUrl: created.canvasUrl,
  }];
}

export async function prepareJimengCanvasV0Ask(page, canonical, preparedAssets, options = {}) {
  assertCanvasV0PageCapabilities(page);

  const uploads = [];
  let retriesUsed = 0;
  let priorInPlaceRetry = false;
  let startAssetIndex = 0;
  let activeProjectId = canonical.projectId || '';
  let initialUrl = canonical.canvasMode === 'new'
    ? ''
    : buildCanvasV0Url(canonical.canvas, { projectId: canonical.projectId });

  if (canonical.canvasMode === 'new') {
    const created = await createCanvasV0Project(page, canonical);
    activeProjectId = created.projectId;
    initialUrl = created.canvasUrl;
  }

  await openCanvasV0Workspace(page, initialUrl);

  while (true) {
    try {
      await waitForCanvasV0Surface(page);
      // The prompt is typed into the 对话 panel, so the panel is docked up front
      // and re-asserted after every phase that can re-render the composer.
      await ensureCanvasV0SidecarOpen(page);
      await runCanvasV0PreInputControlsCheck(page, { requireUploadControl: preparedAssets.length > 0 });
      await configureCanvasV0Generation(page, canonical);
      await ensureCanvasV0SidecarOpen(page);

      if (startAssetIndex === 0) {
        await clearCanvasV0Composer(page, 'clear-initial');
        await clearCanvasV0References(page, 'clear-initial');
      }

      await ensureCanvasV0SidecarOpen(page);
      await uploadCanvasV0ReferenceAssets(page, preparedAssets, uploads, startAssetIndex);
      await ensureCanvasV0SidecarOpen(page);
      await composeCanvasV0Prompt(page, canonical.agentPrompt);
      await ensureCanvasV0SidecarOpen(page);

      const checkpoint = await runCanvasV0ContentCheckpoint(page, canonical, uploads, {
        requireSubmitArmed: !!canonical.submit,
      });

      let submitted = false;
      let submitResult = null;
      if (canonical.submit) {
        submitResult = await submitCanvasV0PreparedGeneration(page, canonical, options);
        submitted = submitResult?.accepted === true;
        if (!submitted) {
          throw phaseError(
            'submit-unconfirmed',
            'Legacy canvas submit returned without acceptance confirmation',
            'The request may have been accepted: inspect the canvas manually and do not retry blindly.',
          );
        }
        // Best effort: the accepted generation keeps running inside the panel.
        await ensureCanvasV0SidecarOpen(page).catch(() => null);
      }

      const finalHref = await page.evaluate(() => location.href).catch(() => '');
      const resolvedProjectId = activeProjectId || canonical.projectId || '';
      const finalCanvasUrl = resolvedProjectId
        ? buildCanvasV0Url({ mode: 'existing', value: resolvedProjectId, projectId: resolvedProjectId }, { projectId: resolvedProjectId })
        : finalHref;
      const finalSurface = await probeJimengCanvasV0Surface(page).catch(() => null);
      const panelOpen = finalSurface?.panelReady === true && finalSurface?.editorReady === true;
      // A prepared draft is only useful when the 对话 panel is still docked.
      // After an accepted submit the panel is best effort, because the accepted
      // generation already runs on the server.
      if (!panelOpen && !submitted) {
        throw phaseError(
          'sidecar',
          `Legacy canvas 对话 panel is closed when the run finishes (sidecarOpen=${finalSurface?.sidecarOpen === true}, composerInSidecar=${finalSurface?.composerInSidecar === true})`,
          'No generation was submitted. Reopen the 对话 panel and retry.',
        );
      }

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
        panelOpen,
        confirmation: submitResult?.confirmation ?? 'none',
        sessionId: submitResult?.sessionId ?? '',
        submitRequestCount: submitResult?.submitRequestCount ?? (submitted ? 1 : 0),
      };
    } catch (error) {
      const failure = {
        message: describeError(error),
        hint: typeof error?.hint === 'string' ? error.hint : 'Inspect the visible legacy canvas and retry.',
        phase: typeof error?.phase === 'string' ? error.phase : 'surface',
        failedAssetIndex: Number.isInteger(error?.failedAssetIndex) ? error.failedAssetIndex : uploads.length,
        retryable: error?.retryable !== false && !error?.nonRetryable,
      };
      const surface = await probeJimengCanvasV0Surface(page).catch(() => ({ ready: false, editorReady: false }));
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
        let prefix = 'JIMENG_CANVAS_V0_PREPARE_FAILED';
        let hint = failure.hint;
        if (isUnconfirmed) {
          prefix = 'JIMENG_CANVAS_V0_SUBMIT_UNCONFIRMED';
          hint = `${failure.hint} 可能已受理时请勿重试，手动核对画布。`;
        } else if (isRejected) {
          prefix = 'JIMENG_CANVAS_V0_SUBMIT_REJECTED';
          hint = `${failure.hint} 服务端已明确拒绝，请勿重试。`;
        } else if (isSubmitFailure) {
          prefix = 'JIMENG_CANVAS_V0_SUBMIT_FAILED';
          hint = `No generation was submitted. ${failure.hint}`;
        }
        throw new CommandExecutionError(`${prefix}: ${failure.message}`, hint);
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
      await openCanvasV0Workspace(page, initialUrl);
    }
  }
}

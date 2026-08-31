import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

import {
  JIMENG_GENERATE_URL,
  assertSubmitCapabilities,
  buildEnterKeyEvents,
  buildMentionCandidateExpression,
  buildMentionSegments,
  buildWorkspaceUrl,
  chooseRetryPlan,
  findSpacedNeedleRange,
  inspectComposerAssetIdState,
  isMentionChipAppended,
  isStrictMentionCommit,
  mentionTextMatchesVariant,
  normalizePromptValidationLines,
  prepareJimengAgentAsk,
  resolveMentionDebugOptions,
  submitPreparedGeneration,
} from '../src/agent-dom.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const agentDomSource = readFileSync(new URL('../src/agent-dom.js', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startIndex = agentDomSource.indexOf(start);
  const endIndex = agentDomSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return agentDomSource.slice(startIndex, endIndex);
}

const assets = [
  {
    label: '图片1',
    filename: 'hero.png',
    mentionName: 'hero',
    browserPath: 'C:\\assets\\hero.png',
  },
  {
    label: '视频1',
    filename: 'move.mp4',
    mentionName: 'move',
    browserPath: 'C:\\assets\\move.mp4',
  },
];

describe('jimeng-agent/agent-dom — workspace URL', () => {
  it('builds the visible Jimeng generate workspace URL and encodes the workspace value', () => {
    expect(buildWorkspaceUrl('  id/with space  ')).toBe(
      `${JIMENG_GENERATE_URL}?workspace=id%2Fwith%20space`,
    );
  });

  it('rejects a missing or blank workspace before browser work', () => {
    expect(() => buildWorkspaceUrl('')).toThrow(ArgumentError);
    expect(() => buildWorkspaceUrl('  ')).toThrow(ArgumentError);
    expect(() => buildWorkspaceUrl(null)).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/agent-dom — rich mention segmentation', () => {
  it('preserves ordinary text while replacing every resource placeholder with its asset', () => {
    const parts = buildMentionSegments('start @图片1 then @视频1 end', assets);
    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'mention',
      'text',
      'mention',
      'text',
    ]);
    expect(parts[1]).toMatchObject({ label: '图片1', asset: assets[0] });
    expect(parts[3]).toMatchObject({ label: '视频1', asset: assets[1] });
    expect(parts[0].value).toBe('start ');
    expect(parts[4].value).toBe(' end');
  });

  it('keeps repeated references as separate rich-mention operations', () => {
    const parts = buildMentionSegments('@图片1 / @图片1', assets);
    const mentions = parts.filter((part) => part.type === 'mention');
    expect(mentions).toHaveLength(2);
    expect(mentions[0].asset).toBe(assets[0]);
    expect(mentions[1].asset).toBe(assets[0]);
  });

  it('preserves line-boundary and adjacent mentions without inventing text segments', () => {
    const parts = buildMentionSegments('@视频1\n@图片1@视频1', assets);

    expect(parts.map((part) => part.type)).toEqual([
      'mention',
      'newline',
      'mention',
      'mention',
    ]);
    expect(parts.filter((part) => part.type === 'mention').map((part) => part.label)).toEqual([
      '视频1',
      '图片1',
      '视频1',
    ]);
  });

  it('does not invent a plaintext fallback when a required upload is absent', () => {
    expect(() => buildMentionSegments('@音频1', assets)).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/agent-dom — Enter event descriptors', () => {
  it('builds complete Chromium Enter events recognized by ProseMirror keymaps', () => {
    expect(buildEnterKeyEvents()).toEqual([
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
        text: '\r',
        unmodifiedText: '\r',
      },
      {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
      },
    ]);
  });

  it('adds Shift modifiers for soft-break Enter events', () => {
    expect(buildEnterKeyEvents(8)).toEqual([
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 8,
        text: '\r',
        unmodifiedText: '\r',
      },
      {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 8,
      },
    ]);
  });
});

describe('jimeng-agent/agent-dom — mention input safety', () => {
  function createCandidateHarness(candidates, marker = 'candidate-marker') {
    class HTMLElement {}
    const createElement = (candidate) => {
      const element = new HTMLElement();
      element.innerText = candidate.text;
      element.textContent = candidate.text;
      element.className = candidate.className || 'mention-item';
      element.clicked = 0;
      element.isConnected = true;
      element.attributes = new Map();
      if (candidate.attributes) {
        for (const [name, value] of Object.entries(candidate.attributes)) {
          element.attributes.set(name, value);
        }
      }
      element.getAttribute = (name) => (
        name === 'aria-label'
          ? candidate.ariaLabel || ''
          : element.attributes.get(name) ?? null
      );
      element.setAttribute = (name, value) => {
        element.attributes.set(name, value);
      };
      element.removeAttribute = (name) => {
        element.attributes.delete(name);
      };
      element.getBoundingClientRect = () => ({
        left: 10,
        top: 20,
        width: 100,
        height: 40,
      });
      element.click = () => {
        element.clicked += 1;
      };
      return element;
    };
    const elements = candidates.map(createElement);
    const document = {
      querySelectorAll: (selector) => (
        selector === `[data-opencli-jimeng-target="${marker}"]`
          ? elements.filter(
            (element) => element.getAttribute('data-opencli-jimeng-target') === marker,
          )
          : elements
      ),
      querySelector: () => null,
    };
    const window = {
      getComputedStyle: () => ({
        display: 'block',
        visibility: 'visible',
      }),
    };
    return {
      elements,
      run(expression) {
        return Function(
          'document',
          'window',
          'HTMLElement',
          `return ${expression}`,
        )(document, window, HTMLElement);
      },
      add(candidate) {
        const element = createElement(candidate);
        elements.push(element);
        return element;
      },
      replaceWithClone(index) {
        const original = elements[index];
        const clone = createElement({
          text: original.innerText,
          className: original.className,
          attributes: Object.fromEntries(original.attributes),
        });
        original.isConnected = false;
        elements[index] = clone;
        return clone;
      },
    };
  }

  it('uses one atomic DOM click without Escape or bare Enter in the normal mention path', () => {
    const insertion = sourceBetween(
      'async function insertRichMention(',
      '/** True if the composer has an orphan bare',
    );
    const candidateExpression = sourceBetween(
      'function buildMentionCandidateExpression(',
      'async function inspectMentionCandidateTarget(',
    );

    expect(insertion).not.toMatch(/(?:pressKeyWithGap|nativeKeyPress)\(page,\s*['"]Escape['"]/);
    expect(insertion).not.toContain('selectMentionCandidateWithGuardedEnter');
    expect(insertion).not.toContain('dispatchEnterKey(page');
    expect(insertion).toContain('openMentionPickerViaToolbar(page)');
    expect(insertion).toContain('if (!uniqueBeforeLabel?.ok)');
    expect(insertion).toContain('page.evaluate(buildMentionCandidateExpression(asset, marker, true))');
    expect(candidateExpression).toContain('matches.length !== 1');
    expect(candidateExpression).toContain('approved === matches[0].option');
    expect(candidateExpression).toContain('matches[0].option.click();');
    expect(candidateExpression).not.toContain('Input.dispatchKeyEvent');
    expect(candidateExpression).not.toMatch(/nativeKeyPress\(['"]Enter['"]/);
  });

  it('injects visible into the label-picker-missing diagnostic so a closed picker cannot crash prepare', () => {
    const insertion = sourceBetween(
      'async function insertRichMention(',
      '/** True if the composer has an orphan bare',
    );
    const logAt = insertion.indexOf('mention label picker missing');
    expect(logAt).toBeGreaterThanOrEqual(0);
    const evalAt = insertion.lastIndexOf('page.evaluate', logAt);
    expect(evalAt).toBeGreaterThanOrEqual(0);
    const diagnostic = insertion.slice(evalAt, logAt);
    expect(diagnostic).toContain('buildPromptEditorLocatorScript()');
    expect(diagnostic).toContain('.filter(visible)');
  });

  it('clicks only the same uniquely matched candidate marked by the preflight scan', () => {
    const asset = { label: '图片1', filename: 'hero.png', mentionName: 'hero' };
    const marker = 'candidate-marker';
    const harness = createCandidateHarness([{ text: '图片1 hero.png' }], marker);
    expect(harness.run(buildMentionCandidateExpression(asset, marker)))
      .toMatchObject({ ok: true, status: 'ready' });
    expect(harness.elements[0].clicked).toBe(0);

    expect(harness.run(buildMentionCandidateExpression(asset, marker, true)))
      .toMatchObject({ ok: true, status: 'clicked' });
    expect(harness.elements[0].clicked).toBe(1);
    expect(harness.elements[0].getAttribute('data-opencli-jimeng-target')).toBeNull();
  });

  it('refuses to click when the marked DOM node was replaced even with copied attributes', () => {
    const asset = { label: '图片1', filename: 'hero.png', mentionName: 'hero' };
    const marker = 'candidate-marker';
    const harness = createCandidateHarness([{ text: '图片1 hero.png' }], marker);
    expect(harness.run(buildMentionCandidateExpression(asset, marker))).toMatchObject({ ok: true });
    const clone = harness.replaceWithClone(0);

    expect(harness.run(buildMentionCandidateExpression(asset, marker, true)))
      .toMatchObject({ ok: false, status: 'candidate-changed' });
    expect(clone.clicked).toBe(0);
  });

  it('matches mention labels as whole tokens, not prefixes', () => {
    expect(mentionTextMatchesVariant('图片1 hero.png', '图片1')).toBe(true);
    expect(mentionTextMatchesVariant('图片10 scene.png', '图片1')).toBe(false);
    expect(mentionTextMatchesVariant('音频3 voice.mp3', '音频3')).toBe(true);
  });

  it('does not treat 图片10 as a unique match for 图片1', () => {
    const asset = { label: '图片1', filename: 'hero.png', mentionName: 'hero' };
    const marker = 'candidate-marker';
    const harness = createCandidateHarness([
      { text: '图片10 scene.png' },
      { text: '图片1 hero.png' },
    ], marker);
    expect(harness.run(buildMentionCandidateExpression(asset, marker)))
      .toMatchObject({ ok: true, status: 'ready' });
    expect(harness.elements[1].getAttribute('data-opencli-jimeng-target')).toBe(marker);
  });

  it('refuses to click when the final candidate scan is no longer unique', () => {
    const asset = { label: '音频1', filename: 'voice.mp3', mentionName: 'voice' };
    const marker = 'candidate-marker';
    const harness = createCandidateHarness([{ text: '音频1 voice.mp3' }], marker);
    expect(harness.run(buildMentionCandidateExpression(asset, marker))).toMatchObject({ ok: true });
    harness.add({ text: 'voice duplicate option' });

    expect(harness.run(buildMentionCandidateExpression(asset, marker, true)))
      .toMatchObject({ ok: false, count: 2 });
    expect(harness.elements.every((element) => element.clicked === 0)).toBe(true);
  });

  it('requires one ordered rich-chip append before accepting a mention commit', () => {
    const asset = { label: '图片1', filename: 'hero.png', mentionName: 'hero' };
    const before = {
      hasRaw: false,
      menuVisible: false,
      mentionLabels: ['图片1'],
    };
    const committed = {
      hasRaw: false,
      menuVisible: false,
      mentionLabels: ['图片1', '图片1'],
    };
    expect(isStrictMentionCommit(
      before,
      committed,
      { status: 'clicked' },
      asset,
      2,
    )).toBe(true);

    expect(isStrictMentionCommit(
      before,
      before,
      { status: 'clicked' },
      asset,
      2,
    )).toBe(false);
    expect(isStrictMentionCommit(
      before,
      { ...committed, hasRaw: true },
      { status: 'clicked' },
      asset,
      2,
    )).toBe(false);
    expect(isStrictMentionCommit(
      before,
      { ...committed, menuVisible: true },
      { status: 'clicked' },
      asset,
      2,
    )).toBe(false);
    expect(isStrictMentionCommit(
      before,
      { ...committed, mentionLabels: ['图片1', '视频1'] },
      { status: 'clicked' },
      asset,
      2,
    )).toBe(false);
    expect(isStrictMentionCommit(
      before,
      { ...committed, mentionLabels: ['图片1', '图片10'] },
      { status: 'clicked' },
      asset,
      2,
    )).toBe(false);
    expect(isStrictMentionCommit(
      before,
      committed,
      { status: 'candidate-changed' },
      asset,
      2,
    )).toBe(false);
  });

  it('treats an ordered chip append as success even when leftover raw @query remains to be stripped', () => {
    const asset = { label: '图片2', filename: 'scene.png', mentionName: 'scene' };
    const before = {
      hasRaw: true,
      menuVisible: false,
      mentionLabels: ['图片1'],
    };
    const after = {
      hasRaw: true,
      menuVisible: false,
      mentionLabels: ['图片1', '图片2'],
    };
    expect(isMentionChipAppended(before, after, asset, 2)).toBe(true);
    expect(isStrictMentionCommit(before, after, { status: 'clicked' }, asset, 2)).toBe(false);
    expect(isStrictMentionCommit(
      before,
      { ...after, hasRaw: false },
      { status: 'clicked' },
      asset,
      2,
    )).toBe(true);
  });

  it('strips leftover raw mention query after the chip is appended instead of failing the commit', () => {
    const wait = sourceBetween(
      'async function waitForMentionCommit(',
      'async function stripLeftoverRawMentionQuery(',
    );
    expect(wait).toContain('isMentionChipAppended(before, after, asset, expectedMentionCount)');
    expect(wait).toContain('stripLeftoverRawMentionQuery(page, asset)');
    expect(wait).toContain('stripAttempts < 3');
    expect(wait).not.toContain('after?.hasRaw');
  });

  it('finds leftover @图片N even when Jimeng wraps the typed query across a line break', () => {
    expect(findSpacedNeedleRange('以@图片2为环境', '@图片2')).toEqual({ start: 1, end: 5 });
    expect(findSpacedNeedleRange('以@图\n片2为环境', '@图片2')).toEqual({ start: 1, end: 6 });
    expect(findSpacedNeedleRange('以@图\n片2 图片2', '@图片2')).toEqual({ start: 1, end: 6 });
    expect(findSpacedNeedleRange('没有这个标签', '@图片2')).toBeNull();
  });

  it('treats any visible resource option as an open mention picker', () => {
    const stateReader = sourceBetween(
      'async function getMentionState(',
      'export function isStrictMentionCommit(',
    );
    const menuStart = stateReader.indexOf('const menuVisible =');
    const menuEnd = stateReader.indexOf('return {', menuStart);
    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(menuEnd).toBeGreaterThan(menuStart);
    const menuBlock = stateReader.slice(menuStart, menuEnd);
    expect(menuBlock).toContain('/(?:图片|视频|音频)\\\\d+/.test(text)');
    expect(menuBlock).not.toContain('variants.some');
  });

  it('keeps Escape in the existing failed-attempt rewind path', () => {
    const rewind = sourceBetween(
      'async function rewindMentionKeystrokes(',
      '/**\n * Pure DOM read of the mention picker.',
    );
    expect(rewind).toContain("pressKeyWithGap(page, 'Escape', 0.12)");
  });

  it('clears the composer without sending Escape that can collapse the dock', () => {
    const clear = sourceBetween(
      'async function clearComposer(',
      'async function getComposerClearState(',
    );
    expect(clear).not.toMatch(/nativeKeyPress\(['"]Escape['"]/);
    expect(clear).toContain("nativeKeyPress('a', ['Ctrl'])");
    expect(clear).toContain("nativeKeyPress('Backspace')");
  });

  it('attributes upload failures without reading historical document body text', () => {
    const snapshot = sourceBetween(
      'async function collectDockReferenceSnapshot(',
      '/**\n * Visible page health snapshot.',
    );
    const wait = sourceBetween(
      'async function waitForUploadCompletion(',
      'async function fillPromptWithRichMentions(',
    );
    expect(snapshot).not.toContain('document.body.innerText');
    expect(snapshot).not.toContain('raw.bodyText');
    expect(wait).toContain(
      'observeCurrentUploadFailure({',
    );
    expect(wait).not.toContain('snap.bodyText');
    expect(snapshot).toContain('registry?.[id] === el');
  });

  it('accepts a collapsed-strip removal when the visible card count stays constant', () => {
    const clear = sourceBetween(
      'const deadline = Date.now() + 3_000;',
      '// Keep the pointer away from the strip/history',
    );
    expect(clear).toContain('identityStillVisible');
    expect(clear).toContain('after.count < before.count || !identityStillVisible');
    expect(clear).toContain('reference identity remained');
  });
});

describe('jimeng-agent/agent-dom — prompt structure validation', () => {
  it('preserves empty lines while normalizing mention markers and incidental whitespace', () => {
    expect(normalizePromptValidationLines('prefix\n\n@图片1 作为参考\n@视频1')).toEqual([
      'prefix',
      '',
      '图片1作为参考',
      '视频1',
    ]);
  });
});

describe('jimeng-agent/agent-dom — retry policy', () => {
  it('stops when the configured retry budget is exhausted', () => {
    expect(chooseRetryPlan({
      retriesUsed: 0,
      retryBudget: 0,
      priorInPlaceRetry: false,
      errorPhase: 'upload',
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'stop' });
  });

  it('prefers exactly one in-page resume for a healthy failed upload', () => {
    expect(chooseRetryPlan({
      retriesUsed: 0,
      retryBudget: 2,
      priorInPlaceRetry: false,
      errorPhase: 'upload',
      failedAssetIndex: 1,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'resume', startAssetIndex: 1 });
  });

  it('uses a fresh workspace for unrecoverable state or after an in-page retry', () => {
    const common = {
      retriesUsed: 0,
      retryBudget: 2,
      errorPhase: 'upload',
      failedAssetIndex: 0,
    };
    expect(chooseRetryPlan({
      ...common,
      priorInPlaceRetry: false,
      surface: { ready: false, fileInputCount: 0 },
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });
    expect(chooseRetryPlan({
      ...common,
      priorInPlaceRetry: true,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });
    expect(chooseRetryPlan({
      ...common,
      priorInPlaceRetry: false,
      errorPhase: 'mention',
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });
  });

  it('forces a full reload for clear failures', () => {
    const base = {
      retriesUsed: 0,
      retryBudget: 2,
      priorInPlaceRetry: false,
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    };
    expect(chooseRetryPlan({
      ...base,
      errorPhase: 'clear-initial',
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });
  });

  it('stops immediately for unconfirmed or rejected submit failures even with retry budget > 0', () => {
    const base = {
      retriesUsed: 0,
      retryBudget: 3,
      priorInPlaceRetry: false,
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    };
    expect(chooseRetryPlan({ ...base, errorPhase: 'submit-unconfirmed' })).toEqual({ kind: 'stop' });
    expect(chooseRetryPlan({ ...base, errorPhase: 'submit-rejected' })).toEqual({ kind: 'stop' });
    expect(chooseRetryPlan({ ...base, errorPhase: 'submit-capture-unavailable' })).toEqual({ kind: 'stop' });
    expect(chooseRetryPlan({ ...base, errorPhase: 'submit' })).toEqual({ kind: 'stop' });
    expect(chooseRetryPlan({ ...base, retryable: false })).toEqual({ kind: 'stop' });
  });

  it('allows safe fresh retry for submit-button-missing and proven submit-not-sent when retry budget remains', () => {
    expect(chooseRetryPlan({
      retriesUsed: 0,
      retryBudget: 2,
      priorInPlaceRetry: false,
      errorPhase: 'submit-button-missing',
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });

    expect(chooseRetryPlan({
      retriesUsed: 0,
      retryBudget: 2,
      priorInPlaceRetry: false,
      errorPhase: 'submit-not-sent',
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'fresh', startAssetIndex: 0 });

    expect(chooseRetryPlan({
      retriesUsed: 2,
      retryBudget: 2,
      priorInPlaceRetry: false,
      errorPhase: 'submit-not-sent',
      failedAssetIndex: 0,
      surface: { ready: true, fileInputCount: 1 },
    })).toEqual({ kind: 'stop' });
  });
});

describe('jimeng-agent/agent-dom — mention debug options', () => {
  it('keeps mention diagnostics disabled unless explicitly requested', () => {
    expect(resolveMentionDebugOptions({})).toEqual({
      enabled: false,
      sleepMs: 0,
      artifactRoot: null,
    });
  });

  it('parses an explicit visual pause and artifact root for one-click diagnostics', () => {
    expect(resolveMentionDebugOptions({
      OPENCLI_JIMENG_MENTION_DEBUG: 'true',
      OPENCLI_JIMENG_MENTION_DEBUG_SLEEP_MS: '2500',
      OPENCLI_JIMENG_MENTION_DEBUG_ROOT: '/tmp/jimeng-debug',
    })).toEqual({
      enabled: true,
      sleepMs: 2500,
      artifactRoot: '/tmp/jimeng-debug',
      stopPhase: 'after-click',
    });
  });

  it('rejects an unsafe or malformed debug pause', () => {
    expect(() => resolveMentionDebugOptions({
      OPENCLI_JIMENG_MENTION_DEBUG: '1',
      OPENCLI_JIMENG_MENTION_DEBUG_SLEEP_MS: '30001',
    })).toThrow(ArgumentError);
  });

  it('supports stopping before the candidate click for a manual comparison', () => {
    expect(resolveMentionDebugOptions({
      OPENCLI_JIMENG_MENTION_DEBUG: '1',
      OPENCLI_JIMENG_MENTION_DEBUG_STOP: 'before-click',
    })).toMatchObject({
      enabled: true,
      stopPhase: 'before-click',
    });
  });
});

describe('jimeng-agent/agent-dom — submit ACK runtime & safety', () => {
  function createSubmitPageMock({
    startNetworkCaptureOk = true,
    capturedEntries = [],
    drainEntries = [],
    readError = null,
    drainError = null,
    sleepErrorAfterClick = null,
    buttonCount = 1,
    pageState = { assetIdInComposer: true, assetIdOutsideComposer: false },
  } = {}) {
    const keyPresses = [];
    const clicks = [];
    let startCaptureCalledWith = null;
    let readCount = 0;
    let simulatedTime = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => simulatedTime);

    const page = {
      startNetworkCapture: vi.fn(async (pattern) => {
        startCaptureCalledWith = pattern;
        if (startNetworkCaptureOk instanceof Error) throw startNetworkCaptureOk;
        return Boolean(startNetworkCaptureOk);
      }),
      readNetworkCapture: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          if (drainError) throw drainError;
          return drainEntries;
        }
        if (readError) throw readError;
        return typeof capturedEntries === 'function' ? capturedEntries(readCount - 1) : capturedEntries;
      }),
      evaluate: vi.fn(async (expr) => {
        if (expr.includes('submit-button')) {
          if (buttonCount === 0) return { ok: false, count: 0 };
          return { ok: true, count: buttonCount };
        }
        if (expr.includes('assetIdInComposer')) {
          return pageState;
        }
        return { ok: true };
      }),
      click: vi.fn(async (sel) => {
        clicks.push(sel);
        return { ok: true };
      }),
      sleep: vi.fn(async (seconds) => {
        if (sleepErrorAfterClick && clicks.length > 0) throw sleepErrorAfterClick;
        simulatedTime += Math.max(10, Math.round((seconds || 0.5) * 1000));
      }),
      nativeKeyPress: vi.fn(async (key) => {
        keyPresses.push(key);
      }),
      get keyPresses() { return keyPresses; },
      get clicks() { return clicks; },
      get startCaptureCalledWith() { return startCaptureCalledWith; },
      get readCount() { return readCount; },
    };
    return page;
  }

  const ASSET_ID = 'b7e4f19a2c0d5e68';
  const SUCCESS_ENTRY = {
    url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
    method: 'POST',
    status: 200,
    requestBody: JSON.stringify({
      conversation_id: '7488349283742819840',
      prompt: `资产编号：${ASSET_ID}`,
    }),
    responseBody: `event: handshake\ndata: {"thread_id":"7488349283742819842","conversation_id":"7488349283742819840"}\n\nevent: stream_complete\ndata: {"success":true,"error_code":0}\n\n`,
  };

  it('validates submit capabilities before attempting network capture', () => {
    expect(() => assertSubmitCapabilities({ startNetworkCapture: vi.fn(), readNetworkCapture: vi.fn() })).not.toThrow();
    expect(() => assertSubmitCapabilities({})).toThrow(/Missing page capability for submit/);
  });

  it('confirms submission on valid SSE ACK without pressing Escape', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [SUCCESS_ENTRY],
    });

    const result = await submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      threadId: '7488349283742819842',
      conversationId: '7488349283742819840',
      submitRequestCount: 1,
    });
    expect(page.startNetworkCapture).toHaveBeenCalledWith(expect.stringContaining('conversation'));
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.keyPresses).not.toContain('Escape');
  });

  it('fails before clicking when startNetworkCapture fails or is unavailable', async () => {
    const page = createSubmitPageMock({ startNetworkCaptureOk: false });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500 })).rejects.toMatchObject({
      phase: 'submit-capture-unavailable',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('stops immediately when capture read fails during ACK polling', async () => {
    const page = createSubmitPageMock({
      readError: new Error('CDP session detached after submit click'),
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).toHaveBeenCalledTimes(1);
  });

  it('treats a non-array post-click capture result as unconfirmed', async () => {
    const page = createSubmitPageMock({
      capturedEntries: { malformed: true },
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).toHaveBeenCalledTimes(1);
  });

  it('treats malformed post-click capture entries as unconfirmed', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [null],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).toHaveBeenCalledTimes(1);
  });

  it('stops without retrying when the post-click ACK wait itself fails', async () => {
    const page = createSubmitPageMock({
      sleepErrorAfterClick: new Error('browser bridge disconnected'),
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 500,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.readNetworkCapture).toHaveBeenCalledTimes(1);
  });

  it('fails before clicking when pre-click network capture drain fails', async () => {
    const page = createSubmitPageMock({
      drainError: new Error('CDP Network domain disabled during drain'),
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500 })).rejects.toMatchObject({
      phase: 'submit-capture-unavailable',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('fails before clicking when the pre-click drain payload is not an array', async () => {
    const page = createSubmitPageMock({
      drainEntries: { malformed: true },
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500 })).rejects.toMatchObject({
      phase: 'submit-capture-unavailable',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('fails before clicking when the pre-click drain contains an entry without a URL', async () => {
    const page = createSubmitPageMock({
      drainEntries: [null],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500 })).rejects.toMatchObject({
      phase: 'submit-capture-unavailable',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('accepts a delayed prior matching ACK before clicking again', async () => {
    const page = createSubmitPageMock({
      drainEntries: [SUCCESS_ENTRY],
      capturedEntries: [],
    });
    const result = await submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    });
    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      threadId: '7488349283742819842',
      conversationId: '7488349283742819840',
    });
    expect(page.click).not.toHaveBeenCalled();
    expect(page.readNetworkCapture).toHaveBeenCalledTimes(1);
  });

  it('accepts a delayed prior ACK when capture fields are nested', async () => {
    const page = createSubmitPageMock({
      drainEntries: [{
        request: {
          url: SUCCESS_ENTRY.url,
          method: 'POST',
          postData: SUCCESS_ENTRY.requestBody,
        },
        response: {
          status: 200,
          body: SUCCESS_ENTRY.responseBody,
        },
      }],
    });
    const result = await submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    });
    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      submitRequestCount: 1,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('stops before clicking when a prior matching request appears without a complete ACK', async () => {
    const page = createSubmitPageMock({
      drainEntries: [{
        ...SUCCESS_ENTRY,
        responseBody: null,
      }],
      capturedEntries: [],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
    expect(page.readNetworkCapture).toHaveBeenCalledTimes(1);
  });

  it('stops before clicking when a prior endpoint request has no correlatable body', async () => {
    const page = createSubmitPageMock({
      drainEntries: [{
        url: SUCCESS_ENTRY.url,
        method: 'POST',
        status: 200,
        requestBody: null,
        responseBody: SUCCESS_ENTRY.responseBody,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('stops before clicking when a prior confirmed ACK coexists with another endpoint request', async () => {
    const page = createSubmitPageMock({
      drainEntries: [
        SUCCESS_ENTRY,
        {
          ...SUCCESS_ENTRY,
          requestBody: JSON.stringify({
            conversation_id: 'different-conversation',
            prompt: 'different asset request',
          }),
        },
      ],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('stops before clicking when a prior matching endpoint capture omits its method', async () => {
    const page = createSubmitPageMock({
      drainEntries: [{
        ...SUCCESS_ENTRY,
        method: undefined,
      }],
      capturedEntries: [],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('confirms submission when page.click throws but valid ACK is captured (ACK wins)', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [SUCCESS_ENTRY],
    });
    page.click = vi.fn(async () => {
      throw new Error('CDP click failed / node detached');
    });

    const result = await submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      threadId: '7488349283742819842',
      conversationId: '7488349283742819840',
      submitRequestCount: 1,
    });
  });

  it('returns safe not-sent when page.click throws and 0 requests were captured with prompt in composer', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      pageState: { assetIdInComposer: true, assetIdOutsideComposer: false },
    });
    page.click = vi.fn(async () => {
      throw new Error('CDP click target unreachable');
    });

    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-not-sent',
      retryable: true,
    });
  });

  it('classifies uncorrelatable endpoint request as unconfirmed', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        responseStatus: 200,
        requestBodyPreview: null,
        responsePreview: SUCCESS_ENTRY.responseBody,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('classifies missing HTTP status in captured entry as unconfirmed', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        requestBodyPreview: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responsePreview: SUCCESS_ENTRY.responseBody,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('classifies responseBodyTruncated=true as unconfirmed even if partial payload looks complete', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        responseStatus: 200,
        requestBodyPreview: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responsePreview: SUCCESS_ENTRY.responseBody,
        responseBodyTruncated: true,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('confirms exact OpenCLI-shaped canary entry with responseStatus and responsePreview', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        responseStatus: 200,
        requestBodyPreview: JSON.stringify({
          conversation_id: 'ab792c30',
          prompt: `资产编号：${ASSET_ID}`,
        }),
        responsePreview: `id:canary-1\nevent:handshake\ndata:{"thread_id":327598892300,"conversation_id":"ab792c30"}\n\nevent:stream_complete\ndata:{"success":true,"error_code":"0","error_message":"success"}\n\n{"ret":"0","errmsg":"success"}`,
        responseBodyTruncated: false,
      }],
    });

    const result = await submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      threadId: '327598892300',
      conversationId: 'ab792c30',
      submitRequestCount: 1,
    });
  });

  it('stops immediately on HTTP rejection without retrying', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 403,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: JSON.stringify({ error_msg: 'Forbidden' }),
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-rejected',
      retryable: false,
    });
  });

  it('stops immediately on business rejection without retrying', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 200,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: `event: stream_complete\ndata: {"success":false,"error_code":10403,"error_msg":"Account quota limit"}\n\n`,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 500, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-rejected',
      retryable: false,
    });
  });

  it('classifies timeout as unconfirmed when request was sent but no response completed', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 200,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: null,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('reads the destructive post-click capture buffer once and never downgrades a seen request', async () => {
    const pendingEntry = {
      url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
      method: 'POST',
      status: 200,
      requestBody: JSON.stringify({
        conversation_id: '7488349283742819840',
        prompt: `资产编号：${ASSET_ID}`,
      }),
      responseBody: null,
    };
    const page = createSubmitPageMock({
      capturedEntries: (postClickReadCount) => (
        postClickReadCount === 1 ? [pendingEntry] : []
      ),
    });

    await expect(submitPreparedGeneration(page, ASSET_ID, {
      timeoutMs: 100,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
    expect(page.readNetworkCapture).toHaveBeenCalledTimes(2);
    expect(page.readCount).toBe(2);
  });

  it('classifies timeout as unconfirmed when stream is truncated before completion', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 200,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: `event: handshake\ndata: {"thread_id":"7488349283742819842"}\n\n`,
      }],
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('identifies safe not-sent state when 0 requests captured and prompt remains in composer', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      pageState: { assetIdInComposer: true, assetIdOutsideComposer: false },
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-not-sent',
      retryable: true,
    });
  });

  it('identifies unconfirmed state when 0 requests captured but prompt appeared outside composer', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      pageState: { assetIdInComposer: false, assetIdOutsideComposer: true },
    });
    await expect(submitPreparedGeneration(page, ASSET_ID, { timeoutMs: 100, pollIntervalMs: 50 })).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });
});

describe('jimeng-agent/agent-dom — prepareJimengAgentAsk submit orchestration', () => {
  const ASSET_ID = 'b7e4f19a2c0d5e68';

  function createOrchestrationPageMock({
    networkEntries = [],
  } = {}) {
    let submitAttempts = 0;
    let captureReadCount = 0;
    const clicks = [];
    const openWorkspaceCalls = [];
    let simulatedTime = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => simulatedTime);

    const page = {
      goto: vi.fn(async (url) => {
        openWorkspaceCalls.push(url);
      }),
      sleep: vi.fn(async (seconds) => {
        simulatedTime += Math.max(10, Math.round((seconds || 0.5) * 1000));
      }),
      click: vi.fn(async (sel) => {
        clicks.push(sel);
        return { ok: true };
      }),
      nativeClick: vi.fn(async () => ({})),
      nativeKeyPress: vi.fn(async () => ({})),
      nativeType: vi.fn(async () => ({})),
      insertText: vi.fn(async () => ({})),
      setFileInput: vi.fn(async () => ({})),
      cdp: vi.fn(async () => ({})),
      startNetworkCapture: vi.fn(async () => {
        captureReadCount = 0;
        return true;
      }),
      readNetworkCapture: vi.fn(async () => {
        captureReadCount += 1;
        if (captureReadCount === 1) return [];
        if (typeof networkEntries === 'function') {
          return networkEntries(submitAttempts);
        }
        return networkEntries;
      }),
      evaluate: vi.fn(async (expr) => {
        // Surface probe
        if (expr.includes('FILE_INPUT_SELECTOR') || expr.includes('dockScope') || (expr.includes('editors') && expr.includes('fileInputs'))) {
          return {
            modeText: 'Agent 模式',
            dockText: 'Agent 模式 自动',
            agentSelected: true,
            autoEnabled: true,
            videoSelected: true,
            autoFromDock: true,
            autoPopupOpen: false,
            editorCount: 1,
            editorReady: true,
            fileInputCount: 1,
            ready: true,
            referenceCount: 0,
          };
        }
        // Draft clear
        if (expr.includes('data-opencli-jimeng-upload-slot')) {
          return { cleared: true, slotCount: 0 };
        }
        // Checkpoint snapshot
        if (expr.includes('observedMentionLabels') || expr.includes('submitCandidates')) {
          return {
            surfaceReady: true,
            referenceCount: 0,
            mentionCount: 0,
            observedMentionLabels: [],
            rawAt: false,
            menuVisible: false,
            editorLines: ['prompttext资产编号：' + ASSET_ID],
            editorTextNormalized: 'prompttext资产编号：' + ASSET_ID,
            submitEnabled: true,
          };
        }
        // Composer clear
        if (expr.includes('data-rich-placeholder') || expr.includes('ProseMirror-separator') || expr.includes("nativeKeyPress('a'") || expr.includes('composerClearState')) {
          return { empty: true, textLength: 0, mentionCount: 0 };
        }
        // Dock reference snapshot
        if (expr.includes('stripCandidates') || expr.includes('reference-group')) {
          return { ok: true, strips: [], alerts: [] };
        }
        // Submit button marking
        if (expr.includes('submit-button')) {
          submitAttempts += 1;
          return { ok: true, count: 1 };
        }
        // AssetId in composer check
        if (expr.includes('assetIdInComposer')) {
          return { assetIdInComposer: true, assetIdOutsideComposer: false };
        }
        return { ok: true };
      }),
      get clicks() { return clicks; },
      get openWorkspaceCalls() { return openWorkspaceCalls; },
      get submitAttempts() { return submitAttempts; },
    };
    return page;
  }

  const SUCCESS_ENTRY = {
    url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
    method: 'POST',
    status: 200,
    requestBody: JSON.stringify({
      conversation_id: '7488349283742819840',
      prompt: `资产编号：${ASSET_ID}`,
    }),
    responseBody: `event: handshake\ndata: {"thread_id":"7488349283742819842","conversation_id":"7488349283742819840"}\n\nevent: stream_complete\ndata: {"success":true,"error_code":0}\n\n`,
  };

  it('runs --submit 0 without starting network capture or clicking generate', async () => {
    const page = createOrchestrationPageMock();
    delete page.startNetworkCapture;
    delete page.readNetworkCapture;

    const result = await prepareJimengAgentAsk(page, {
      workspace: '11718040705548',
      assetId: ASSET_ID,
      agentPrompt: `prompt text 资产编号：${ASSET_ID}`,
      submit: false,
      retry: 0,
    }, []);

    expect(result).toMatchObject({
      status: 'prepared',
      submitted: false,
      checkpointOk: true,
      confirmation: 'none',
      threadId: '',
      conversationId: '',
      submitRequestCount: 0,
    });
    expect(page.clicks.some((c) => c.includes('submit'))).toBe(false);
  });

  it('runs --submit 1 with valid ACK and returns confirmed diagnostics', async () => {
    const page = createOrchestrationPageMock({
      networkEntries: [SUCCESS_ENTRY],
    });

    const result = await prepareJimengAgentAsk(page, {
      workspace: '11718040705548',
      assetId: ASSET_ID,
      agentPrompt: `prompt text 资产编号：${ASSET_ID}`,
      submit: true,
      retry: 0,
    }, []);

    expect(result).toMatchObject({
      status: 'submitted',
      submitted: true,
      checkpointOk: true,
      confirmation: 'ack_confirmed',
      threadId: '7488349283742819842',
      conversationId: '7488349283742819840',
      submitRequestCount: 1,
    });
  });

  it('stops immediately when submit is unconfirmed even if retry budget > 0, warning against duplicate submission', async () => {
    const page = createOrchestrationPageMock({
      networkEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 200,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: null, // response never arrives
      }],
    });

    try {
      await prepareJimengAgentAsk(page, {
        workspace: '11718040705548',
        assetId: ASSET_ID,
        agentPrompt: `prompt text 资产编号：${ASSET_ID}`,
        submit: true,
        retry: 3,
      }, []);
      expect.unreachable('Should have thrown CommandExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExecutionError);
      expect(err.message).toContain('JIMENG_SUBMIT_UNCONFIRMED');
      expect(err.hint).toContain('可能已受理时不要重试');
      expect(page.submitAttempts).toBe(1);
    }
  });

  it('stops immediately when server explicitly rejects without retrying', async () => {
    const page = createOrchestrationPageMock({
      networkEntries: [{
        url: 'https://jimeng.jianying.com/mweb/v1/creation_agent/v2/conversation',
        method: 'POST',
        status: 200,
        requestBody: JSON.stringify({ prompt: `资产编号：${ASSET_ID}` }),
        responseBody: `event: stream_complete\ndata: {"success":false,"error_code":10403,"error_msg":"Account quota limit"}\n\n`,
      }],
    });

    try {
      await prepareJimengAgentAsk(page, {
        workspace: '11718040705548',
        assetId: ASSET_ID,
        agentPrompt: `prompt text 资产编号：${ASSET_ID}`,
        submit: true,
        retry: 2,
      }, []);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExecutionError);
      expect(err.message).toContain('JIMENG_SUBMIT_REJECTED');
      expect(err.hint).toContain('服务端已明确拒绝');
    }
  });

  it('retries safely when submit was proven not-sent and succeeds on second attempt', async () => {
    const page = createOrchestrationPageMock({
      networkEntries: () => {
        if (page.submitAttempts <= 1) {
          // First prepare/submit attempt: no network request sent
          return [];
        }
        // Second prepare/submit attempt: succeeds with ACK
        return [SUCCESS_ENTRY];
      },
    });

    const result = await prepareJimengAgentAsk(page, {
      workspace: '11718040705548',
      assetId: ASSET_ID,
      agentPrompt: `prompt text 资产编号：${ASSET_ID}`,
      submit: true,
      retry: 2,
    }, []);

    expect(result).toMatchObject({
      status: 'submitted',
      submitted: true,
      checkpointOk: true,
      confirmation: 'ack_confirmed',
      retryUsed: 1,
    });
    expect(page.openWorkspaceCalls.length).toBeGreaterThan(1);
  });
});

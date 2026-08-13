import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  JIMENG_GENERATE_URL,
  buildEnterKeyEvents,
  buildMentionCandidateExpression,
  buildMentionSegments,
  buildWorkspaceUrl,
  chooseRetryPlan,
  isStrictMentionCommit,
  normalizePromptValidationLines,
  resolveMentionDebugOptions,
} from '../src/agent-dom.js';

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
    expect(insertion).toContain('page.evaluate(buildMentionCandidateExpression(asset, marker, true))');
    expect(candidateExpression).toContain('matches.length !== 1');
    expect(candidateExpression).toContain('approved === matches[0].option');
    expect(candidateExpression).toContain('matches[0].option.click();');
    expect(candidateExpression).not.toContain('Input.dispatchKeyEvent');
    expect(candidateExpression).not.toMatch(/nativeKeyPress\(['"]Enter['"]/);
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

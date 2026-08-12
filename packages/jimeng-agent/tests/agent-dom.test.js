import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  JIMENG_GENERATE_URL,
  buildEnterKeyEvents,
  buildMentionSegments,
  buildWorkspaceUrl,
  chooseRetryPlan,
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
    expect(candidateExpression).toContain('marked[0] !== matches[0].option');
    expect(candidateExpression).toContain('matches[0].option.click();');
    expect(candidateExpression).not.toContain('Input.dispatchKeyEvent');
    expect(candidateExpression).not.toMatch(/nativeKeyPress\(['"]Enter['"]/);
  });

  it('keeps Escape in the existing failed-attempt rewind path', () => {
    const rewind = sourceBetween(
      'async function rewindMentionKeystrokes(',
      '/**\n * Pure DOM read of the mention picker.',
    );
    expect(rewind).toContain("pressKeyWithGap(page, 'Escape', 0.12)");
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

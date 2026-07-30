/**
 * Pure two-phase checkpoint tests. No browser, no network.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCheckpointExpectations,
  evaluateContentCheckpoint,
  evaluatePreInputControls,
  normalizePromptValidationLines,
} from '../src/checkpoint.js';

const assets = [
  { label: '图片1', filename: 'a.png' },
  { label: '视频1', filename: 'b.mp4' },
];

describe('jimeng-agent/checkpoint — pre-input controls', () => {
  it('requires Agent/Auto/Video signals before any content input (no preference-panel reopen)', () => {
    // preferencePanelReadable is intentionally not required.
    expect(evaluatePreInputControls({
      surfaceReady: true,
      agentSelected: true,
      autoEnabled: true,
      videoSelected: true,
    }).ok).toBe(true);

    const failed = evaluatePreInputControls({
      surfaceReady: true,
      agentSelected: true,
      autoEnabled: false,
      videoSelected: false,
    });
    expect(failed.ok).toBe(false);
    expect(failed.failures).toEqual(expect.arrayContaining([
      'autoEnabled',
      'videoSelected',
    ]));
    expect(failed.failures).not.toContain('preferencePanelReadable');
    expect(failed.phase).toBe('pre-input');
  });
});

describe('jimeng-agent/checkpoint — content expectations', () => {
  it('counts mentions and preserves line structure for the assembled agent prompt', () => {
    const prompt = 'prefix\n\n请以@图片1参考，再看@视频1';
    const expectations = buildCheckpointExpectations(prompt, assets);
    expect(expectations.expectedMentions).toBe(2);
    expect(expectations.expectedReferences).toBe(2);
    expect(expectations.mentionLabels).toEqual(['图片1', '视频1']);
    expect(expectations.expectedLines).toEqual(normalizePromptValidationLines(prompt));
  });
});

describe('jimeng-agent/checkpoint — content evaluation', () => {
  it('passes a complete content snapshot without re-checking Auto panels', () => {
    const prompt = '请以@图片1作为人物形象参考。';
    const expectations = buildCheckpointExpectations(prompt, [assets[0]]);
    const report = evaluateContentCheckpoint({
      surfaceReady: true,
      referenceCount: 1,
      mentionCount: 1,
      observedMentionLabels: ['图片1'],
      rawAt: false,
      menuVisible: false,
      editorLines: expectations.expectedLines,
      editorTextNormalized: expectations.expectedLines.join(''),
      // Intentionally omit preference fields: content gate must not require them.
    }, expectations);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.checks.autoEnabled).toBeUndefined();
  });

  it('fails closed on content mismatches and only requires submitArmed when requested', () => {
    const prompt = '@图片1';
    const expectations = buildCheckpointExpectations(prompt, [assets[0]]);
    const withoutSubmit = evaluateContentCheckpoint({
      surfaceReady: true,
      referenceCount: 0,
      mentionCount: 0,
      observedMentionLabels: [],
      rawAt: true,
      menuVisible: true,
      editorLines: ['wrong'],
      editorTextNormalized: 'wrong',
      submitEnabled: false,
    }, expectations);
    expect(withoutSubmit.ok).toBe(false);
    expect(withoutSubmit.failures).toEqual(expect.arrayContaining([
      'referenceCount',
      'mentionCount',
      'mentionLabelsMatch',
      'noRawAt',
      'noMentionMenu',
      'lineStructure',
    ]));
    expect(withoutSubmit.failures).not.toContain('submitArmed');

    const withSubmit = evaluateContentCheckpoint({
      surfaceReady: true,
      referenceCount: 1,
      mentionCount: 1,
      observedMentionLabels: ['图片1'],
      rawAt: false,
      menuVisible: false,
      editorLines: expectations.expectedLines,
      editorTextNormalized: expectations.expectedLines.join(''),
      submitEnabled: false,
      requireSubmitArmed: true,
    }, expectations);
    expect(withSubmit.ok).toBe(false);
    expect(withSubmit.failures).toEqual(['submitArmed']);
  });
});

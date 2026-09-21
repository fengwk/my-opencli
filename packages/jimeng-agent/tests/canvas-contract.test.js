import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  CANVAS_CREATE_QUERY,
  CANVAS_NEW,
  JIMENG_CANVAS_PATH,
  JIMENG_CANVAS_URL,
  buildCanvasUrl,
  evaluateCanvasContentCheckpoint,
  evaluateCanvasPreInputControls,
  normalizeCanvasAskArgs,
  normalizeCanvasIdentity,
  normalizeCanvasTitle,
  parseProjectIdFromHref,
} from '../src/canvas-contract.js';

function validCanvasArgs(overrides = {}) {
  return {
    canvas: 'new',
    ratio: '16:9',
    model_version: 'seedance2.0',
    duration: 5,
    prompt: 'test prompt',
    ...overrides,
  };
}

describe('jimeng-agent/canvas-contract — identity normalization', () => {
  it("normalizes 'new' identity", () => {
    expect(normalizeCanvasIdentity('new')).toEqual({
      mode: 'new',
      value: 'new',
      projectId: '',
    });
    expect(normalizeCanvasIdentity(' NEW ')).toEqual({
      mode: 'new',
      value: 'new',
      projectId: '',
    });
  });

  it('normalizes project ID string', () => {
    const id = 'c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84';
    expect(normalizeCanvasIdentity(id)).toEqual({
      mode: 'existing',
      value: id,
      projectId: id,
    });
  });

  it('normalizes full canvas create URL', () => {
    const url = 'https://jimeng.jianying.com/ai-tool/ai-canvas?enter_from=page_click&from_page=create';
    expect(normalizeCanvasIdentity(url)).toEqual({
      mode: 'new',
      value: 'new',
      projectId: '',
    });
  });

  it('normalizes full existing canvas URL', () => {
    const url = 'https://jimeng.jianying.com/ai-tool/ai-canvas/c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84';
    expect(normalizeCanvasIdentity(url)).toEqual({
      mode: 'existing',
      value: 'c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84',
      projectId: 'c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84',
    });
  });

  it('rejects missing or empty canvas identity', () => {
    expect(() => normalizeCanvasIdentity(undefined)).toThrow(ArgumentError);
    expect(() => normalizeCanvasIdentity('')).toThrow(ArgumentError);
    expect(() => normalizeCanvasIdentity('   ')).toThrow(ArgumentError);
    expect(() => normalizeCanvasIdentity(null)).toThrow(ArgumentError);
  });

  it('rejects invalid host in canvas URL', () => {
    expect(() => normalizeCanvasIdentity('https://evil.com/ai-tool/ai-canvas/123')).toThrow(ArgumentError);
  });

  it('rejects project-copy sentinel as project ID', () => {
    expect(() => normalizeCanvasIdentity('project-copy')).toThrow(ArgumentError);
    expect(() => normalizeCanvasIdentity('https://jimeng.jianying.com/ai-tool/ai-canvas/project-copy')).toThrow(ArgumentError);
  });

  it('rejects malformed URL-encoded project IDs as argument errors', () => {
    expect(() => normalizeCanvasIdentity(
      'https://jimeng.jianying.com/ai-tool/ai-canvas/%E0%A4%A',
    )).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/canvas-contract — URL building', () => {
  it('builds new canvas URL with query parameter', () => {
    expect(buildCanvasUrl('new')).toBe(`${JIMENG_CANVAS_URL}?${CANVAS_CREATE_QUERY}`);
  });

  it('builds existing canvas URL with projectId in path', () => {
    const id = 'abc-123';
    expect(buildCanvasUrl(id)).toBe(`${JIMENG_CANVAS_URL}/${id}`);
  });

  it('overrides projectId for new canvas when resolved after create', () => {
    expect(buildCanvasUrl('new', { projectId: 'created-id' })).toBe(`${JIMENG_CANVAS_URL}/created-id`);
  });
});

describe('jimeng-agent/canvas-contract — parseProjectIdFromHref', () => {
  it('extracts projectId from canonical path', () => {
    expect(parseProjectIdFromHref('https://jimeng.jianying.com/ai-tool/ai-canvas/c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84')).toBe(
      'c9d7fc9d-7c2f-447b-9ad9-90bb03d2da84',
    );
    expect(parseProjectIdFromHref('https://jimeng.jianying.com/ai-tool/ai-canvas/project-123/')).toBe(
      'project-123',
    );
  });

  it('returns empty string for create page URL', () => {
    expect(parseProjectIdFromHref('https://jimeng.jianying.com/ai-tool/ai-canvas?enter_from=page_click&from_page=create')).toBe('');
  });

  it('returns empty string for project-copy route', () => {
    expect(parseProjectIdFromHref('https://jimeng.jianying.com/ai-tool/ai-canvas/project-copy')).toBe('');
  });
});

describe('jimeng-agent/canvas-contract — normalizeCanvasAskArgs', () => {
  it('normalizes valid args for new canvas', () => {
    const result = normalizeCanvasAskArgs(validCanvasArgs());
    expect(result.canvasMode).toBe('new');
    expect(result.canvas).toBe('new');
    expect(result.projectId).toBe('');
    expect(result.title).toBe('');
    expect(result.ratio).toBe('16:9');
    expect(result.modelVersion).toBe('seedance2.0');
    expect(result.duration).toBe(5);
    expect(result.submit).toBe(false);
    expect(result.assetId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.agentPrompt).toContain('Seedance2.0');
    expect(result.agentPrompt).toContain(`资产编号：${result.assetId}`);
  });

  it('normalizes valid args for existing canvas', () => {
    const result = normalizeCanvasAskArgs(validCanvasArgs({ canvas: 'proj-456' }));
    expect(result.canvasMode).toBe('existing');
    expect(result.projectId).toBe('proj-456');
  });

  // A supplied title is normalized once and restricted to newly-created canvases.
  it('normalizes a new-canvas title and rejects accidental existing-canvas renames', () => {
    const result = normalizeCanvasAskArgs(validCanvasArgs({
      canvas: 'new',
      title: '  苏州猫咪短片  ',
    }));
    expect(result.title).toBe('苏州猫咪短片');
    expect(normalizeCanvasTitle(undefined, { mode: 'new' })).toBe('');
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({
      canvas: 'existing-project',
      title: 'do not rename',
    }))).toThrow(ArgumentError);
  });

  it('rejects blank, non-string, and overlong canvas titles', () => {
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ title: '   ' }))).toThrow(ArgumentError);
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ title: 123 }))).toThrow(ArgumentError);
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ title: '画'.repeat(61) }))).toThrow(ArgumentError);
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ title: '画'.repeat(60) }))).not.toThrow();
  });

  it('rejects invalid duration', () => {
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ duration: 20 }))).toThrow(ArgumentError);
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ duration: 1 }))).toThrow(ArgumentError);
  });

  it('rejects invalid ratio', () => {
    expect(() => normalizeCanvasAskArgs(validCanvasArgs({ ratio: '2:3' }))).toThrow(ArgumentError);
  });

  it.each([
    {
      name: 'pure text',
      args: { prompt: '纯文字镜头' },
      kinds: [],
      labels: [],
      mentionLabels: [],
    },
    {
      name: 'image reference',
      args: { image: ['hero.png'], prompt: '以@图片1为主体' },
      kinds: ['image'],
      labels: ['图片1'],
      mentionLabels: ['图片1'],
    },
    {
      name: 'audio reference',
      args: { audio: ['voice.wav'], prompt: '沿用@音频1的节奏' },
      kinds: ['audio'],
      labels: ['音频1'],
      mentionLabels: ['音频1'],
    },
    {
      name: 'video reference',
      args: { video: ['motion.mp4'], prompt: '参考@视频1的动作' },
      kinds: ['video'],
      labels: ['视频1'],
      mentionLabels: ['视频1'],
    },
    {
      name: 'mixed image video audio references',
      args: {
        image: ['hero.png', 'scene.jpg'],
        video: ['motion.mp4'],
        audio: ['voice.wav'],
        prompt: '@视频1参考动作，@图片2参考场景，@音频1参考节奏，@图片1保持主体。',
      },
      kinds: ['image', 'image', 'video', 'audio'],
      labels: ['图片1', '图片2', '视频1', '音频1'],
      mentionLabels: ['视频1', '图片2', '音频1', '图片1'],
    },
  ])('normalizes $name canvas scenario', ({ args, kinds, labels, mentionLabels }) => {
    const result = normalizeCanvasAskArgs(validCanvasArgs({
      model_version: 'seedance2.0fast',
      duration: 4,
      ...args,
    }));

    expect(result.assets.map((asset) => asset.kind)).toEqual(kinds);
    expect(result.assets.map((asset) => asset.label)).toEqual(labels);
    expect(result.mentions.map((mention) => mention.label)).toEqual(mentionLabels);
    expect(result.agentPrompt).toContain('Seedance2.0 Fast');
    expect(result.agentPrompt).toContain('16:9');
    expect(result.agentPrompt).toContain('4s');
    expect(result.agentPrompt).toContain(`资产编号：${result.assetId}`);
  });
});

describe('jimeng-agent/canvas-contract — pre-input and checkpoint evaluation', () => {
  it('evaluates pre-input controls', () => {
    expect(
      evaluateCanvasPreInputControls({
        canvasReady: true,
        sidecarOpen: true,
        editorReady: true,
        addControlReady: true,
      }),
    ).toMatchObject({ ok: true, failures: [] });

    expect(
      evaluateCanvasPreInputControls({
        canvasReady: false,
        sidecarOpen: true,
        editorReady: true,
        addControlReady: true,
      }),
    ).toMatchObject({ ok: false, failures: ['canvasReady'] });

    expect(
      evaluateCanvasPreInputControls({
        canvasReady: true,
        sidecarOpen: true,
        editorReady: true,
        addControlReady: false,
        requireAddControl: false,
      }),
    ).toMatchObject({ ok: true, failures: [] });
  });

  it('evaluates canvas content checkpoint with chips and prompt anchors', () => {
    const expectations = {
      expectedReferences: 1,
      expectedChipLabels: ['hero.png'],
      textAnchors: ['16:9', '5s', 'b7e4f19a2c0d5e68'],
    };
    const snapshot = {
      surfaceReady: true,
      referenceCount: 1,
      observedChipLabels: ['hero.png'],
      processingCount: 0,
      menuVisible: false,
      assetIdPresent: true,
      editorTextNormalized: 'seedance2.016:95sb7e4f19a2c0d5e68hello',
      submitEnabled: true,
    };

    expect(evaluateCanvasContentCheckpoint(snapshot, expectations)).toMatchObject({
      ok: true,
      failures: [],
    });

    expect(evaluateCanvasContentCheckpoint(
      { ...snapshot, observedChipLabels: ['图片1'] },
      { ...expectations, expectedChipLabels: [['hero.png', '图片1']] },
    )).toMatchObject({
      ok: true,
      failures: [],
    });

    const richMentionExpectations = {
      ...expectations,
      expectedMentionLabels: ['图片1', '图片2'],
    };
    expect(evaluateCanvasContentCheckpoint(
      {
        ...snapshot,
        richMentionCount: 2,
        richMentionLabels: ['图片1.png', '@图片2'],
      },
      richMentionExpectations,
    )).toMatchObject({
      ok: true,
      failures: [],
    });

    expect(evaluateCanvasContentCheckpoint(
      {
        ...snapshot,
        richMentionCount: 0,
        richMentionLabels: [],
      },
      richMentionExpectations,
    )).toMatchObject({
      ok: false,
      failures: ['richMentionCount', 'richMentionsInOrder'],
    });

    expect(
      evaluateCanvasContentCheckpoint({ ...snapshot, processingCount: 1 }, expectations),
    ).toMatchObject({
      ok: false,
      failures: ['noProcessing'],
    });

    expect(
      evaluateCanvasContentCheckpoint({ ...snapshot, submitEnabled: false, requireSubmitArmed: true }, expectations),
    ).toMatchObject({
      ok: false,
      failures: ['submitArmed'],
    });
  });
});

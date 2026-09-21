import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  JIMENG_CANVAS_V0_URL,
  V0_CREATE_PROJECT_DRAFT,
  V0_DEFAULT_PROJECT_NAME,
  V0_MAX_TITLE_LENGTH,
  buildCanvasV0CreateProjectBody,
  buildCanvasV0Url,
  evaluateCanvasV0Checkpoint,
  evaluateCanvasV0PreInputControls,
  evaluateCanvasV0SubmitReadiness,
  normalizeCanvasV0AskArgs,
  normalizeCanvasV0CreateArgs,
  normalizeCanvasV0Identity,
  normalizeV0EditorText,
  parseCanvasV0ProjectIdFromHref,
  readCanvasV0CreatedProject,
} from '../src/canvas-v0-contract.js';

const PROJECT_ID = '22104635995404';

describe('jimeng-agent canvas-v0 identity', () => {
  it('accepts new, a numeric project id, and legacy canvas URLs', () => {
    expect(normalizeCanvasV0Identity('new')).toEqual({ mode: 'new', value: 'new', projectId: '' });
    expect(normalizeCanvasV0Identity(PROJECT_ID)).toEqual({
      mode: 'existing',
      value: PROJECT_ID,
      projectId: PROJECT_ID,
    });
    expect(normalizeCanvasV0Identity(`${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}?enter_from=create_new`)).toEqual({
      mode: 'existing',
      value: PROJECT_ID,
      projectId: PROJECT_ID,
    });
  });

  it('rejects blank, non-numeric and Agent Canvas identities', () => {
    expect(() => normalizeCanvasV0Identity()).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0Identity('   ')).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0Identity('abcdef')).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0Identity('/ai-tool/ai-canvas/7f4d0d0e-0f4c-4a1f-9b0e-6f0b6b0a1c11')).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0Identity('https://example.com/ai-tool/canvas/123456')).toThrow(ArgumentError);
  });

  it('builds canvas URLs without inventing a project id', () => {
    expect(buildCanvasV0Url('new')).toBe(`${JIMENG_CANVAS_V0_URL}?enter_from=create_new&from_page=assets`);
    expect(buildCanvasV0Url(PROJECT_ID)).toBe(`${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`);
    expect(buildCanvasV0Url({ mode: 'new', value: 'new', projectId: PROJECT_ID }, { projectId: PROJECT_ID }))
      .toBe(`${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`);
  });

  it('reads the project id back from an href', () => {
    expect(parseCanvasV0ProjectIdFromHref(`${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}?from_page=assets`)).toBe(PROJECT_ID);
    expect(parseCanvasV0ProjectIdFromHref(`${JIMENG_CANVAS_V0_URL}`)).toBe('');
    expect(parseCanvasV0ProjectIdFromHref('https://jimeng.jianying.com/ai-tool/ai-canvas/abc')).toBe('');
  });
});

describe('jimeng-agent canvas-v0 create contract', () => {
  it('builds the create_project body the legacy API accepts', () => {
    const body = buildCanvasV0CreateProjectBody({ name: '  苏州猫咪  ' });
    expect(body.name).toBe('苏州猫咪');
    expect(body.draft).toBe(V0_CREATE_PROJECT_DRAFT);
    expect(JSON.parse(body.draft)).toEqual({
      meta: { version: '0.0.1' },
      layers: [],
      aiGeneratorReference: {},
      references: {},
    });
  });

  it('falls back to the default project name and caps the name at the API limit', () => {
    expect(buildCanvasV0CreateProjectBody({}).name).toBe(V0_DEFAULT_PROJECT_NAME);
    const long = buildCanvasV0CreateProjectBody({ name: 'x'.repeat(40) });
    expect(long.name.length).toBe(V0_MAX_TITLE_LENGTH);
  });

  it('reads project_id/draft_id from the mweb envelope', () => {
    expect(readCanvasV0CreatedProject({
      ret: '0',
      errmsg: 'success',
      data: { project_id: PROJECT_ID, draft_id: '22063470174988', version: '1' },
    })).toEqual({ projectId: PROJECT_ID, draftId: '22063470174988', version: '1' });
  });

  it('rejects failing or malformed create_project envelopes', () => {
    expect(() => readCanvasV0CreatedProject({ ret: '1001', errmsg: 'Param, name too long' }))
      .toThrow(/ret=1001/);
    expect(() => readCanvasV0CreatedProject({ ret: '0', data: {} })).toThrow(/no usable project id/);
    expect(() => readCanvasV0CreatedProject(null)).toThrow(/malformed envelope/);
  });

  it('normalizes create arguments with a legacy title ceiling', () => {
    expect(normalizeCanvasV0CreateArgs({})).toEqual({ canvas: 'new', canvasMode: 'new', title: '' });
    expect(normalizeCanvasV0CreateArgs({ title: ' 苏州猫咪 ' })).toMatchObject({ title: '苏州猫咪' });
    expect(normalizeCanvasV0CreateArgs({ title: 'x'.repeat(V0_MAX_TITLE_LENGTH) })).toMatchObject({
      title: 'x'.repeat(V0_MAX_TITLE_LENGTH),
    });
    expect(() => normalizeCanvasV0CreateArgs({ title: 'x'.repeat(V0_MAX_TITLE_LENGTH + 1) })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0CreateArgs({ title: '   ' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0CreateArgs({ canvas: 'new' })).toThrow();
  });
});

describe('jimeng-agent canvas-v0 ask contract', () => {
  const base = {
    canvas: PROJECT_ID,
    prompt: '请以参考图中的角色为主角。',
    ratio: '16:9',
    model_version: 'seedance2.0fast',
    duration: 5,
  };

  it('normalizes the ask contract and reuses the shared agent prompt', () => {
    const canonical = normalizeCanvasV0AskArgs(base);
    expect(canonical.canvasMode).toBe('existing');
    expect(canonical.projectId).toBe(PROJECT_ID);
    expect(canonical.assetId).toHaveLength(16);
    expect(canonical.agentPrompt).toContain(base.prompt);
    expect(canonical.agentPrompt).toContain(`资产编号：${canonical.assetId}`);
    expect(canonical.agentPrompt).toContain('16:9');
    expect(canonical.agentPrompt).toContain('5s视频');
  });

  it('rejects a title for an existing canvas and unknown keys', () => {
    expect(() => normalizeCanvasV0AskArgs({ ...base, title: '不该改的名字' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0AskArgs({ ...base, unknownKey: 1 })).toThrow();
  });

  it('keeps the canonical key set frozen', () => {
    const canonical = normalizeCanvasV0AskArgs(base);
    expect(Object.keys(canonical).sort()).toEqual([
      'agentPrompt',
      'assetId',
      'assets',
      'audioPaths',
      'canvas',
      'canvasMode',
      'duration',
      'imagePaths',
      'mentions',
      'modelVersion',
      'projectId',
      'prompt',
      'ratio',
      'retry',
      'submit',
      'title',
      'videoPaths',
    ]);
  });
});

describe('jimeng-agent canvas-v0 verdicts', () => {
  it('evaluates pre-input controls', () => {
    expect(evaluateCanvasV0PreInputControls({
      surfaceReady: true,
      sidecarOpen: true,
      editorReady: true,
      composerReady: true,
      uploadControlReady: true,
    })).toMatchObject({ ok: true, failures: [] });

    const verdict = evaluateCanvasV0PreInputControls({ surfaceReady: true, sidecarOpen: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(expect.arrayContaining(['sidecarOpen', 'editorReady', 'composerReady']));
  });

  it('skips the upload control check when no reference is staged', () => {
    expect(evaluateCanvasV0PreInputControls({
      surfaceReady: true,
      sidecarOpen: true,
      editorReady: true,
      composerReady: true,
      uploadControlReady: false,
      requireUploadControl: false,
    })).toMatchObject({ ok: true });
  });

  it('evaluates the content checkpoint on anchors, references and assetId', () => {
    const editorTextNormalized = normalizeV0EditorText('指令段 资产编号：abcd1234 请以参考图为主角。');
    const good = evaluateCanvasV0Checkpoint(
      {
        surfaceReady: true,
        referenceCount: 1,
        editorTextNormalized,
        assetIdPresent: true,
        processingCount: 0,
        submitEnabled: true,
      },
      { expectedReferences: 1, textAnchors: ['资产编号：abcd1234', '请以参考图为主角。'] },
    );
    expect(good.ok).toBe(true);

    const bad = evaluateCanvasV0Checkpoint(
      {
        surfaceReady: true,
        referenceCount: 2,
        editorTextNormalized: normalizeV0EditorText('只有前半段'),
        assetIdPresent: false,
        processingCount: 0,
        requireSubmitArmed: true,
      },
      { expectedReferences: 1, textAnchors: ['资产编号：abcd1234'] },
    );
    expect(bad.ok).toBe(false);
    expect(bad.failures).toEqual(expect.arrayContaining([
      'referenceCount',
      'promptAnchorsInOrder',
      'assetIdPresent',
      'submitArmed',
    ]));
    expect(bad.anchorMismatch?.anchor).toBe('资产编号：abcd1234');
  });

  it('evaluates submit readiness', () => {
    expect(evaluateCanvasV0SubmitReadiness({ editorHasPrompt: true, sendEnabled: true, sidecarOpen: true }))
      .toMatchObject({ ok: true });
    expect(evaluateCanvasV0SubmitReadiness({ editorHasPrompt: false, sendEnabled: false, sidecarOpen: true }))
      .toMatchObject({ ok: false, failures: ['editorHasPrompt', 'sendEnabled'] });
  });

  it('normalizes editor text consistently for anchors', () => {
    expect(normalizeV0EditorText(' a\u00a0b\u200bc ')).toBe('abc');
  });
});

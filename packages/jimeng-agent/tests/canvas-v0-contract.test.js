import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  JIMENG_CANVAS_V0_URL,
  V0_CREATE_PROJECT_DRAFT,
  V0_DEFAULT_PROJECT_NAME,
  V0_MAX_REFERENCE_ATTACHMENTS,
  V0_MAX_TITLE_LENGTH,
  buildCanvasV0CreateProjectBody,
  buildCanvasV0Url,
  canvasV0RecordStatusName,
  evaluateCanvasV0Checkpoint,
  evaluateCanvasV0PreInputControls,
  evaluateCanvasV0RecordState,
  evaluateCanvasV0SubmitReadiness,
  matchCanvasV0Attachment,
  matchCanvasV0AttachmentSet,
  normalizeCanvasV0AskArgs,
  normalizeCanvasV0CreateArgs,
  normalizeCanvasV0DownloadArgs,
  normalizeCanvasV0Identity,
  normalizeCanvasV0StatusArgs,
  normalizeV0EditorText,
  parseCanvasV0AssetId,
  parseCanvasV0ProjectIdFromHref,
  pickCanvasV0VideoDefinition,
  readCanvasV0CreatedProject,
  readCanvasV0RecordMedia,
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

  it('rejects more references than the legacy 对话 panel can keep', () => {
    // The panel keeps only the first and the newest attachment, so a third
    // reference would be dropped silently instead of attached.
    const three = { ...base, image: ['a.png', 'b.png', 'c.png'] };
    expect(() => normalizeCanvasV0AskArgs(three)).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0AskArgs(three))
      .toThrow(`accepts at most ${V0_MAX_REFERENCE_ATTACHMENTS} references, got 3`);

    const two = normalizeCanvasV0AskArgs({ ...base, image: ['a.png', 'b.png'] });
    expect(two.assets).toHaveLength(V0_MAX_REFERENCE_ATTACHMENTS);
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

describe('jimeng-agent canvas-v0 attachment matching', () => {
  const card = (kind, label = '') => ({ kind, label });

  it('binds image assets to image cards only', () => {
    expect(matchCanvasV0Attachment(card('image'), { kind: 'image', label: '图片1' })).toBe(true);
    expect(matchCanvasV0Attachment(card('attachment', '音频1'), { kind: 'image', label: '图片1' })).toBe(false);
    expect(matchCanvasV0Attachment(card('video'), { kind: 'image', label: '图片1' })).toBe(false);
    expect(matchCanvasV0Attachment(null, { kind: 'image' })).toBe(false);
    expect(matchCanvasV0Attachment(card('image'), null)).toBe(false);
  });

  it('binds video assets to a video card or to their labelled attachment card', () => {
    expect(matchCanvasV0Attachment(card('video'), { kind: 'video', label: '视频1' })).toBe(true);
    expect(matchCanvasV0Attachment(card('attachment', '视频1'), { kind: 'video', label: '视频1' })).toBe(true);
    expect(matchCanvasV0Attachment(card('attachment', '音频1'), { kind: 'video', label: '视频1' })).toBe(false);
    expect(matchCanvasV0Attachment(card('unknown'), { kind: 'video', label: '视频1' })).toBe(false);
  });

  it('binds audio assets to their labelled attachment card, which carries no <img>', () => {
    expect(matchCanvasV0Attachment(card('attachment', '音频1'), { kind: 'audio', label: '音频1' })).toBe(true);
    expect(matchCanvasV0Attachment(card('attachment', '音频2'), { kind: 'audio', label: '音频1' })).toBe(false);
    expect(matchCanvasV0Attachment(card('attachment'), { kind: 'audio', label: '音频1' })).toBe(false);
    expect(matchCanvasV0Attachment(card('image'), { kind: 'audio', label: '音频1' })).toBe(false);
    expect(matchCanvasV0Attachment(card('video'), { kind: 'audio', label: '音频1' })).toBe(false);
  });

  it('matches a set injectively, in asset order, and maximizes the bound assets', () => {
    const assets = [
      { kind: 'image', label: '图片1', filename: 'a.png' },
      { kind: 'audio', label: '音频1', filename: 'b.mp3' },
    ];
    const verdict = matchCanvasV0AttachmentSet([card('image'), card('attachment', '音频1')], assets);
    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.matched.map((entry) => entry.label)).toEqual(['图片1', '音频1']);

    // Cards may sit in any DOM order: the asset list drives which card is consumed.
    expect(matchCanvasV0AttachmentSet([card('attachment', '音频1'), card('image')], assets).ok).toBe(true);

    // One card can never satisfy two assets, even when both assets look identical.
    const duplicated = matchCanvasV0AttachmentSet([card('attachment', '音频1')], [
      { kind: 'audio', label: '音频1', filename: 'b.mp3' },
      { kind: 'audio', label: '音频1', filename: 'c.mp3' },
    ]);
    expect(duplicated.ok).toBe(false);
    expect(duplicated.missing).toEqual(['音频1']);
    expect(duplicated.matched).toHaveLength(1);
  });

  it('finds the perfect assignment regardless of how the ambiguous cards are ordered', () => {
    // A video card satisfies any video asset, so a first-fit pass binds 视频1 to
    // the bare card and strands 视频2 on 视频1's labelled card, reporting a valid
    // upload as missing. Both card orders must resolve to the same binding.
    const assets = [
      { kind: 'video', label: '视频1', filename: 'a.mp4' },
      { kind: 'video', label: '视频2', filename: 'b.mp4' },
    ];
    const cards = [card('video'), card('attachment', '视频1')];
    const binding = (verdict) => verdict.matched
      .map((entry) => [entry.label, entry.card.kind, entry.card.label]);

    const forward = matchCanvasV0AttachmentSet(cards, assets);
    expect(forward.ok).toBe(true);
    expect(forward.missing).toEqual([]);
    expect(binding(forward)).toEqual([['视频1', 'attachment', '视频1'], ['视频2', 'video', '']]);

    const reversed = matchCanvasV0AttachmentSet([...cards].reverse(), assets);
    expect(reversed.ok).toBe(true);
    expect(reversed.missing).toEqual([]);
    expect(binding(reversed)).toEqual(binding(forward));
  });

  it('recovers assets a first-fit pass would strand on an already consumed card', () => {
    // 视频3 only fits the bare video card, which a first-fit pass hands to 视频1.
    const assets = [
      { kind: 'video', label: '视频1', filename: 'a.mp4' },
      { kind: 'video', label: '视频2', filename: 'b.mp4' },
      { kind: 'video', label: '视频3', filename: 'c.mp4' },
    ];
    const cards = [card('video'), card('attachment', '视频1'), card('attachment', '视频2')];
    const verdict = matchCanvasV0AttachmentSet(cards, assets);

    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.matched.map((entry) => [entry.label, entry.card.kind, entry.card.label])).toEqual([
      ['视频1', 'attachment', '视频1'],
      ['视频2', 'attachment', '视频2'],
      ['视频3', 'video', ''],
    ]);
    expect(matchCanvasV0AttachmentSet([...cards].reverse(), assets).ok).toBe(true);
  });

  it('lists the labels that no observed card satisfies', () => {
    const verdict = matchCanvasV0AttachmentSet([card('image')], [
      { kind: 'image', label: '图片1' },
      { kind: 'audio', label: '音频1' },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(['音频1']);
  });
});

describe('jimeng-agent canvas-v0 verdicts', () => {
  it('evaluates pre-input controls', () => {
    expect(evaluateCanvasV0PreInputControls({
      surfaceReady: true,
      sidecarOpen: true,
      composerInSidecar: true,
      editorReady: true,
      composerReady: true,
      uploadControlReady: true,
    })).toMatchObject({ ok: true, failures: [] });

    const verdict = evaluateCanvasV0PreInputControls({ surfaceReady: true, sidecarOpen: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'sidecarOpen',
      'composerInSidecar',
      'editorReady',
      'composerReady',
    ]));
  });

  it('rejects a composer that is open outside the 对话 panel', () => {
    // The canvas bottom composer shares the prompt document with the panel, so
    // a docked panel must be asserted separately from "a composer exists".
    const verdict = evaluateCanvasV0PreInputControls({
      surfaceReady: true,
      composerReady: true,
      editorReady: true,
      uploadControlReady: true,
      sidecarOpen: false,
      composerInSidecar: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(['sidecarOpen', 'composerInSidecar']);
  });

  it('skips the upload control check when no reference is staged', () => {
    expect(evaluateCanvasV0PreInputControls({
      surfaceReady: true,
      sidecarOpen: true,
      composerInSidecar: true,
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
        sidecarOpen: true,
        composerInSidecar: true,
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
      'sidecarOpen',
      'composerInSidecar',
      'referenceCount',
      'promptAnchorsInOrder',
      'assetIdPresent',
      'submitArmed',
    ]));
    expect(bad.anchorMismatch?.anchor).toBe('资产编号：abcd1234');
  });

  it('fails the checkpoint when the 对话 panel is closed even though the anchors match', () => {
    // A closed panel still renders the shared prompt document off-screen, so
    // anchors alone must never be treated as a prepared draft.
    const editorTextNormalized = normalizeV0EditorText('资产编号：abcd1234 请以参考图为主角。');
    const verdict = evaluateCanvasV0Checkpoint(
      {
        surfaceReady: true,
        sidecarOpen: false,
        composerInSidecar: false,
        referenceCount: 0,
        editorTextNormalized,
        assetIdPresent: true,
        processingCount: 0,
      },
      { expectedReferences: 0, textAnchors: ['资产编号：abcd1234'] },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(['sidecarOpen', 'composerInSidecar']);
  });

  it('evaluates submit readiness', () => {
    expect(evaluateCanvasV0SubmitReadiness({
      editorHasPrompt: true,
      sendEnabled: true,
      sidecarOpen: true,
      composerInSidecar: true,
    })).toMatchObject({ ok: true });
    expect(evaluateCanvasV0SubmitReadiness({ editorHasPrompt: false, sendEnabled: false, sidecarOpen: true }))
      .toMatchObject({ ok: false, failures: ['editorHasPrompt', 'sendEnabled', 'composerInSidecar'] });
  });

  it('normalizes editor text consistently for anchors', () => {
    expect(normalizeV0EditorText(' a\u00a0b\u200bc ')).toBe('abc');
  });
});

describe('jimeng-agent canvas-v0 read-back contract', () => {
  const PROMPT = [
    '(必须使用 Seedance2.0 Fast 模型，**禁止使用 VIP 模型**），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    '资产编号：58674724fb245869',
    '',
    '---',
    '',
    '请以参考图中的浣熊为主角。',
  ].join('\n');

  const RECORD = {
    status: 50,
    generate_type: 10,
    finish_time: 1785513856,
    fail_starling_message: '',
    item_list: [{
      common_attr: { id: '7668620787527585034', status: 144, prompt: PROMPT, cover_url: 'https://cover.example/a.jpg' },
      video: {
        duration: 16,
        video_id: 'v02870g10004d9mcepa7dld73qhv779g',
        transcoded_video: {
          '360p': { video_url: 'https://cdn/360.mp4', md5: 'aa', size: 881942, width: 640, height: 360 },
          '480p': { video_url: 'https://cdn/480.mp4', md5: 'bb', size: 1412765, width: 854, height: 480 },
          '720p': { video_url: 'https://cdn/720.mp4', md5: 'cc', size: 2674291, width: 1280, height: 720 },
          origin: { video_url: 'https://cdn/origin.mp4', md5: 'dd', size: 25543346, width: 1280, height: 720 },
        },
      },
    }],
  };

  it('parses 资产编号 out of a composed legacy prompt', () => {
    expect(parseCanvasV0AssetId(PROMPT)).toBe('58674724fb245869');
    expect(parseCanvasV0AssetId('资产编号: 58674724FB245869')).toBe('58674724fb245869');
    expect(parseCanvasV0AssetId('资产编号：58674724fb24586')).toBe('');
    expect(parseCanvasV0AssetId('')).toBe('');
  });

  it('reads media definitions in quality order without guessing urls', () => {
    const media = readCanvasV0RecordMedia(RECORD);
    expect(media.itemId).toBe('7668620787527585034');
    expect(media.duration).toBe(16);
    expect(media.definitions.map((entry) => entry.definition)).toEqual(['origin', '720p', '480p', '360p']);
    expect(media.definitions[1]).toMatchObject({ url: 'https://cdn/720.mp4', md5: 'cc', size: 2674291 });
  });

  it('falls back to a definition-less item when the record has no video', () => {
    const media = readCanvasV0RecordMedia({
      item_list: [{ common_attr: { id: '1', status: 20, prompt: 'prompt only' } }],
    });
    expect(media).toMatchObject({ itemId: '1', definitions: [] });
    expect(readCanvasV0RecordMedia({})).toBeNull();
  });

  it('classifies a record as ready, failed or pending from observed fields', () => {
    const media = readCanvasV0RecordMedia(RECORD);
    expect(evaluateCanvasV0RecordState(RECORD, media)).toEqual({ state: 'ready', reason: '' });
    expect(evaluateCanvasV0RecordState({ ...RECORD, fail_starling_message: '审核不通过' }, media))
      .toEqual({ state: 'failed', reason: '审核不通过' });
    expect(evaluateCanvasV0RecordState({ status: 20 }, { definitions: [] }))
      .toEqual({ state: 'pending', reason: '' });
  });

  it('names only the status codes that were observed live', () => {
    expect(canvasV0RecordStatusName(50)).toBe('finished');
    expect(canvasV0RecordStatusName('50')).toBe('finished');
    expect(canvasV0RecordStatusName(20)).toBe('');
    expect(canvasV0RecordStatusName('')).toBe('');
  });

  it('picks the requested definition and reports a fallback', () => {
    const media = readCanvasV0RecordMedia(RECORD);
    expect(pickCanvasV0VideoDefinition(media, '480p')).toMatchObject({ definition: '480p', fallback: false });
    expect(pickCanvasV0VideoDefinition(media, '4096p')).toMatchObject({ definition: 'origin', fallback: true });
    expect(pickCanvasV0VideoDefinition(media, '')).toMatchObject({ definition: '720p', fallback: false });
    expect(pickCanvasV0VideoDefinition({ definitions: [] }, '720p')).toBeNull();
  });

  it('normalizes status args with filters and a bounded limit', () => {
    expect(normalizeCanvasV0StatusArgs({ canvas: '17883546906892' })).toEqual({
      canvas: '17883546906892',
      canvasMode: 'existing',
      projectId: '17883546906892',
      assetId: '',
      recordId: '',
      limit: 20,
    });
    expect(normalizeCanvasV0StatusArgs({
      canvas: '17883546906892',
      asset_id: '58674724FB245869',
      record_id: '39441026984460',
      limit: 5,
    })).toMatchObject({ assetId: '58674724fb245869', recordId: '39441026984460', limit: 5 });
    expect(() => normalizeCanvasV0StatusArgs({ canvas: 'new' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0StatusArgs({ canvas: '17883546906892', asset_id: 'short' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0StatusArgs({ canvas: '17883546906892', record_id: 'abc' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0StatusArgs({ canvas: '17883546906892', limit: 0 })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0StatusArgs({ canvas: '17883546906892', limit: 1000 })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0StatusArgs({ canvas: '17883546906892', typo: 1 })).toThrow(ArgumentError);
  });

  it('normalizes download args and rejects conflicting selectors', () => {
    const defaults = normalizeCanvasV0DownloadArgs({ canvas: '17883546906892' });
    expect(defaults).toMatchObject({ recordId: '', assetId: '', definition: '720p' });
    expect(defaults.outputDir).toMatch(/Downloads[/\\]jimeng-agent$/);
    expect(normalizeCanvasV0DownloadArgs({ canvas: '17883546906892', output: '/tmp/v0-dl' }))
      .toMatchObject({ outputDir: '/tmp/v0-dl' });
    expect(() => normalizeCanvasV0DownloadArgs({
      canvas: '17883546906892',
      record_id: '39441026984460',
      asset_id: '58674724fb245869',
    })).toThrow(ArgumentError);
    expect(() => normalizeCanvasV0DownloadArgs({ canvas: '17883546906892', definition: '4k' })).toThrow(ArgumentError);
  });

  it('fails the checkpoint when 自动 was observed off', () => {
    const base = {
      surfaceReady: true,
      sidecarOpen: true,
      composerInSidecar: true,
      referenceCount: 0,
      promptAnchorsInOrder: true,
      processingCount: 0,
      assetIdPresent: true,
    };
    const expectations = { expectedReferences: 0, textAnchors: [] };
    expect(evaluateCanvasV0Checkpoint({ ...base, autoEnabled: true }, expectations).ok).toBe(true);
    // An unreadable mirror does not fail the checkpoint: the configure step already
    // enabled 自动 fail-closed before this gate runs.
    expect(evaluateCanvasV0Checkpoint({ ...base, autoEnabled: null }, expectations).ok).toBe(true);

    const off = evaluateCanvasV0Checkpoint({ ...base, autoEnabled: false }, expectations);
    expect(off.ok).toBe(false);
    expect(off.failures).toContain('autoPreference');
  });
});

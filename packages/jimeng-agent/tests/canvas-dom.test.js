import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCanvasMentionSegments,
  canvasMentionTextMatchesVariant,
  clearCanvasComposer,
  evaluateCanvasSubmitUIState,
  fillCanvasPrompt,
  getCanvasMimeType,
  prepareJimengCanvasAsk,
  probeJimengCanvasSurface,
  runCanvasContentCheckpoint,
  submitCanvasPreparedGeneration,
  uploadCanvasReferenceAssets,
  waitForCanvasSubmitReady,
  waitForCanvasSurface,
} from '../src/canvas-dom.js';
import {
  JIMENG_CANVAS_URL,
  normalizeCanvasAskArgs,
} from '../src/canvas-contract.js';
import {
  JIMENG_CANVAS_CAPTURE_PATTERN,
  JIMENG_CANVAS_SEND_PATH,
} from '../src/canvas-submit-ack.js';

const ASSET_ID = 'b7e4f19a2c0d5e68';
const PRE_CLICK_UI = Object.freeze({
  assetIdInComposer: true,
  assetIdOutsideComposer: false,
  composerEmpty: false,
  agentBusy: false,
});
const SENT_UI = Object.freeze({
  assetIdInComposer: false,
  assetIdOutsideComposer: true,
  composerEmpty: true,
  agentBusy: true,
});
let tempDir = '';

function assertEvaluableExpression(expression) {
  if (typeof expression === 'string') {
    // Parse generated browser scripts so interpolation mistakes fail offline.
    Function(`return (${expression});`);
  }
}

function makeEntry(overrides = {}) {
  return {
    url: `https://jimeng.jianying.com${JIMENG_CANVAS_SEND_PATH}`,
    method: 'POST',
    status: 200,
    requestBody: JSON.stringify({
      text: `资产编号：${ASSET_ID}`,
      session_id: 'canvas-session',
    }),
    responseBody: JSON.stringify({
      code: 0,
      message: 'success',
      session_id: 'canvas-session',
    }),
    ...overrides,
  };
}

function createSubmitPageMock({
  startCaptureOk = true,
  drainEntries = [],
  capturedEntries = [],
  drainError = null,
  captureReadError = null,
  uiStates = [PRE_CLICK_UI],
  clickError = null,
  sendButtonFound = true,
} = {}) {
  let now = 1_000_000;
  let readCount = 0;
  let uiReadCount = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  const page = {
    goto: vi.fn(async () => undefined),
    startNetworkCapture: vi.fn(async () => startCaptureOk),
    readNetworkCapture: vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) {
        if (drainError) throw drainError;
        return drainEntries;
      }
      if (captureReadError) throw captureReadError;
      return capturedEntries;
    }),
    evaluate: vi.fn(async (expression) => {
      assertEvaluableExpression(expression);
      if (expression.includes("const marker = '资产编号：'")) {
        const index = Math.min(uiReadCount, uiStates.length - 1);
        uiReadCount += 1;
        return uiStates[index];
      }
      if (expression.includes('findCanvasSendButton(true)')) {
        return { ok: sendButtonFound };
      }
      return { ok: true };
    }),
    click: vi.fn(async () => {
      if (clickError) throw clickError;
      return { ok: true };
    }),
    sleep: vi.fn(async (seconds) => {
      now += Math.max(10, Math.round(Number(seconds || 0.05) * 1000));
    }),
    nativeKeyPress: vi.fn(async () => undefined),
    insertText: vi.fn(async () => undefined),
    get readCount() {
      return readCount;
    },
  };
  return page;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) {
    fs.rmSync(tempDir, { force: true, recursive: true });
    tempDir = '';
  }
});

describe('jimeng-agent/canvas-dom — media type coverage', () => {
  it.each([
    ['hero.png', 'image', 'image/png'],
    ['hero.HEIC', 'image', 'image/heic'],
    ['hero.tif', 'image', 'image/tiff'],
    ['motion.mp4', 'video', 'video/mp4'],
    ['motion.mov', 'video', 'video/quicktime'],
    ['voice.mp3', 'audio', 'audio/mpeg'],
    ['voice.wav', 'audio', 'audio/wav'],
  ])('maps %s reference MIME type', (filename, kind, expected) => {
    expect(getCanvasMimeType(filename, kind)).toBe(expected);
  });
});

describe('jimeng-agent/canvas-dom — rich mention preparation', () => {
  const assets = [
    {
      kind: 'image',
      label: '图片1',
      filename: 'hero.png',
      mentionName: 'hero',
    },
    {
      kind: 'video',
      label: '视频1',
      filename: 'motion.mp4',
      mentionName: 'motion',
    },
  ];

  // Segmenting first prevents any validated resource placeholder from silently falling back to text.
  it('preserves text order while binding every validated resource placeholder', () => {
    expect(buildCanvasMentionSegments('前@图片1中@视频1后@图片1', assets)).toEqual([
      { type: 'text', value: '前' },
      { type: 'mention', label: '图片1', asset: assets[0] },
      { type: 'text', value: '中' },
      { type: 'mention', label: '视频1', asset: assets[1] },
      { type: 'text', value: '后' },
      { type: 'mention', label: '图片1', asset: assets[0] },
    ]);
  });

  it('matches rendered mention labels without confusing 图片1 and 图片10', () => {
    expect(canvasMentionTextMatchesVariant('图片1.png', '图片1')).toBe(true);
    expect(canvasMentionTextMatchesVariant('@图片1', '图片1')).toBe(true);
    expect(canvasMentionTextMatchesVariant('图片10.png', '图片1')).toBe(false);
  });

  // Without the composer model the editor owns the caret after typed text, so
  // mentions must be anchored to the end or they land mid-prompt.
  function createFillPromptPage({ modelInsertion, events, mentions }) {
    const state = { count: 0, labels: [] };
    return {
      click: vi.fn(async (selector) => {
        if (selector.includes('mention-candidate-')) {
          const label = mentions[state.count];
          if (typeof label === 'string') {
            state.count += 1;
            state.labels.push(label);
            events.push(`mention:${label}`);
          }
        }
        return { ok: true };
      }),
      sleep: vi.fn(async () => undefined),
      nativeKeyPress: vi.fn(async () => undefined),
      insertText: vi.fn(async () => {
        events.push('typed-text');
      }),
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        if (expression.includes('insertSegments')) {
          if (!modelInsertion) return { ok: false };
          events.push('model-text');
          return { ok: true, via: 'insertSegments' };
        }
        if (expression.includes('range.selectNodeContents')) {
          events.push('caret-at-end');
          return { ok: true };
        }
        if (expression.includes('const inlineNodes = separator')) {
          return {
            editorFound: true,
            count: state.count,
            labels: [...state.labels],
            menuVisible: false,
          };
        }
        if (expression.includes('mention-button-not-found')) return { ok: true };
        if (expression.includes('return canvasVisible(panel)')) return true;
        if (expression.includes('mention-candidate-')) return { ok: true };
        return undefined;
      }),
    };
  }

  it('anchors the caret before every mention when the composer model is unavailable', async () => {
    const events = [];
    const mentions = ['图片1', '视频1'];
    const page = createFillPromptPage({ modelInsertion: false, events, mentions });

    await fillCanvasPrompt(page, '前@图片1中@视频1后', assets);

    expect(events).toEqual([
      'caret-at-end',
      'typed-text',
      'caret-at-end',
      'mention:图片1',
      'caret-at-end',
      'typed-text',
      'caret-at-end',
      'mention:视频1',
      'caret-at-end',
      'typed-text',
    ]);
  });

  it('leaves the caret to the composer model when model insertion is available', async () => {
    const events = [];
    const mentions = ['图片1', '视频1'];
    const page = createFillPromptPage({ modelInsertion: true, events, mentions });

    await fillCanvasPrompt(page, '前@图片1中@视频1后', assets);

    expect(events).toEqual([
      'model-text',
      'mention:图片1',
      'model-text',
      'mention:视频1',
      'model-text',
    ]);
    expect(page.insertText).not.toHaveBeenCalled();
  });

  // Consecutive submissions must not replace the stop control with a mistaken send click.
  it('waits for three stable idle polls after an active Canvas Agent turn', async () => {
    let now = 1_000;
    const states = [
      { busy: true, reason: 'canvas-agent-stop' },
      { busy: false, reason: 'idle' },
      { busy: false, reason: 'idle' },
      { busy: false, reason: 'idle' },
    ];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = {
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        return states.shift() || { busy: false, reason: 'idle' };
      }),
      sleep: vi.fn(async (seconds) => {
        now += Math.round(seconds * 1000);
      }),
    };

    await expect(waitForCanvasSubmitReady(page, 5_000)).resolves.toMatchObject({
      busy: false,
      reason: 'idle',
    });
    expect(page.evaluate).toHaveBeenCalledTimes(4);
  });

  it('fails closed when the Canvas Agent remains busy', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = {
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        return { busy: true, reason: 'canvas-agent-stop' };
      }),
      sleep: vi.fn(async (seconds) => {
        now += Math.round(seconds * 1000);
      }),
    };

    await expect(waitForCanvasSubmitReady(page, 1_000)).rejects.toMatchObject({
      phase: 'agent-busy',
      nonRetryable: true,
    });
  });
});

describe('jimeng-agent/canvas-dom — adaptive locator generation', () => {
  // Canvas uploads must use the Browser Bridge file transport, never inline file bytes.
  it('uses setFileInput without a base64 or synthetic File fallback', () => {
    const source = fs.readFileSync(
      new URL('../src/canvas-dom.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('page.setFileInput([asset.browserPath], uploadInput.selector)');
    expect(source).not.toContain("buffer.toString('base64')");
    expect(source).not.toContain('const file = new File');
  });

  it('keeps semantic editor/control fallbacks and unique send selection', async () => {
    let script = '';
    const page = {
      evaluate: vi.fn(async (expression) => {
        script = expression;
        assertEvaluableExpression(expression);
        return {};
      }),
    };

    await probeJimengCanvasSurface(page);

    expect(script).toContain('[data-testid=\\"prompt-composer\\"]');
    expect(script).toContain('[role="textbox"][contenteditable="true"]');
    expect(script).toContain('canvas-agent-session-composer');
    expect(script).toContain('findCanvasCommonAncestor');
    expect(script).toContain('exact.length === 1');
    expect(script).toContain('exact.length > 1');
    expect(script).toContain("button.matches(':disabled')");
    expect(script).toContain("button.classList.contains('disabled')");
    expect(script).not.toContain("className || '').toLowerCase().includes('disabled')");
    expect(script).toContain('button, [role="button"]');
    expect(script).toContain('semantic.length === 1');
    expect(script).toContain('submitButtons.length === 1');
    expect(script).toContain('data-initial-content-ready');
    expect(script).toContain('realLauncherReady');
    expect(script).toContain('const hydratedReady = flowReady');
  });

  it('searches multiple React anchors and prefers a complete upload-capable model', async () => {
    const scripts = [];
    const page = {
      evaluate: vi.fn(async (expression) => {
        scripts.push(expression);
        assertEvaluableExpression(expression);
        if (expression.includes("reason: 'editor-not-found'")) return { ok: true };
        if (expression.includes('editorFound: true')) {
          return { empty: true, editorFound: true, textLength: 0, chips: 0 };
        }
        return undefined;
      }),
      nativeKeyPress: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
    };

    await clearCanvasComposer(page);
    const modelScript = scripts.find((script) => script.includes('canvasModelScore'));

    expect(modelScript).toContain('canvas-agent-composer-action-row');
    expect(modelScript).toContain('fiber = fiber.return');
    expect(modelScript).toContain('anchors.push(node)');
    expect(modelScript).toContain('bestScore >= 400');
  });

  // A poisoned persistent tab is replaced only after a real project route stays in preparing.
  it('recovers a stale preparing tab with one fresh tab lease', async () => {
    let now = 1_000;
    let recovered = false;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = {
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        return recovered
          ? {
            href: `${JIMENG_CANVAS_URL}/project-stale`,
            canvasReady: true,
            preparing: false,
            ready: true,
          }
          : {
            href: `${JIMENG_CANVAS_URL}/project-stale`,
            canvasReady: false,
            preparing: true,
            ready: false,
          };
      }),
      sleep: vi.fn(async (seconds) => {
        now += Math.round(seconds * 1000);
      }),
      getActivePage: vi.fn(() => 'old-page'),
      newTab: vi.fn(async () => 'new-page'),
      setActivePage: vi.fn(() => {
        recovered = true;
      }),
      closeTab: vi.fn(async () => undefined),
    };

    await expect(waitForCanvasSurface(page, 6_000)).resolves.toMatchObject({
      ready: true,
    });
    expect(page.newTab).toHaveBeenCalledTimes(1);
    expect(page.setActivePage).toHaveBeenCalledWith('new-page');
    expect(page.closeTab).toHaveBeenCalledWith('old-page');
  });
});

describe('jimeng-agent/canvas-dom — preparation scenarios', () => {
  function createPreparedScenario(specs) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-canvas-dom-'));
    return specs.map((spec) => {
      const nodePath = path.join(tempDir, spec.filename);
      fs.writeFileSync(nodePath, `fixture:${spec.filename}`);
      return {
        kind: spec.kind,
        label: spec.label,
        filename: spec.filename,
        nodePath,
        localPath: nodePath,
        browserPath: nodePath,
      };
    });
  }

  function createPreparationPage(canonical, preparedAssets) {
    let uploadedCount = 0;
    const uploadedFilenames = [];
    const richMentionLabels = [];
    let mentionMenuOpen = false;
    const projectId = canonical.projectId || 'project-scenario';
    const canvasUrl = `${JIMENG_CANVAS_URL}/${projectId}`;
    const page = {
      goto: vi.fn(async () => undefined),
      click: vi.fn(async (selector) => {
        if (selector.includes('jimeng-canvas-mention-button-')) {
          mentionMenuOpen = true;
        } else if (selector.includes('jimeng-canvas-mention-candidate-')) {
          const mention = canonical.mentions[richMentionLabels.length];
          if (mention) richMentionLabels.push(mention.label);
          mentionMenuOpen = false;
        }
        return { ok: true };
      }),
      setFileInput: vi.fn(async ([browserPath]) => {
        const asset = preparedAssets[uploadedCount];
        expect(browserPath).toBe(asset.browserPath);
        uploadedFilenames.push(asset.filename);
        uploadedCount += 1;
      }),
      sleep: vi.fn(async () => undefined),
      nativeKeyPress: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
      evaluate: vi.fn(async (expression) => {
        if (typeof expression === 'function') {
          return canvasUrl;
        }
        assertEvaluableExpression(expression);
        if (expression.includes("reason: 'materializer-not-ready'")) {
          return {
            ok: true,
            projectId,
            projectCreated: true,
            projectExposed: true,
            projectMaterialized: true,
          };
        }
        if (expression.includes('/octo_api/v1/project/update')) {
          return {
            httpOk: true,
            status: 200,
            body: {
              ret: '0',
              errmsg: 'OK',
              logid: 'rename-log',
            },
            parseError: '',
          };
        }
        if (expression.includes('const inlineNodes = separator')) {
          return {
            editorFound: true,
            count: richMentionLabels.length,
            labels: [...richMentionLabels],
            menuVisible: mentionMenuOpen,
          };
        }
        if (expression.includes('mention-button-not-found')) {
          return { ok: true };
        }
        if (expression.includes('return canvasVisible(panel)')) {
          return mentionMenuOpen;
        }
        if (expression.includes('mention-category-not-found')) {
          return { ok: true };
        }
        if (expression.includes('mention-candidate-not-found')) {
          return {
            ok: true,
            text: canonical.mentions[richMentionLabels.length]?.label || '',
          };
        }
        if (expression.includes('return canvasVisible(submenu)')) {
          return mentionMenuOpen;
        }
        if (expression.includes('const chipData = chips.map')) {
          return {
            href: canvasUrl,
            canvasReady: true,
            preparing: false,
            sidecarOpen: true,
            launcherVisible: true,
            editorReady: true,
            addControlReady: preparedAssets.length > 0,
            sendVisible: true,
            sendDisabled: false,
            chipCount: uploadedCount,
            chipData: preparedAssets.slice(0, uploadedCount).map((asset) => ({
              status: 'ready',
              label: asset.filename,
            })),
            alerts: [],
            ready: true,
          };
        }
        if (expression.includes('model?.composerRef?.current?.clear')) return undefined;
        if (expression.includes("reason: 'editor-not-found'")) return { ok: true };
        if (expression.includes('editorFound: true')) {
          return {
            empty: true,
            editorFound: true,
            textLength: 0,
            chips: 0,
          };
        }
        if (expression.includes('const registry = Object.create(null)')) return [];
        if (expression.includes('data-opencli-jimeng-canvas-alert-id')) return [];
        if (expression.includes("reason: 'composer-root-missing'")) {
          return {
            ok: true,
            selector: '[data-opencli-jimeng-canvas-upload-input="input"]',
          };
        }
        if (expression.includes('const file = input.files?.[0]')) {
          return {
            ok: true,
            attachmentId: `attachment-${uploadedCount}`,
            storageKey: `storage-${uploadedCount}`,
          };
        }
        if (expression.includes('__opencliJimengCanvasUploadBridge')) return {
          ok: true,
          fsaDisabled: true,
          pickerSuppressed: true,
        };
        if (expression.includes('upload-menu-item-not-found')) {
          return { ok: true, selector: '[data-opencli-jimeng-canvas-target="menu"]' };
        }
        if (expression.includes('upload-input-ambiguous')) {
          return {
            ok: true,
            selector: '[data-opencli-jimeng-canvas-upload-input="input"]',
          };
        }
        if (expression.includes('data-opencli-jimeng-canvas-upload-baseline')) {
          return { count: 1 };
        }
        if (expression.includes('delete registries')) return undefined;
        if (expression.includes('insertSegments([{ type:')) {
          return { ok: true, via: 'insertSegments' };
        }
        if (expression.includes('const uploadItems =')) {
          return {
            surfaceReady: true,
            referenceCount: preparedAssets.length,
            observedChipLabels: preparedAssets.map((asset) => asset.filename),
            processingCount: 0,
            menuVisible: false,
            assetIdPresent: true,
            editorTextNormalized: canonical.agentPrompt.replace(/[\u00a0\u200b\s]+/g, ''),
            richMentionCount: canonical.mentions.length,
            richMentionLabels: canonical.mentions.map((mention) => mention.label),
            submitEnabled: true,
          };
        }
        return undefined;
      }),
      get uploadedFilenames() {
        return uploadedFilenames;
      },
    };
    return page;
  }

  // The same prepare-only lifecycle must work for every public media combination.
  it.each([
    {
      name: 'pure text',
      kwargs: { prompt: '纯文字镜头' },
      specs: [],
    },
    {
      name: 'image',
      kwargs: { image: ['hero.png'], prompt: '以@图片1作为主体' },
      specs: [{ kind: 'image', label: '图片1', filename: 'hero.png' }],
    },
    {
      name: 'audio',
      kwargs: { audio: ['voice.wav'], prompt: '参考@音频1节奏' },
      specs: [{ kind: 'audio', label: '音频1', filename: 'voice.wav' }],
    },
    {
      name: 'video',
      kwargs: { video: ['motion.mp4'], prompt: '参考@视频1动作' },
      specs: [{ kind: 'video', label: '视频1', filename: 'motion.mp4' }],
    },
    {
      name: 'mixed',
      kwargs: {
        image: ['hero.png'],
        video: ['motion.mp4'],
        audio: ['voice.wav'],
        prompt: '@图片1保持人物，@视频1参考动作，@音频1参考节奏。',
      },
      specs: [
        { kind: 'image', label: '图片1', filename: 'hero.png' },
        { kind: 'video', label: '视频1', filename: 'motion.mp4' },
        { kind: 'audio', label: '音频1', filename: 'voice.wav' },
      ],
    },
  ])('prepares $name without submitting', async ({ kwargs, specs }) => {
    const canonical = normalizeCanvasAskArgs({
      canvas: 'new',
      ratio: '16:9',
      model_version: 'seedance2.0fast',
      duration: 4,
      submit: 0,
      ...kwargs,
    });
    const preparedAssets = createPreparedScenario(specs);
    const page = createPreparationPage(canonical, preparedAssets);

    const result = await prepareJimengCanvasAsk(page, canonical, preparedAssets);

    expect(result).toMatchObject({
      status: 'prepared',
      submitted: false,
      checkpointOk: true,
      references: specs.length,
      uploaded: specs.map((spec) => spec.filename),
      confirmation: 'none',
    });
    expect(page.uploadedFilenames).toEqual(specs.map((spec) => spec.filename));
    expect(page.setFileInput).toHaveBeenCalledTimes(specs.length);
  });

  it('opens and prepares an existing canvas without using the create route', async () => {
    const canonical = normalizeCanvasAskArgs({
      canvas: 'existing-project-123',
      ratio: '16:9',
      model_version: 'seedance2.0fast',
      duration: 4,
      prompt: '继续当前画布',
      submit: 0,
    });
    const preparedAssets = createPreparedScenario([]);
    const page = createPreparationPage(canonical, preparedAssets);

    const result = await prepareJimengCanvasAsk(page, canonical, preparedAssets);

    expect(page.goto).toHaveBeenCalledWith(`${JIMENG_CANVAS_URL}/existing-project-123`);
    expect(result).toMatchObject({
      status: 'prepared',
      canvasMode: 'existing',
      projectId: 'existing-project-123',
      canvasUrl: `${JIMENG_CANVAS_URL}/existing-project-123`,
    });
  });

  // Naming is persisted only after the create route resolves a real project id.
  it('names a newly-created canvas before preparing its draft', async () => {
    const canonical = normalizeCanvasAskArgs({
      canvas: 'new',
      title: '苏州猫咪短片',
      ratio: '16:9',
      model_version: 'seedance2.0fast',
      duration: 4,
      prompt: '测试镜头',
      submit: 0,
    });
    const preparedAssets = createPreparedScenario([]);
    const page = createPreparationPage(canonical, preparedAssets);

    const result = await prepareJimengCanvasAsk(page, canonical, preparedAssets);

    expect(result).toMatchObject({
      projectId: 'project-scenario',
      canvasTitle: '苏州猫咪短片',
      submitted: false,
    });
    const renameScript = page.evaluate.mock.calls
      .map(([expression]) => expression)
      .find((expression) => (
        typeof expression === 'string'
        && expression.includes('/octo_api/v1/project/update')
      ));
    expect(renameScript).toContain('"project_id":"project-scenario"');
    expect(renameScript).toContain('"name":"苏州猫咪短片"');
    expect(page.goto).toHaveBeenCalledWith(
      `${JIMENG_CANVAS_URL}/project-scenario?enter_from=page_click&from_page=create&opencli_materialized=1`,
    );
  });

  it('fails promptly when the current upload emits a failure alert', async () => {
    const preparedAssets = createPreparedScenario([
      { kind: 'image', label: '图片1', filename: 'rejected.png' },
    ]);
    let probeCount = 0;
    const page = {
      click: vi.fn(async () => ({ ok: true })),
      setFileInput: vi.fn(async () => undefined),
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        if (expression.includes('const chipData = chips.map')) {
          probeCount += 1;
          return {
            chipCount: 0,
            chipData: [],
            alerts: probeCount > 1
              ? [{ text: '素材上传失败', baselineId: '' }]
              : [],
          };
        }
        if (expression.includes('const registry = Object.create(null)')) return [];
        if (expression.includes("reason: 'composer-root-missing'")) {
          return {
            ok: true,
            selector: '[data-opencli-jimeng-canvas-upload-input="input"]',
          };
        }
        if (expression.includes('const file = input.files?.[0]')) {
          return { ok: true, attachmentId: 'attachment-1', storageKey: 'storage-1' };
        }
        if (expression.includes('__opencliJimengCanvasUploadBridge')) {
          return { ok: true, fsaDisabled: true, pickerSuppressed: true };
        }
        if (expression.includes('upload-menu-item-not-found')) {
          return { ok: true, selector: '[data-opencli-jimeng-canvas-target="menu"]' };
        }
        if (expression.includes('upload-input-ambiguous')) {
          return {
            ok: true,
            selector: '[data-opencli-jimeng-canvas-upload-input="input"]',
          };
        }
        if (expression.includes('data-opencli-jimeng-canvas-upload-baseline')) {
          return { count: 1 };
        }
        return undefined;
      }),
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      uploadCanvasReferenceAssets(page, preparedAssets, []),
    ).rejects.toMatchObject({
      phase: 'upload',
      failedAssetIndex: 0,
      message: expect.stringContaining('素材上传失败'),
    });
    expect(page.sleep).not.toHaveBeenCalled();
  });

  it('rejects a prompt whose middle content disappeared despite retaining core markers', async () => {
    const canonical = normalizeCanvasAskArgs({
      canvas: 'new',
      ratio: '16:9',
      model_version: 'seedance2.0fast',
      duration: 4,
      prompt: '镜头内容'.repeat(40),
    });
    const normalized = canonical.agentPrompt.replace(/[\u00a0\u200b\s]+/g, '');
    const page = {
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        return {
          surfaceReady: true,
          referenceCount: 0,
          observedChipLabels: [],
          processingCount: 0,
          menuVisible: false,
          assetIdPresent: true,
          editorTextNormalized: normalized.slice(0, 48) + normalized.slice(96),
          submitEnabled: true,
        };
      }),
    };

    await expect(
      runCanvasContentCheckpoint(page, canonical, []),
    ).rejects.toMatchObject({
      phase: 'checkpoint',
      message: expect.stringContaining('promptAnchorsInOrder'),
    });
  });
});

describe('jimeng-agent/canvas-dom — submit UI evidence', () => {
  // An assetId still present in the composer is draft evidence, not sent-message evidence.
  it('does not mistake composer text or a busy indicator for submission', () => {
    expect(evaluateCanvasSubmitUIState({
      ...PRE_CLICK_UI,
      agentBusy: true,
    })).toMatchObject({
      confirmed: false,
      assetIdInComposer: true,
      assetIdOutsideComposer: false,
    });
  });

  it('confirms only when the canonical assetId moved outside the composer', () => {
    expect(evaluateCanvasSubmitUIState(SENT_UI)).toMatchObject({
      confirmed: true,
      reason: 'message_bubble_rendered',
    });
  });

  it('does not confirm an ambiguous cleared composer without the sent message', () => {
    expect(evaluateCanvasSubmitUIState({
      assetIdInComposer: false,
      assetIdOutsideComposer: false,
      composerEmpty: true,
      agentBusy: true,
    })).toMatchObject({ confirmed: false });
  });
});

describe('jimeng-agent/canvas-dom — submit orchestration safety', () => {
  it('confirms a correlated server ACK and reads the destructive post-click buffer once', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [makeEntry()],
      uiStates: [PRE_CLICK_UI],
    });

    const result = await submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    );

    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ack_confirmed',
      sessionId: 'canvas-session',
      submitRequestCount: 1,
    });
    expect(page.startNetworkCapture).toHaveBeenCalledWith(JIMENG_CANVAS_CAPTURE_PATTERN);
    expect(page.readCount).toBe(2);
    expect(page.click).toHaveBeenCalledTimes(1);
  });

  it('accepts exact sent-message UI evidence when the transport endpoint is not captured', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      uiStates: [PRE_CLICK_UI, SENT_UI],
    });

    const result = await submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    );

    expect(result).toMatchObject({
      accepted: true,
      confirmation: 'ui_confirmed',
      submitRequestCount: 0,
      uiEvidence: 'message_bubble_rendered',
    });
  });

  // A definitive server rejection must override an optimistic message bubble.
  it('lets a server rejection override UI evidence', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [makeEntry({
        responseBody: JSON.stringify({ code: 10403, message: 'quota exceeded' }),
      })],
      uiStates: [PRE_CLICK_UI, SENT_UI],
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-rejected',
      retryable: false,
    });
  });

  it('returns safe not-sent only when the draft remains in the composer', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      uiStates: [{ ...PRE_CLICK_UI, agentBusy: true }],
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-not-sent',
      retryable: true,
    });
  });

  it('returns non-retryable unconfirmed when the draft vanished without a sent bubble', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      uiStates: [
        PRE_CLICK_UI,
        {
          assetIdInComposer: false,
          assetIdOutsideComposer: false,
          composerEmpty: true,
          agentBusy: false,
        },
      ],
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('allows UI confirmation to win when the browser click reports a transport error', async () => {
    const page = createSubmitPageMock({
      capturedEntries: [],
      uiStates: [PRE_CLICK_UI, SENT_UI],
      clickError: new Error('node detached after dispatch'),
    });

    const result = await submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    );
    expect(result.confirmation).toBe('ui_confirmed');
  });

  it('does not click again when the same assetId already exists in sent-message UI', async () => {
    const page = createSubmitPageMock({
      drainEntries: [],
      uiStates: [SENT_UI],
    });

    const result = await submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    );
    expect(result.confirmation).toBe('ui_confirmed');
    expect(page.click).not.toHaveBeenCalled();
    expect(page.readCount).toBe(1);
  });

  it('fails closed before clicking when the pre-click capture drain fails', async () => {
    const page = createSubmitPageMock({
      drainError: new Error('CDP capture detached'),
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-capture-unavailable',
      retryable: false,
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('returns unconfirmed after a post-click capture read failure without UI evidence', async () => {
    const page = createSubmitPageMock({
      captureReadError: new Error('CDP capture detached'),
      uiStates: [PRE_CLICK_UI],
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-unconfirmed',
      retryable: false,
    });
  });

  it('refuses to click when no unique enabled send control can be located', async () => {
    const page = createSubmitPageMock({
      sendButtonFound: false,
      uiStates: [PRE_CLICK_UI],
    });

    await expect(submitCanvasPreparedGeneration(
      page,
      { assetId: ASSET_ID },
      { timeoutMs: 100, pollIntervalMs: 50 },
    )).rejects.toMatchObject({
      phase: 'submit-button-missing',
      retryable: true,
    });
    expect(page.click).not.toHaveBeenCalled();
  });
});

describe('jimeng-agent/canvas-dom — composer cleanup safety', () => {
  function createClearPage(states) {
    let stateIndex = 0;
    return {
      evaluate: vi.fn(async (expression) => {
        assertEvaluableExpression(expression);
        if (expression.includes('editorFound: true')) {
          const index = Math.min(stateIndex, states.length - 1);
          stateIndex += 1;
          return states[index];
        }
        if (expression.includes("reason: 'editor-not-found'")) {
          return { ok: true };
        }
        return undefined;
      }),
      nativeKeyPress: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
    };
  }

  it('rechecks after the fallback delete and fails if stale content remains', async () => {
    const stale = { empty: false, editorFound: true, textLength: 8, chips: 0 };
    const page = createClearPage([stale, stale]);
    await expect(clearCanvasComposer(page)).rejects.toMatchObject({
      phase: 'clear-initial',
    });
  });

  it('accepts cleanup only after the composer is actually empty', async () => {
    const page = createClearPage([
      { empty: false, editorFound: true, textLength: 8, chips: 0 },
      { empty: true, editorFound: true, textLength: 0, chips: 0 },
    ]);
    await expect(clearCanvasComposer(page)).resolves.toBeUndefined();
  });
});

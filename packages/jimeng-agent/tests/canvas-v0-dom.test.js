import { describe, expect, it } from 'vitest';

import {
  clearCanvasV0References,
  createCanvasV0Project,
  probeJimengCanvasV0Surface,
  readCanvasV0ComposerState,
  runCanvasV0ContentCheckpoint,
  runJimengCanvasV0Create,
  submitCanvasV0PreparedGeneration,
  waitForCanvasV0Surface,
} from '../src/canvas-v0-dom.js';
import {
  JIMENG_CANVAS_V0_URL,
  buildCanvasV0CreateProjectBody,
  normalizeCanvasV0AskArgs,
} from '../src/canvas-v0-contract.js';

const PROJECT_ID = '22104771569420';
const ASSET_ID = 'cd3014e9eeadb1a6';
const CREATE_PATH = '/mweb/v1/infinite_canvas/create_project';

function createMockPage(handlers = []) {
  const calls = { evaluate: [], goto: [], keys: [], inserts: [], setFileInput: [] };
  const page = {
    calls,
    async evaluate(script) {
      const text = typeof script === 'function' ? `<function:${String(script).length}>` : String(script);
      calls.evaluate.push(text);
      if (calls.evaluate.length > 2000) {
        throw new Error('mock page: runaway evaluate loop');
      }
      for (const [marker, handler] of handlers) {
        if (text.includes(marker)) return handler(text, page);
      }
      return {};
    },
    async goto(url) {
      calls.goto.push(url);
      return {};
    },
    async sleep() {
      // Keep polling loops from spinning at full speed in tests.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {};
    },
    async click(selector) {
      calls.keys.push(['click', selector]);
      return {};
    },
    async nativeKeyPress(key, modifiers) {
      calls.keys.push([key, modifiers]);
      return {};
    },
    async insertText(text) {
      calls.inserts.push(text);
      return {};
    },
    async setFileInput(selector, filePath, options) {
      calls.setFileInput.push([selector, filePath, options]);
      return { ok: true };
    },
    async startNetworkCapture() {
      return {};
    },
    async readNetworkCapture() {
      return [];
    },
  };
  return page;
}

/** Every browser script must at least parse, or interpolation bugs stay invisible. */
function assertScriptsParse(scripts) {
  expect(scripts.length).toBeGreaterThan(0);
  for (const text of scripts) {
    if (text.startsWith('<function:')) continue;
    expect(() => Function(`return (${text});`)).not.toThrow();
  }
}

const transport = (body) => ({
  httpOk: true,
  status: 200,
  statusText: 'OK',
  body,
  parseError: '',
  bodyPreview: '',
});

const surfaceReadyHandler = (fields = {}) => [['surfaceReady:',
  (text) => (text.includes('surfaceReady:') && text.includes('launcherVisible:')
    ? {
      href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
      surfaceReady: true,
      composerReady: true,
      sidecarOpen: true,
      editorReady: true,
      launcherVisible: true,
      uploadControlReady: true,
      creationType: 'Agent 模式',
      referenceCount: 0,
      sendVisible: true,
      sendEnabled: true,
      ready: true,
      ...fields,
    }
    : undefined),
]];

describe('jimeng-agent canvas-v0 create flow', () => {
  it('creates the project through the page transport and opens it', async () => {
    const page = createMockPage([
      ['=> location.href', () => 'https://jimeng.jianying.com/ai-tool/asset'],
      [CREATE_PATH, () => transport({
        ret: '0',
        errmsg: 'success',
        data: { project_id: PROJECT_ID, draft_id: '22063470174988', version: '1' },
      })],
      ['surfaceReady:', () => ({
        href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
        surfaceReady: true,
        editorReady: true,
        composerReady: true,
        sidecarOpen: true,
        launcherVisible: true,
        uploadControlReady: true,
        creationType: 'Agent 模式',
        referenceCount: 0,
        sendVisible: true,
        sendEnabled: true,
        ready: true,
      })],
    ]);

    const rows = await runJimengCanvasV0Create(page, { title: '苏州猫咪' });

    expect(rows).toEqual([{
      status: 'created',
      projectId: PROJECT_ID,
      draftId: '22063470174988',
      canvasTitle: '苏州猫咪',
      canvasUrl: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
    }]);
    // The create API runs inside an authenticated Jimeng page, so a non-canvas
    // starting page is normalized to the asset center first.
    expect(page.calls.goto).toEqual([
      'https://jimeng.jianying.com/ai-tool/asset',
      `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
    ]);
    const createScript = page.calls.evaluate.find((text) => text.includes(CREATE_PATH));
    expect(createScript).toBeTruthy();
    expect(createScript).toContain(JSON.stringify(buildCanvasV0CreateProjectBody({ name: '苏州猫咪' })));
  });

  it('surfaces a readable failure when the create API rejects the request', async () => {
    const page = createMockPage([
      ['=> location.href', () => 'https://jimeng.jianying.com/ai-tool/asset'],
      [CREATE_PATH, () => transport({ ret: '1001', errmsg: 'Param, name too long' })],
    ]);

    await expect(createCanvasV0Project(page, { title: 'x'.repeat(20) }))
      .rejects.toThrow(/JIMENG_CANVAS_V0_CREATE_FAILED/);
  });

  it('waits for the canvas surface and reports the last probe when it never settles', async () => {
    const page = createMockPage([
      ['surfaceReady:', (text) => (text.includes('launcherVisible:')
        ? {
          href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
          surfaceReady: false,
          composerReady: false,
          sidecarOpen: false,
          editorReady: false,
          launcherVisible: false,
          uploadControlReady: false,
          creationType: '',
          referenceCount: 0,
          sendVisible: false,
          sendEnabled: false,
          ready: false,
        }
        : undefined)],
    ]);

    await expect(waitForCanvasV0Surface(page, 1)).rejects.toThrow(/Legacy canvas surface never became ready/);
    expect(page.calls.evaluate.length).toBeGreaterThan(0);
  });

  it('keeps generated locator scripts parseable', async () => {
    const page = createMockPage(surfaceReadyHandler());
    await probeJimengCanvasV0Surface(page);
    await readCanvasV0ComposerState(page).catch(() => null);
    assertScriptsParse(page.calls.evaluate);
  });
});

describe('jimeng-agent canvas-v0 reference hygiene', () => {
  it('removes leftover references until the composer is empty', async () => {
    let remaining = 2;
    const page = createMockPage([
      ['states: items.map', () => ({ count: remaining, alerts: [], states: [] })],
      ['remove-button', () => {
        remaining -= 1;
        return { ok: true };
      }],
    ]);

    const result = await clearCanvasV0References(page);

    expect(result).toEqual({ references: 0 });
    expect(remaining).toBe(0);
  });

  it('fails loudly when a reference cannot be removed', async () => {
    const page = createMockPage([
      ['states: items.map', () => ({ count: 1, alerts: [], states: [] })],
      ['remove-button', () => ({ ok: false, reason: 'remove-control-missing' })],
    ]);

    await expect(clearCanvasV0References(page))
      .rejects.toThrow(/remove-control-missing/);
  });
});

describe('jimeng-agent canvas-v0 checkpoint and submit safety', () => {
  const canonical = normalizeCanvasV0AskArgs({
    canvas: PROJECT_ID,
    prompt: '请以参考图为主角生成视频。',
    ratio: '16:9',
    model_version: 'seedance2.0fast',
    duration: 5,
    submit: 0,
  });

  const snapshotHandler = (overrides = {}) => ['editorTextNormalized,', () => ({
    surfaceReady: true,
    referenceCount: 1,
    editorTextNormalized: canonical.agentPrompt.replace(/[\u00a0\u200b\s]+/g, ''),
    assetIdPresent: true,
    processingCount: 0,
    submitEnabled: true,
    ...overrides,
  })];

  it('passes the checkpoint only when anchors, references and asset id all match', async () => {
    const page = createMockPage([snapshotHandler()]);
    const verdict = await runCanvasV0ContentCheckpoint(page, canonical, [{ name: 'ref.png' }]);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('rejects the checkpoint when the asset id is missing', async () => {
    const page = createMockPage([snapshotHandler({ assetIdPresent: false })]);
    await expect(runCanvasV0ContentCheckpoint(page, canonical, [{ name: 'ref.png' }]))
      .rejects.toThrow(/checkpoint failed: assetIdPresent/);
  });

  it('refuses to submit without an assetId before touching the page', async () => {
    const page = createMockPage();

    await expect(submitCanvasV0PreparedGeneration(page, { ...canonical, assetId: '' }))
      .rejects.toThrow(/assetId is required/);
    expect(page.calls.evaluate).toEqual([]);
  });

  it('never clicks send when the prepared prompt has already disappeared', async () => {
    const page = createMockPage([
      ['assetIdInComposer:', () => ({
        confirmed: false,
        assetIdInComposer: false,
        assetIdOutsideComposer: false,
        composerEmpty: true,
        agentBusy: false,
      })],
    ]);

    await expect(submitCanvasV0PreparedGeneration(page, { ...canonical, assetId: ASSET_ID }))
      .rejects.toThrow(/disappeared before the send click/);
    expect(page.calls.keys.filter(([key]) => key === 'click')).toEqual([]);
  });
});

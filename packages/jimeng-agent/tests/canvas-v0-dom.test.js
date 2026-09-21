import { describe, expect, it } from 'vitest';

import {
  clearCanvasV0References,
  configureCanvasV0Generation,
  createCanvasV0Project,
  ensureCanvasV0SidecarOpen,
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
  const calls = { evaluate: [], goto: [], keys: [], inserts: [], setFileInput: [], cdp: [] };
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
    async cdp(method) {
      calls.cdp.push(method);
      return {};
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
      autoEnabled: true,
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
          anyEditorReady: false,
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

  it('accepts a fresh canvas whose 对话 panel is still closed', async () => {
    // A brand new project opens with the panel closed and its composer at the
    // canvas bottom, so the surface wait must not require the docked panel.
    const page = createMockPage([
      ['surfaceReady:', (text) => (text.includes('launcherVisible:')
        ? {
          href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
          surfaceReady: true,
          composerReady: false,
          sidecarOpen: false,
          panelReady: false,
          editorReady: false,
          anyEditorReady: true,
          launcherVisible: true,
          uploadControlReady: true,
          creationType: '',
          referenceCount: 0,
          sendVisible: false,
          sendEnabled: false,
          ready: false,
        }
        : undefined)],
    ]);

    const state = await waitForCanvasV0Surface(page, 1_000);
    expect(state.surfaceReady).toBe(true);
    expect(state.sidecarOpen).toBe(false);
    expect(state.anyEditorReady).toBe(true);
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

describe('jimeng-agent canvas-v0 对话 panel docking', () => {
  const closedPanelProbe = {
    href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
    surfaceReady: true,
    composerReady: false,
    composerInSidecar: false,
    sidecarOpen: false,
    panelReady: false,
    editorReady: true,
    launcherVisible: true,
    uploadControlReady: true,
    creationType: 'Agent 模式',
    referenceCount: 0,
    sendVisible: false,
    sendEnabled: false,
    ready: false,
  };
  const dockedPanelProbe = { ...closedPanelProbe, composerReady: true, composerInSidecar: true, sidecarOpen: true, panelReady: true, sendVisible: true, sendEnabled: true, ready: true };

  const sidecarMarkHandler = () => ['setAttribute', (text) => (text.includes('sidecar-launcher')
    ? { ok: true, selector: '[data-opencli-jimeng-v0-target="sidecar-launcher"]' }
    : undefined)];
  const inPageClickHandler = () => ['node.click()', (text) => (text.includes('sidecar-launcher') ? true : undefined)];

  it('activates the tab and clicks the 对话 launcher in-page when the panel is closed', async () => {
    let probeCount = 0;
    const page = createMockPage([
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => {
        probeCount += 1;
        // The closed panel is mounted but sits outside the viewport, so the
        // probe keeps reporting a closed panel until the launcher is clicked.
        return probeCount > 1 ? dockedPanelProbe : closedPanelProbe;
      }],
    ]);

    const state = await ensureCanvasV0SidecarOpen(page);

    expect(state.panelReady).toBe(true);
    expect(state.opened).toBe(true);
    expect(page.calls.cdp).toEqual(['Page.bringToFront']);
    // The launcher is clicked inside the page: a marked selector round-trip goes
    // stale because the toolbar re-renders between mark and click.
    expect(page.calls.keys).toEqual([]);
    expect(page.calls.evaluate.filter((text) => text.includes('node.click()'))).toHaveLength(1);
  });

  it('does not click anything when the panel is already docked', async () => {
    const page = createMockPage([
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => dockedPanelProbe],
    ]);

    const state = await ensureCanvasV0SidecarOpen(page);

    expect(state.panelReady).toBe(true);
    expect(state.opened).toBe(false);
    expect(page.calls.keys).toEqual([]);
    expect(page.calls.evaluate.filter((text) => text.includes('sidecar-launcher'))).toEqual([]);
  });

  it('collapses a stalled slide-in instead of clicking the missing launcher', async () => {
    let probeCount = 0;
    const page = createMockPage([
      ['operation-button', (text) => (text.includes('collapse.click()') ? true : undefined)],
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => {
        probeCount += 1;
        // The app reports the panel open while its slide-in stalled off-screen:
        // no launcher to click, and the header collapse control is the way back.
        return probeCount > 2 ? dockedPanelProbe : { ...closedPanelProbe, launcherVisible: false };
      }],
    ]);

    const state = await ensureCanvasV0SidecarOpen(page);

    expect(state.panelReady).toBe(true);
    // The panel was already reported open, so this run did not open it itself.
    expect(state.opened).toBe(false);
    expect(page.calls.evaluate.filter((text) => text.includes('collapse.click()'))).toHaveLength(1);
    expect(page.calls.evaluate.filter((text) => text.includes('node.click()'))).toEqual([]);
  });

  it('reloads the project once before failing on a stalled panel', async () => {
    const page = createMockPage([
      ['operation-button', () => true],
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => ({ ...closedPanelProbe, launcherVisible: false, anyEditorReady: true })],
    ]);

    await expect(ensureCanvasV0SidecarOpen(page, 17_000))
      .rejects.toThrow(/reloads=1/);
    expect(page.calls.evaluate.filter((text) => text === 'location.reload()')).toHaveLength(1);
    expect(page.calls.evaluate.filter((text) => text.includes('collapse.click()'))).toHaveLength(1);
  });

  const generationHandlers = ({ autoInitiallyOn, autoMirror }) => {
    let autoEnabled = autoInitiallyOn;
    let popoverProbes = 0;
    return [
      ['const read = v0CreationTypeRead();',
        () => ({ text: 'Agent 模式', hasTarget: true, options: 0, selected: 'Agent 模式' })],
      ['const target = v0SettingsTrigger();',
        () => ({ ok: true, selector: '[data-opencli-jimeng-v0-target="generation-settings"]' })],
      ["detail: 'settings-panel-open'",
        () => {
          popoverProbes += 1;
          return popoverProbes === 1 ? { ok: true, detail: 'settings-panel-open' } : { ok: false, detail: 'popover-missing' };
        }],
      ['const label = "视频";', () => ({ ok: true, detail: 'radio-selected' })],
      ['autoEnabled: v0AutoPreference()', () => ({ autoEnabled: autoMirror })],
      ['[role="switch"]', (text) => {
        if (text.includes('setAttribute')) {
          return { ok: true, selector: '[data-opencli-jimeng-v0-target="auto-switch"]' };
        }
        if (text.includes('target.click();')) {
          autoEnabled = true;
          return true;
        }
        return { ok: autoEnabled, detail: `auto-switch aria-checked=${autoEnabled}` };
      }],
    ];
  };

  it('reuses an already open 生成偏好 popover instead of toggling it shut', async () => {
    let popoverProbes = 0;
    const page = createMockPage([
      ['const read = v0CreationTypeRead();',
        () => ({ text: 'Agent 模式', hasTarget: true, options: 0, selected: 'Agent 模式' })],
      ["detail: 'settings-panel-open'", () => {
        popoverProbes += 1;
        // Open on the first look, closed again after the Escape that ends the phase.
        return popoverProbes === 1 ? { ok: true, detail: 'settings-panel-open' } : { ok: false, detail: 'popover-missing' };
      }],
      ['const target = v0SettingsTrigger();',
        () => ({ ok: true, selector: '[data-opencli-jimeng-v0-target="generation-settings"]' })],
      ['const label = "视频";', () => ({ ok: true, detail: 'radio-selected' })],
      ['autoEnabled: v0AutoPreference()', () => ({ autoEnabled: true })],
      ['[role="switch"]', () => ({ ok: true, detail: 'auto-switch aria-checked=true' })],
    ]);

    const state = await configureCanvasV0Generation(page, {});

    expect(state.autoEnabled).toBe(true);
    expect(page.calls.evaluate.filter((text) => text.includes('.click();'))).toEqual([]);
  });

  it('turns the 自动 preference on after the video preference, like generate', async () => {
    const page = createMockPage(generationHandlers({ autoInitiallyOn: false, autoMirror: true }));

    const state = await configureCanvasV0Generation(page, {});

    expect(state.autoEnabled).toBe(true);
    expect(state.autoToggled).toBe(true);
    expect(state.creationType).toBe('Agent 模式');
    expect(page.calls.evaluate.filter((text) => text.includes('target.click();') && text.includes('switch'))).toHaveLength(1);
    // The video radio was already selected, so it is only read, never clicked.
    expect(page.calls.evaluate.filter((text) => text.includes('video-radio'))).toEqual([]);
  });

  it('leaves an already enabled 自动 preference untouched', async () => {
    const page = createMockPage(generationHandlers({ autoInitiallyOn: true, autoMirror: true }));

    const state = await configureCanvasV0Generation(page, {});

    expect(state.autoEnabled).toBe(true);
    expect(state.autoToggled).toBe(false);
    expect(page.calls.evaluate.filter((text) => text.includes('target.click();'))).toEqual([]);
  });

  it('fails closed when the 生成偏好 panel exposes no 自动 switch', async () => {
    const page = createMockPage([
      ['const read = v0CreationTypeRead();',
        () => ({ text: 'Agent 模式', hasTarget: true, options: 0, selected: 'Agent 模式' })],
      ['const target = v0SettingsTrigger();',
        () => ({ ok: true, selector: '[data-opencli-jimeng-v0-target="generation-settings"]' })],
      ["detail: 'settings-panel-open'", () => ({ ok: true, detail: 'settings-panel-open' })],
      ['const label = "视频";', () => ({ ok: true, detail: 'radio-selected' })],
      ['[role="switch"]', () => ({ ok: false, detail: 'auto-switch-not-found' })],
    ]);

    await expect(configureCanvasV0Generation(page, {}))
      .rejects.toThrow(/does not expose the 自动 switch/);
  });

  it('docks the panel on transports without cdp', async () => {
    let probeCount = 0;
    const page = createMockPage([
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => {
        probeCount += 1;
        return probeCount > 1 ? dockedPanelProbe : closedPanelProbe;
      }],
    ]);
    delete page.cdp;

    const state = await ensureCanvasV0SidecarOpen(page);

    expect(state.opened).toBe(true);
    expect(state.panelReady).toBe(true);
  });

  it('fails closed when the 对话 panel never docks', async () => {
    const page = createMockPage([
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => closedPanelProbe],
    ]);

    await expect(ensureCanvasV0SidecarOpen(page, 400))
      .rejects.toThrow(/对话 panel is not docked/);
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
    sidecarOpen: true,
    composerInSidecar: true,
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

  it('rejects the checkpoint when the prompt sits outside the docked panel', async () => {
    const page = createMockPage([snapshotHandler({ sidecarOpen: false, composerInSidecar: false })]);
    await expect(runCanvasV0ContentCheckpoint(page, canonical, [{ name: 'ref.png' }]))
      .rejects.toThrow(/checkpoint failed: sidecarOpen, composerInSidecar/);
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
      .rejects.toThrow(/was not in the docked 对话 composer before the send click/);
    expect(page.calls.keys.filter(([key]) => key === 'click')).toEqual([]);
  });

  it('never clicks send when the panel is not docked', async () => {
    const page = createMockPage([
      ['assetIdInComposer:', () => ({
        confirmed: false,
        assetIdInComposer: true,
        assetIdOutsideComposer: false,
        composerEmpty: false,
        agentBusy: false,
        error: 'panel-not-docked',
      })],
      ['surfaceReady:', () => ({
        href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
        surfaceReady: true,
        composerReady: false,
        composerInSidecar: false,
        sidecarOpen: false,
        panelReady: false,
        editorReady: true,
        launcherVisible: true,
        uploadControlReady: true,
        creationType: 'Agent 模式',
        referenceCount: 0,
        sendVisible: false,
        sendEnabled: false,
        ready: false,
      })],
    ]);

    await expect(submitCanvasV0PreparedGeneration(page, { ...canonical, assetId: ASSET_ID }))
      .rejects.toThrow(/panel is not ready for submit \(sendEnabled, sidecarOpen, composerInSidecar\)/);
    expect(page.calls.keys.filter(([key]) => key === 'click')).toEqual([]);
  });
});

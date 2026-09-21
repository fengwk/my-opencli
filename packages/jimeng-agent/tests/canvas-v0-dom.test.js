import { readFileSync } from 'node:fs';

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
  waitForCanvasV0Attachments,
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
  const calls = { evaluate: [], goto: [], keys: [], inserts: [], setFileInput: [], cdp: [], cdpArgs: [] };
  const cdpResponses = {};
  let gotoRejections = 0;
  let newTabCalls = [];
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
      if (gotoRejections > 0) {
        gotoRejections -= 1;
        throw new Error('Navigation rejected.');
      }
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
    async cdp(method, params) {
      calls.cdp.push(method);
      calls.cdpArgs.push(params ?? null);
      return cdpResponses[method] ?? {};
    },
    cdpResponses,
    rejectGoto(times) {
      gotoRejections = times;
    },
    get newTabCalls() {
      return newTabCalls;
    },
    async newTab(url) {
      newTabCalls.push(url);
      return 'page-2';
    },
    async setActivePage(pageId) {
      calls.setActivePage = pageId;
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

  it('retries a rejected navigation and falls back to a fresh tab', async () => {
    const page = createMockPage([
      ['=> location.href', () => 'https://jimeng.jianying.com/ai-tool/asset'],
      [CREATE_PATH, () => transport({
        ret: '0',
        errmsg: 'success',
        data: { project_id: PROJECT_ID, draft_id: '22063470174988', version: '1' },
      })],
      ['surfaceReady:', () => ({ href: `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`, surfaceReady: true, editorReady: true, ready: true })],
    ]);
    // Rejections for the asset pre-flight (2 attempts) and for the canvas open (2).
    page.rejectGoto(4);

    const rows = await runJimengCanvasV0Create(page, { title: '苏州猫咪' });

    expect(rows[0].status).toBe('created');
    // Each site retries in place once, then hands the URL to a fresh tab.
    expect(page.calls.goto).toEqual([
      'https://jimeng.jianying.com/ai-tool/asset',
      'https://jimeng.jianying.com/ai-tool/asset',
      `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
      `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
    ]);
    expect(page.newTabCalls).toEqual([
      'https://jimeng.jianying.com/ai-tool/asset',
      `${JIMENG_CANVAS_V0_URL}/${PROJECT_ID}`,
    ]);
    expect(page.calls.setActivePage).toBe('page-2');
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
  // The reference read locator returns attachment *cards* (images, videos and
  // non-image attachments such as audio), not `<img>`-only items.
  const readMarker = 'panelDocked: v0PanelReady()';

  it('removes leftover references until the composer is empty', async () => {
    let remaining = 2;
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: remaining, cards: [], alerts: [] })],
      ['remove-button', () => {
        remaining -= 1;
        return { ok: true };
      }],
    ]);

    const result = await clearCanvasV0References(page);

    expect(result).toEqual({ references: 0 });
    expect(remaining).toBe(0);
  });

  it('removes a non-image attachment card (audio) as well', async () => {
    // An audio card carries no <img>, so an <img>-only locator would leave it
    // behind and the next run would submit the stale reference.
    const cards = [{ index: '0', kind: 'attachment', label: '音频1', durationText: '', imageSrc: '' }];
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: cards.length, cards: [...cards], alerts: [] })],
      ['remove-button', (text) => {
        expect(text).toContain('v0ReferenceCardElements(composer)');
        cards.pop();
        return { ok: true };
      }],
    ]);

    const result = await clearCanvasV0References(page);

    expect(result).toEqual({ references: 0 });
    expect(cards).toEqual([]);
  });

  it('fails loudly when a reference cannot be removed', async () => {
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: 1, cards: [], alerts: [] })],
      ['remove-button', () => ({ ok: false, reason: 'remove-control-missing' })],
    ]);

    await expect(clearCanvasV0References(page))
      .rejects.toThrow(/remove-control-missing/);
  });
});

describe('jimeng-agent canvas-v0 reference locator', () => {
  // The locator is a template literal in the module, so the text between these
  // markers is exactly what the browser evaluates (that range holds no
  // interpolations), and it can be run against a DOM stand-in.
  const domSource = readFileSync(new URL('../src/canvas-v0-dom.js', import.meta.url), 'utf8');
  const locatorSource = (() => {
    const start = domSource.indexOf('const v0Styled =');
    const end = domSource.indexOf('const v0UploadControl =', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return domSource.slice(start, end);
  })();

  /** Only the selectors the reference locator actually uses are implemented. */
  const matches = (node, selector) => {
    if (selector === 'img') return node.tagName === 'IMG';
    const classMatch = selector.match(/^\[class\*="(.+)"\]$/);
    if (classMatch) return node.classes.some((name) => name.includes(classMatch[1]));
    const attrMatch = selector.match(/^\[([a-z-]+)\]$/);
    if (attrMatch) return Object.prototype.hasOwnProperty.call(node.attrs, attrMatch[1]);
    throw new Error(`unsupported selector: ${selector}`);
  };

  const node = (tag, {
    classes = [], attrs = {}, text = '', children = [],
    rect = { width: 20, height: 20, left: 5, top: 5, right: 25, bottom: 25 },
  } = {}) => ({
    tagName: tag.toUpperCase(),
    classes,
    attrs,
    children,
    src: attrs.src || '',
    getAttribute: (name) => (name === 'class' ? classes.join(' ') : (attrs[name] ?? null)),
    getBoundingClientRect: () => rect,
    get innerText() { return text; },
    get textContent() { return text; },
    querySelectorAll(selector) {
      const found = [];
      const walk = (parent) => {
        for (const child of parent.children) {
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  });

  const buildReferenceCards = () => {
    const browserWindow = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      innerWidth: 1280,
      innerHeight: 800,
    };
    return Function(
      'document',
      'window',
      `${locatorSource}; return v0ReferenceCards;`,
    )({ querySelectorAll: () => [] }, browserWindow);
  };

  const uploadTile = (index = '2') => node('div', {
    classes: ['reference-item-XrDz6P'],
    attrs: { 'data-index': index },
    children: [node('div', { classes: ['reference-upload-rPIsu_', 'mini-qZdmlb'], children: [node('svg')] })],
  });
  const imageCard = (index = '0') => node('div', {
    classes: ['reference-item-Aa1'],
    attrs: { 'data-index': index },
    children: [
      node('img', { classes: ['image-XCBKz6'], attrs: { src: 'blob:https://jimeng.jianying.com/1' } }),
      node('div', { classes: ['remove-button-Qq'] }),
    ],
  });
  const videoCard = (index = '1') => node('div', {
    classes: ['reference-item-Bb2'],
    attrs: { 'data-index': index },
    children: [
      node('img', { classes: ['image-bGnRhM'], attrs: { src: 'blob:https://jimeng.jianying.com/2' } }),
      node('span', {
        classes: ['duration-YXzCne', 'visible-Ks3_NG'],
        attrs: { 'data-reference-video-duration': 'true' },
        text: '00:05',
      }),
    ],
  });
  const audioCard = (label, index = '1') => node('div', {
    classes: ['reference-item-Cc3'],
    attrs: { 'data-index': index },
    children: [
      node('div', { classes: ['reference-attachment-Dd4'] }),
      node('div', { classes: ['overlay-label-IWzvAP'], text: label }),
    ],
  });
  const stack = (...items) => node('div', { classes: ['references-Ee5'], children: items });

  it('keeps every attachment kind and drops the upload tile', () => {
    const cards = buildReferenceCards()(stack(uploadTile(), imageCard('0'), videoCard('1'), audioCard('音频1')));

    expect(cards.map((card) => [card.index, card.kind, card.label, card.durationText])).toEqual([
      ['0', 'image', '', ''],
      ['1', 'video', '', '00:05'],
      ['1', 'attachment', '音频1', ''],
    ]);
    expect(cards[0].imageSrc).toBe('blob:https://jimeng.jianying.com/1');
    expect(cards[2].imageSrc).toBe('');
  });

  it('reports an unrecognized card as unknown and skips hidden ones', () => {
    const sizedOff = node('div', {
      classes: ['reference-item-Ee6'],
      attrs: { 'data-index': '0' },
      rect: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 },
      children: [node('img', { attrs: { src: 'blob:x' } })],
    });
    const parkedOffScreen = node('div', {
      classes: ['reference-item-Ff7'],
      attrs: { 'data-index': '1' },
      rect: { width: 20, height: 20, left: 2000, top: 5, right: 2020, bottom: 25 },
      children: [node('img', { attrs: { src: 'blob:y' } })],
    });
    const bare = node('div', {
      classes: ['reference-item-Gg8'],
      attrs: { 'data-index': '1' },
      children: [node('div', { classes: ['remove-button-Qq'] })],
    });

    const cards = buildReferenceCards()(stack(sizedOff, parkedOffScreen, bare));

    expect(cards).toEqual([{
      index: '1',
      kind: 'unknown',
      label: '',
      durationText: '',
      imageSrc: '',
    }]);
  });
});

describe('jimeng-agent canvas-v0 attachment wait', () => {
  const readMarker = 'panelDocked: v0PanelReady()';
  const imageCard = (index = '0') => ({ index, kind: 'image', label: '', durationText: '', imageSrc: 'blob:https://jimeng.jianying.com/x' });
  const audioCard = (label, index = '1') => ({ index, kind: 'attachment', label, durationText: '', imageSrc: '' });

  it('succeeds as soon as every uploaded asset is attached, audio included', async () => {
    const assets = [
      { kind: 'image', label: '图片1', filename: 'a.png' },
      { kind: 'audio', label: '音频1', filename: 'b.mp3' },
    ];
    const cards = [imageCard('0'), audioCard('音频1', '1')];
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: cards.length, cards, alerts: [] })],
    ]);

    const result = await waitForCanvasV0Attachments(page, assets, 'upload', assets[1], 1, { timeoutMs: 5_000 });

    expect(result.count).toBe(2);
    expect(result.matched.map((entry) => entry.label)).toEqual(['图片1', '音频1']);
    // Presence-based: one poll is enough, no stability window to wait out.
    expect(page.calls.evaluate).toHaveLength(1);
  });

  it('keeps waiting and then reports the observed cards when the label never matches', async () => {
    const asset = { kind: 'audio', label: '音频1', filename: 'b.mp3' };
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: 1, cards: [audioCard('音频9')], alerts: [] })],
    ]);

    await expect(waitForCanvasV0Attachments(page, [asset], 'upload', asset, 0, { timeoutMs: 30 }))
      .rejects.toThrow(/Legacy canvas reference did not appear for 音频1 \(b\.mp3\); observed=\[attachment:音频9\]/);
    expect(page.calls.evaluate.length).toBeGreaterThan(1);
  });

  it('fails fast when a previously matched reference is dropped for a newer upload', async () => {
    const dropped = { kind: 'image', label: '图片1', filename: 'a.png' };
    const newest = { kind: 'audio', label: '音频1', filename: 'b.mp3' };
    let read = 0;
    const page = createMockPage([
      [readMarker, () => {
        read += 1;
        // The panel still shows the first upload, then replaces it with the new
        // one instead of keeping both cards.
        return read === 1
          ? { panelDocked: true, count: 1, cards: [imageCard('0')], alerts: [] }
          : { panelDocked: true, count: 1, cards: [audioCard('音频1', '1')], alerts: [] };
      }],
    ]);

    await expect(waitForCanvasV0Attachments(page, [dropped, newest], 'upload', newest, 1, { timeoutMs: 5_000 }))
      .rejects.toThrow(/Legacy canvas dropped 图片1 \(a\.png\) after 音频1 was attached: the 对话 panel keeps at most 2 attachments \(first \+ newest\)/);
    expect(read).toBe(2);
  });

  it('still rejects a file the legacy canvas reports as refused', async () => {
    const asset = { kind: 'video', label: '视频1', filename: 'c.mp4' };
    const page = createMockPage([
      [readMarker, () => ({ panelDocked: true, count: 0, cards: [], alerts: ['视频格式不支持'] })],
    ]);

    await expect(waitForCanvasV0Attachments(page, [asset], 'upload', asset, 0, { timeoutMs: 5_000 }))
      .rejects.toThrow(/Legacy canvas rejected 视频1 \(c\.mp4\): 视频格式不支持/);
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

  const visiblePageHandler = () => ['document.visibilityState', () => ({ visibility: 'visible', outerHeight: 900 })];
  const sidecarMarkHandler = () => ['setAttribute', (text) => (text.includes('sidecar-launcher')
    ? { ok: true, selector: '[data-opencli-jimeng-v0-target="sidecar-launcher"]' }
    : undefined)];
  const inPageClickHandler = () => ['pointerdown', (text) => (text.includes('/^对话$/') ? true : undefined)];

  it('activates the tab and clicks the 对话 launcher in-page when the panel is closed', async () => {
    let probeCount = 0;
    const page = createMockPage([
      visiblePageHandler(),
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
    expect(page.calls.evaluate.filter((text) => text.includes('pointerdown') && text.includes('/^对话$/'))).toHaveLength(1);
  });

  it('waits for the page to become visible before docking the panel', async () => {
    let visibleReads = 0;
    let probeCount = 0;
    const page = createMockPage([
      ['document.visibilityState', () => {
        visibleReads += 1;
        // The window starts minimized: the panel's slide-in cannot run yet.
        return visibleReads > 1 ? { visibility: 'visible', outerHeight: 900 } : { visibility: 'hidden', outerHeight: 0 };
      }],
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => {
        probeCount += 1;
        return probeCount > 1 ? dockedPanelProbe : closedPanelProbe;
      }],
    ]);

    const state = await ensureCanvasV0SidecarOpen(page);

    expect(state.panelReady).toBe(true);
    expect(state.opened).toBe(true);
    expect(visibleReads).toBeGreaterThan(1);
  });

  it('fails with an actionable message while the page stays hidden', async () => {
    const page = createMockPage([
      ['document.visibilityState', () => ({ visibility: 'hidden', outerHeight: 0 })],
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => closedPanelProbe],
    ]);

    await expect(ensureCanvasV0SidecarOpen(page, 1_500)).rejects.toThrow(/not visible/);
    // Clicking a parked panel cannot land it, so nothing is clicked at all.
    expect(page.calls.evaluate.filter((text) => text.includes('pointerdown') && text.includes('/^对话$/'))).toEqual([]);
  });

  it('does not click anything when the panel is already docked', async () => {
    const page = createMockPage([
      visiblePageHandler(),
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
      visiblePageHandler(),
      ['operation-button', (text) => (text.includes('pointerdown') ? true : undefined)],
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
    expect(page.calls.evaluate.filter((text) => text.includes('operation-button') && text.includes('pointerdown'))).toHaveLength(1);
    // No launcher click: the panel reported itself open, so there was none to click.
    expect(page.calls.evaluate.filter((text) => text.includes('/^对话$/') && text.includes('pointerdown'))).toEqual([]);
  });

  it('reloads the project once before failing on a stalled panel', async () => {
    const page = createMockPage([
      visiblePageHandler(),
      ['operation-button', () => true],
      inPageClickHandler(),
      sidecarMarkHandler(),
      ['surfaceReady:', () => ({ ...closedPanelProbe, launcherVisible: false, anyEditorReady: true })],
    ]);

    await expect(ensureCanvasV0SidecarOpen(page, 17_000))
      .rejects.toThrow(/reloads=1/);
    expect(page.calls.evaluate.filter((text) => text === 'location.reload()')).toHaveLength(1);
    expect(page.calls.evaluate.filter((text) => text.includes('operation-button') && text.includes('pointerdown'))).toHaveLength(1);
  });

  const generationHandlers = ({ autoInitiallyOn, autoMirror }) => {
    let autoEnabled = autoInitiallyOn;
    // The phase starts with 生成偏好 already open; the trigger click closes it.
    let popoverOpen = true;
    return [
      ['const read = v0CreationTypeRead();',
        () => ({ text: 'Agent 模式', hasTarget: true, options: 0, selected: 'Agent 模式' })],
      ['v0SettingsTrigger()', (text) => {
        if (text.includes('pointerdown')) {
          popoverOpen = false;
          return true;
        }
        return { ok: true, selector: '[data-opencli-jimeng-v0-target="generation-settings"]' };
      }],
      ["detail: 'settings-panel-open'",
        () => (popoverOpen ? { ok: true, detail: 'settings-panel-open' } : { ok: false, detail: 'popover-missing' })],
      ['const label = "视频";', () => ({ ok: true, detail: 'radio-selected' })],
      ['autoEnabled: v0AutoPreference()', () => ({ autoEnabled: autoMirror })],
      ['[role="switch"]', (text) => {
        if (text.includes('setAttribute')) {
          return { ok: true, selector: '[data-opencli-jimeng-v0-target="auto-switch"]' };
        }
        if (text.includes('pointerdown')) {
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
    expect(page.calls.evaluate.filter((text) => text.includes('v0SettingsTrigger()') && text.includes('pointerdown'))).toEqual([]);
  });

  it('turns the 自动 preference on after the video preference, like generate', async () => {
    const page = createMockPage(generationHandlers({ autoInitiallyOn: false, autoMirror: true }));

    const state = await configureCanvasV0Generation(page, {});

    expect(state.autoEnabled).toBe(true);
    expect(state.autoToggled).toBe(true);
    expect(state.creationType).toBe('Agent 模式');
    expect(page.calls.evaluate.filter((text) => text.includes('pointerdown') && text.includes('switch'))).toHaveLength(1);
    // The popover is dismissed through its own trigger, located in-page.
    expect(page.calls.evaluate.filter((text) => text.includes('v0SettingsTrigger()') && text.includes('pointerdown'))).toHaveLength(1);
    // The video radio was already selected, so it is only read, never clicked.
    expect(page.calls.evaluate.filter((text) => text.includes('video-radio'))).toEqual([]);
  });

  it('leaves an already enabled 自动 preference untouched', async () => {
    const page = createMockPage(generationHandlers({ autoInitiallyOn: true, autoMirror: true }));

    const state = await configureCanvasV0Generation(page, {});

    expect(state.autoEnabled).toBe(true);
    expect(state.autoToggled).toBe(false);
    expect(page.calls.evaluate.filter((text) => text.includes('pointerdown') && text.includes('switch'))).toEqual([]);
    expect(page.calls.evaluate.filter((text) => text.includes('v0SettingsTrigger()') && text.includes('pointerdown'))).toHaveLength(1);
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
      visiblePageHandler(),
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
      visiblePageHandler(),
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

  it('counts attachment cards (audio included) in the checkpoint snapshot', async () => {
    const assets = [
      { kind: 'image', label: '图片1', filename: 'a.png' },
      { kind: 'audio', label: '音频1', filename: 'b.mp3' },
    ];
    const page = createMockPage([snapshotHandler({ referenceCount: assets.length })]);

    const verdict = await runCanvasV0ContentCheckpoint(page, canonical, assets);

    expect(verdict.ok).toBe(true);
    expect(verdict.checks.referenceCount).toBe(true);
    // The snapshot counts composer attachment cards, so an audio card without an
    // <img> is included instead of being filtered away.
    const snapshotScript = page.calls.evaluate.find((text) => text.includes('editorTextNormalized,'));
    expect(snapshotScript).toContain('v0ReferenceCards(composer)');
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

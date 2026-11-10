import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateCurrentChatGPTTab, reloadChatGPTPage, startNewChat } from '../src/host-chatgpt.js';
import { ensureHealthyChatSurface } from '../src/page-health.js';

afterEach(() => { vi.useRealTimers(); });

const hostChatGptSource = fs.readFileSync(
  fileURLToPath(new URL('../src/host-chatgpt.js', import.meta.url)),
  'utf8',
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('host-chatgpt host package resolution', () => {
  // OpenCLI intentionally exports registry but not package.json. This fixture
  // verifies that an installer-created host link remains sufficient.
  it('uses the public registry export when package.json is not exported', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-agent-host-'));
    try {
      const pluginDir = path.join(tempDir, 'plugin');
      const pluginSource = path.join(pluginDir, 'src', 'host-chatgpt.js');
      const hostRoot = path.join(tempDir, 'host-opencli');

      fs.mkdirSync(path.dirname(pluginSource), { recursive: true });
      fs.writeFileSync(pluginSource, hostChatGptSource, 'utf8');
      writeJson(path.join(pluginDir, 'package.json'), { type: 'module' });

      writeJson(path.join(hostRoot, 'package.json'), {
        name: '@jackwener/opencli',
        type: 'module',
        exports: {
          './registry': './dist/src/registry-api.js',
        },
      });
      fs.mkdirSync(path.join(hostRoot, 'dist', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(hostRoot, 'dist', 'src', 'registry-api.js'),
        'export const registry = {};\n',
        'utf8',
      );
      fs.mkdirSync(path.join(hostRoot, 'clis', 'chatgpt'), { recursive: true });
      fs.writeFileSync(
        path.join(hostRoot, 'clis', 'chatgpt', 'utils.js'),
        "export const CHATGPT_DOMAIN = 'chatgpt.com';\n",
        'utf8',
      );

      const scopedModules = path.join(pluginDir, 'node_modules', '@jackwener');
      fs.mkdirSync(scopedModules, { recursive: true });
      fs.symlinkSync(hostRoot, path.join(scopedModules, 'opencli'), 'dir');

      const pluginRequire = createRequire(pluginSource);
      expect(() => pluginRequire.resolve('@jackwener/opencli/package.json')).toThrow();
      expect(pluginRequire.resolve('@jackwener/opencli/registry')).toContain('registry-api.js');

      const hostChatGpt = await import(`${pathToFileURL(pluginSource).href}?fixture=${Date.now()}`);
      expect(hostChatGpt.CHATGPT_DOMAIN).toBe('chatgpt.com');
      expect(hostChatGpt.unwrapEvaluateResult({
        session: 'bridge-session',
        data: { inspected: true },
      })).toEqual({ inspected: true });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('post-navigation leased tab activation', () => {
  // The pre-navigation host helper cannot pick a tab until goto binds it.
  // The later activation must select only the exact leased target, even among
  // multiple ChatGPT tabs, without mutating a user's unrelated active tab.
  it('activates only the exact inactive leased target', async () => {
    const page = {
      getActivePage: () => 'own-page',
      tabs: vi.fn(async () => [
        { page: 'other-chatgpt', active: true },
        { page: 'own-page', active: false },
      ]),
      selectTab: vi.fn(async () => {}),
    };
    await activateCurrentChatGPTTab(page);
    expect(page.selectTab).toHaveBeenCalledExactlyOnceWith('own-page');
  });

  it.each([
    { target: undefined, tabs: [{ page: 'other-chatgpt', active: false }] },
    { target: 'stale-page', tabs: [{ page: 'other-chatgpt', active: false }] },
    { target: 'own-page', tabs: [{ page: 'own-page', active: true }] },
  ])('does not guess or reselect an already active target: $target', async ({ target, tabs }) => {
    const page = { getActivePage: () => target, tabs: async () => tabs, selectTab: vi.fn() };
    await activateCurrentChatGPTTab(page);
    expect(page.selectTab).not.toHaveBeenCalled();
  });
});

describe('canonical new-chat boot and physical pre-send reload', () => {
  // A complete-but-stalled page cannot be repaired by same-URL goto, whose
  // native fast path is intentionally a no-op. Run actual health+reload code
  // and the actual scheduled browser script; only reload mounts the editor.
  it('recovers a stalled complete page with exactly one physical reload', async () => {
    vi.useFakeTimers();
    const pending = [];
    let composer = false;
    const location = { href: 'https://chatgpt.com/', reload: vi.fn(() => { composer = true; }) };
    const page = {
      goto: vi.fn(async () => {}),
      evaluate: async (script) => script === 'window.location.href' ? location.href : {
        url: location.href, composer, messages: 0, mainLen: 3772,
        errorish: false, generationFailed: false, conversationUnavailable: false, mainText: '',
      },
      evaluateOnce: vi.fn(async (script) => Function('window', 'setTimeout', `return ${script}`)(
        { location }, (callback) => { pending.push(callback); },
      )),
      sleep: async (seconds) => {
        vi.advanceTimersByTime(seconds * 1000);
        pending.splice(0).forEach((callback) => callback());
      },
    };
    const result = await ensureHealthyChatSurface(page, {
      settleMs: 1000, reload: () => reloadChatGPTPage(page),
    });
    expect(result.before.composer).toBe(false);
    expect(result.recovered).toBe(true);
    expect(result.after.broken).toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluateOnce).toHaveBeenCalledTimes(1);
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('starts at the canonical homepage instead of depending on /new redirects', async () => {
    const page = { goto: vi.fn(async () => {}), wait: vi.fn(async () => {}) };
    await startNewChat(page);
    expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com', { settleMs: 2000 });
  });

  // Route correction must retain the requested history, never silently resume
  // another conversation or treat a homepage reload as a successful resume.
  it('navigates to the requested conversation when the route is wrong', async () => {
    const page = {
      evaluate: async () => 'https://chatgpt.com/',
      goto: vi.fn(async () => {}),
      evaluateOnce: vi.fn(),
    };
    await reloadChatGPTPage(page, 'conversation-expected');
    expect(page.goto).toHaveBeenCalledExactlyOnceWith(
      'https://chatgpt.com/c/conversation-expected', { settleMs: 2000 },
    );
    expect(page.evaluateOnce).not.toHaveBeenCalled();
  });
});

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { activateCurrentChatGPTTab } from '../src/host-chatgpt.js';

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

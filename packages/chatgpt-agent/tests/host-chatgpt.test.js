import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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

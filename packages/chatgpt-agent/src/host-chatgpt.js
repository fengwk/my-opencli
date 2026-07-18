/**
 * Resolve official built-in clis/chatgpt/utils.js from the host OpenCLI install.
 * Works for:
 *   - plugin under ~/.opencli/plugins with host symlink
 *   - local file: install pointing at ~/proj/my-opencli (no node_modules link)
 *   - global opencli on PATH
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function existsPkg(root) {
  try {
    return fs.existsSync(path.join(root, 'package.json'))
      && fs.existsSync(path.join(root, 'clis/chatgpt/utils.js'));
  } catch {
    return false;
  }
}

function resolveOpencliPackageRoot() {
  const candidates = [];

  // 1) Normal Node resolution from this file (plugin node_modules symlink)
  try {
    candidates.push(path.dirname(require.resolve('@jackwener/opencli/package.json')));
  } catch { /* ignore */ }

  // 2) opencli binary location (global npm link)
  try {
    const opencliBin = process.argv[1] && path.resolve(process.argv[1]);
    if (opencliBin) {
      // .../node_modules/@jackwener/opencli/dist/src/main.js
      // .../OpenCLI/dist/src/main.js
      let dir = path.dirname(opencliBin);
      for (let i = 0; i < 8; i += 1) {
        if (existsPkg(dir)) {
          candidates.push(dir);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* ignore */ }

  // 3) Common local checkouts next to my-opencli
  candidates.push(
    path.resolve(here, '../../../../../OpenCLI'),
    path.resolve(here, '../../../../OpenCLI'),
    path.resolve(here, '../../../OpenCLI'),
    path.resolve(process.cwd(), 'OpenCLI'),
    path.resolve(process.cwd()),
  );

  // 4) Global npm prefix
  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    candidates.push(path.dirname(req.resolve('@jackwener/opencli/package.json')));
  } catch { /* ignore */ }

  for (const c of candidates) {
    if (c && existsPkg(c)) return c;
  }

  throw new Error(
    'Cannot resolve host OpenCLI package (need clis/chatgpt/utils.js). '
    + 'Install/link @jackwener/opencli, or keep a checkout at ~/proj/OpenCLI.',
  );
}

const opencliRoot = resolveOpencliPackageRoot();
const utilsUrl = pathToFileURL(path.join(opencliRoot, 'clis/chatgpt/utils.js')).href;
const utils = await import(utilsUrl);

export const {
  CHATGPT_DOMAIN,
  CHATGPT_URL,
  clearChatGPTDraft,
  currentChatGPTUrl,
  ensureChatGPTComposer,
  ensureChatGPTLogin,
  getChatGPTImageAssets,
  getChatGPTVisibleImageUrls,
  openChatGPTConversation,
  parseChatGPTConversationId,
  requireNonEmptyPrompt,
  requirePositiveInt,
  sendChatGPTMessage,
  startNewChat,
} = utils;

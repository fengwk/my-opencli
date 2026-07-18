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

function findOpencliPackageRoot(entryPath) {
  let dir = path.dirname(entryPath);
  while (true) {
    if (existsPkg(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpencliPackageRootFromExport(requireFromPlugin) {
  try {
    // package.json is intentionally not part of OpenCLI's public exports.
    // registry is public and resolves through the installer-created host link.
    return findOpencliPackageRoot(
      requireFromPlugin.resolve('@jackwener/opencli/registry'),
    );
  } catch {
    return null;
  }
}

function resolveOpencliPackageRoot() {
  const candidates = [];

  // 1) Normal Node resolution from this file (plugin node_modules symlink).
  const linkedHost = resolveOpencliPackageRootFromExport(require);
  if (linkedHost) candidates.push(linkedHost);

  // 2) opencli binary location (global npm link)
  try {
    const opencliBin = process.argv[1] && fs.realpathSync(process.argv[1]);
    if (opencliBin) {
      const hostRoot = findOpencliPackageRoot(opencliBin);
      if (hostRoot) candidates.push(hostRoot);
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
    const globalHost = resolveOpencliPackageRootFromExport(req);
    if (globalHost) candidates.push(globalHost);
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

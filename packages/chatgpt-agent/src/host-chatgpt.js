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

export function chatGPTHostVersion() {
  return String(JSON.parse(fs.readFileSync(path.join(opencliRoot, 'package.json'), 'utf8')).version || '');
}

function fallbackUnwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

export const unwrapEvaluateResult = typeof utils.unwrapEvaluateResult === 'function'
  ? utils.unwrapEvaluateResult
  : fallbackUnwrapEvaluateResult;

export const {
  CHATGPT_DOMAIN,
  CHATGPT_URL,
  clearChatGPTDraft,
  currentChatGPTUrl,
  ensureChatGPTComposer,
  ensureChatGPTLogin,
  getChatGPTSendFailureState,
  parseChatGPTConversationId,
  requireNonEmptyPrompt,
  requirePositiveInt,
  sendChatGPTMessage,
} = utils;

/**
 * The host's pre-navigation activation can see no current target (first lease)
 * or multiple ChatGPT tabs. After goto the Page has the exact leased target,
 * so only that target may be selected. Never guess by URL/history or steal a
 * different session's tab when the lease is not represented in the listing.
 */
export async function activateCurrentChatGPTTab(page) {
  const target = page.getActivePage?.();
  if (!target || typeof page.tabs !== 'function' || typeof page.selectTab !== 'function') return;
  const tabs = await page.tabs();
  const own = Array.isArray(tabs) ? tabs.filter((tab) => tab.page === target) : [];
  if (own.length === 1 && own[0].active === false) await page.selectTab(target);
}

export async function startNewChat(page) {
  // Use the canonical new-chat route, not the /new redirect. A complete but
  // unhydrated /new can otherwise be caught by goto's same-URL fast path.
  await page.goto(CHATGPT_URL, { settleMs: 2000 });
  await activateCurrentChatGPTTab(page);
  try {
    await page.wait({ selector: '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]', timeout: 8 });
  } catch { /* The bounded health check owns hydration and fail-closed errors. */ }
}

export async function openChatGPTConversation(page, value) {
  const id = await utils.openChatGPTConversation(page, value);
  await activateCurrentChatGPTTab(page);
  return id;
}

/**
 * Real pre-send recovery. Repeating goto(currentURL) is not a reload: the host
 * deliberately fast-paths complete same-URL tabs. evaluateOnce schedules one
 * document reload after acknowledgement, so navigation cannot replay it.
 * Callers must revalidate login/composer/history; never call after upload/send.
 */
export async function reloadChatGPTPage(page, session = '') {
  const desired = session
    ? `${CHATGPT_URL}/c/${parseChatGPTConversationId(session)}`
    : CHATGPT_URL;
  const current = await currentChatGPTUrl(page);
  const route = (url) => {
    try { const parsed = new URL(url); return parsed.origin + parsed.pathname.replace(/\/$/, ''); }
    catch { return ''; }
  };
  if (route(current) !== route(desired)) {
    await page.goto(desired, { settleMs: 2000 });
  } else {
    if (typeof page.evaluateOnce !== 'function') {
      throw new Error('PAGE_RELOAD_UNSUPPORTED: host must support non-replayed evaluateOnce');
    }
    await page.evaluateOnce('(() => { setTimeout(() => window.location.reload(), 0); return true; })()');
    await page.sleep(0.5);
  }
  await activateCurrentChatGPTTab(page);
}

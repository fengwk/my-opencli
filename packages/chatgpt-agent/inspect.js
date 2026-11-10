/**
 * Bounded DOM diagnostics for an existing ChatGPT page. Never sends a prompt,
 * modifies a draft, fetches conversation APIs or returns image/content bytes.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHATGPT_DOMAIN, CHATGPT_URL, currentChatGPTUrl, openChatGPTConversation,
  parseChatGPTConversationId, startNewChat, ensureChatGPTLogin, chatGPTHostVersion,
} from './src/host-chatgpt.js';
import { unwrapEvaluateResult } from './src/dom-helpers.js';
import { ensureHealthyChatSurface } from './src/page-health.js';

function safeUrl(value) {
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch { return ''; }
}

export function surfaceMetadata(state) {
  const keys = [
    'composer', 'composerCandidates', 'visibility', 'documentHasFocus', 'readyState', 'userAgent',
    'messages', 'mainLen', 'shell', 'errorish', 'generationFailed', 'conversationUnavailable',
    'generating', 'conversationId', 'onConversation', 'sessionMismatch', 'blankThread', 'broken',
  ];
  return { url: safeUrl(state?.url), ...Object.fromEntries(keys
    .filter((key) => state?.[key] !== undefined).map((key) => [key, state[key]])) };
}

async function runtimeVersions() {
  const result = { hostVersion: chatGPTHostVersion() };
  try {
    // Read the host daemon's fixed, loopback-only status API. Never return its
    // leases, owners, paths or profile IDs; only software versions are useful.
    const response = await fetch('http://127.0.0.1:19825/status', {
      headers: { 'X-OpenCLI': '1' }, signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const status = await response.json();
      result.daemonVersion = status.daemonVersion;
      result.extensionVersions = [...new Set([
        status.extensionVersion, ...(status.profiles || []).map((p) => p.extensionVersion),
      ].filter(Boolean))];
    }
  } catch { /* An unavailable status endpoint must not hide page evidence. */ }
  return result;
}

export async function probeNewChat(page, { onUnready } = {}) {
  const startedAt = Date.now(), timeline = [], tabs = [];
  let stage = 'boot';
  const recordTabs = async () => {
    if (typeof page.tabs !== 'function') return;
    const rows = await page.tabs().catch(() => []);
    tabs.push({ stage, page: page.getActivePage?.(), tabs: Array.isArray(rows)
      ? rows.slice(0, 10).map((t) => ({ page: t.page, active: t.active, url: safeUrl(t.url) })) : [] });
  };
  const boot = async () => {
    await startNewChat(page);
    await ensureChatGPTLogin(page, 'Read-only readiness probe requires a logged-in ChatGPT session.');
    await recordTabs();
  };
  const runtime = await runtimeVersions();
  try {
    await boot();
    stage = 'health';
    const health = await ensureHealthyChatSurface(page, {
      reload: async () => { stage = 'reload'; await boot(); },
      onProbe: async (state, phase) => {
        if (timeline.length < 80) timeline.push({ phase, elapsedMs: Date.now() - startedAt, ...surfaceMetadata(state) });
        if (!state.composer && state.messages === 0) await onUnready?.(state, phase);
      },
    });
    await recordTabs();
    return { mode: 'new-chat', runtime, ready: !health.after.broken,
      recovered: health.recovered, timeline, tabs };
  } catch (error) {
    // Error messages may quote content or URLs. The phase and bounded DOM
    // metadata suffice; never expose an arbitrary host exception.
    return { mode: 'new-chat', runtime, ready: false, stage, errorType: error?.name || 'Error', timeline, tabs };
  }
}

export function chatDiagnosticsScript() {
  return `(() => {
    const metadata = (el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return {
        tag: el.tagName, id: el.id, role: el.getAttribute('role'),
        testid: el.getAttribute('data-testid'),
        editable: el.getAttribute('contenteditable'),
        label: (el.getAttribute('aria-label') || '').slice(0, 100),
        display: s.display, visibility: s.visibility, width: r.width, height: r.height,
        hiddenAncestor: !!el.closest('[hidden],[inert],[aria-hidden="true"]'),
      };
    };
    const scopes = [...document.querySelectorAll(
      '[data-chatgpt-search-message-ids],[data-message-id],[data-message-author-role],[data-conversation-role]'
    )].slice(-80).map((el) => ({
      ...metadata(el),
      messageIds: (el.getAttribute('data-chatgpt-search-message-ids') || el.getAttribute('data-message-id') || '').slice(0, 1000),
      author: el.getAttribute('data-message-author-role') || el.getAttribute('data-conversation-role'),
      galleries: el.querySelectorAll('[data-testid="generated-image-gallery"]').length,
      previews: el.querySelectorAll('[data-testid="generated-image-preview"]').length,
      images: el.querySelectorAll('img').length,
    }));
    const images = [...document.querySelectorAll('main img,[role="main"] img,[role="dialog"] img')].slice(-60).map((el) => ({
      ...metadata(el), width: el.naturalWidth, height: el.naturalHeight,
      sourceKind: (el.currentSrc || el.src || '').split(':')[0],
      parent: metadata(el.parentElement),
      messageIds: (el.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') || '').slice(0, 1000),
    }));
    const conversationIds = [...new Set([...document.querySelectorAll('a[href]')]
      .map((el) => (el.getAttribute('href') || '').match(/\\/c\\/([a-zA-Z0-9_-]{8,})/)?.[1])
      .filter(Boolean))].slice(0, 20);
    return {
      url: location.origin + location.pathname, visibility: document.visibilityState,
      frames: [...document.querySelectorAll('iframe')].slice(0, 10).map(metadata),
      shadowHosts: [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).slice(0, 10).map(metadata),
      totalImages: document.querySelectorAll('img').length,
      composers: [...document.querySelectorAll('textarea,[contenteditable],[role="textbox"]')].slice(0, 20).map(metadata),
      forms: [...document.querySelectorAll('form')].slice(0, 10).map(metadata),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].slice(0, 10).map(metadata),
      buttons: [...document.querySelectorAll('button[aria-label]')].filter((el) =>
        /send|download|viewer|stop|发送|下载|停止/i.test(el.getAttribute('aria-label') || '')
      ).slice(-30).map(metadata),
      scopes, images, conversationIds,
    };
  })()`;
}

export const inspectCommand = cli({
  site: 'chatgpt-agent',
  name: 'inspect',
  access: 'read',
  description: 'Inspect bounded ChatGPT composer/gallery metadata without sending or resubmitting a prompt',
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'session', valueRequired: true, help: 'Existing conversation id or /c/<id> URL; omit to inspect home' },
    { name: 'mode', valueRequired: true, default: 'page', choices: ['page', 'new-chat'],
      help: 'page: inspect existing DOM; new-chat: probe real boot/readiness, never clears, uploads or sends' },
    { name: 'capture-unready', type: 'bool', default: false,
      help: 'Explicitly save one unready new-chat screenshot per phase. May contain visible account/draft content; never enabled by default.' },
    { name: 'fresh-tab', type: 'bool', default: false,
      help: 'Start new-chat diagnosis in a new owned blank tab rather than a reused tab' },
    { name: 'op', valueRequired: true, help: 'Managed output directory for opt-in unready screenshots (Hub injects this)' },
  ],
  columns: ['conversationId', 'diagnostics'],
  func: async (page, kwargs) => {
    const mode = kwargs.mode || 'page';
    if (!['page', 'new-chat'].includes(mode) || (mode === 'new-chat' && kwargs.session)) {
      throw new ArgumentError('Use --mode page with an optional session, or --mode new-chat without a session');
    }
    if (kwargs['capture-unready'] && (mode !== 'new-chat' || !kwargs.op)) {
      throw new ArgumentError('--capture-unready requires --mode new-chat and --op');
    }
    if (kwargs['fresh-tab'] && mode !== 'new-chat') throw new ArgumentError('--fresh-tab requires --mode new-chat');
    if (mode === 'new-chat') {
      let freshTarget;
      if (kwargs['fresh-tab']) {
        // The Bridge's first tabs-new creates a lease by reclaiming an idle
        // tab. Establish that lease first; only the subsequent newTab really
        // allocates a fresh physical tab.
        await page.goto(CHATGPT_URL, { settleMs: 0 });
        freshTarget = await page.newTab();
        if (!freshTarget) throw new CommandExecutionError('INSPECT_FRESH_TAB_UNAVAILABLE: no target ID returned');
        await page.selectTab(freshTarget);
      }
      const captures = [], captured = new Set();
      const onUnready = kwargs['capture-unready'] ? async (_state, phase) => {
        if (captured.has(phase)) return;
        captured.add(phase);
        fs.mkdirSync(kwargs.op, { recursive: true, mode: 0o700 });
        const file = path.join(kwargs.op, `unready-${phase}.png`);
        await page.screenshot({ path: file, fullPage: false, format: 'png' });
        captures.push(file);
      } : undefined;
      const diagnostics = await probeNewChat(page, { onUnready });
      return [{ conversationId: '', diagnostics: JSON.stringify({ ...diagnostics, freshTarget, captures }) }];
    }
    const id = kwargs.session ? parseChatGPTConversationId(kwargs.session) : '';
    if (id) await openChatGPTConversation(page, id);
    else await page.goto(CHATGPT_URL, { settleMs: 2000 });
    await page.sleep(10);
    const url = await currentChatGPTUrl(page);
    if (id && parseChatGPTConversationId(url) !== id) {
      throw new CommandExecutionError('INSPECT_SESSION_MISMATCH: requested conversation did not open');
    }
    const diagnostics = unwrapEvaluateResult(await page.evaluate(chatDiagnosticsScript()));
    return [{ conversationId: id, diagnostics: JSON.stringify(diagnostics) }];
  },
});

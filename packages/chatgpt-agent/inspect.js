/**
 * Bounded DOM diagnostics for an existing ChatGPT page. Never sends a prompt,
 * modifies a draft, fetches conversation APIs or returns image/content bytes.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import {
  CHATGPT_DOMAIN, CHATGPT_URL, currentChatGPTUrl, openChatGPTConversation,
  parseChatGPTConversationId,
} from './src/host-chatgpt.js';
import { unwrapEvaluateResult } from './src/dom-helpers.js';

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
  args: [{ name: 'session', valueRequired: true, help: 'Existing conversation id or /c/<id> URL; omit to inspect home' }],
  columns: ['conversationId', 'diagnostics'],
  func: async (page, kwargs) => {
    const id = kwargs.session ? parseChatGPTConversationId(kwargs.session) : '';
    if (id) await openChatGPTConversation(page, id);
    else await page.goto(CHATGPT_URL, { settleMs: 2000 });
    await page.sleep(2);
    const url = await currentChatGPTUrl(page);
    if (id && parseChatGPTConversationId(url) !== id) {
      throw new CommandExecutionError('INSPECT_SESSION_MISMATCH: requested conversation did not open');
    }
    const diagnostics = unwrapEvaluateResult(await page.evaluate(chatDiagnosticsScript()));
    return [{ conversationId: id, diagnostics: JSON.stringify(diagnostics) }];
  },
});

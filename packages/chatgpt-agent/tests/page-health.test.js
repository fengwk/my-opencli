import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyChatMainText, ensureHealthyChatSurface, probeChatSurface } from '../src/page-health.js';

function evaluatedPage(mainText, closest = () => null, stopButton = false, composerVisible = true, {
  messageSelector = '[data-message-author-role]',
  messages = 1,
  url = 'https://chatgpt.com/c/conversation-id',
  textNodes = [{ nodeValue: mainText, parentElement: { closest } }],
} = {}) {
  const main = { innerText: mainText };
  const composer = {
    getBoundingClientRect: () => ({
      width: composerVisible ? 200 : 0,
      height: composerVisible ? 32 : 0,
    }),
  };
  const window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const document = {
    body: main,
    querySelector: (selector) => {
      if (selector.includes('button[aria-label="Stop"]')) return stopButton ? {} : null;
      if (selector.includes('#prompt-textarea')) return composer;
      if (selector === 'main') return main;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector.includes('#prompt-textarea')) return [composer];
      return selector.split(',').map((part) => part.trim()).includes(messageSelector)
        ? Array.from({ length: messages }, () => ({}))
        : [];
    },
    createTreeWalker: () => {
      let index = 0;
      return {
        nextNode: () => textNodes[index++] || null,
      };
    },
  };
  const location = { href: url };
  return {
    evaluate: vi.fn(async (script) => (
      Function('document', 'location', 'window', `return ${script}`)(document, location, window)
    )),
  };
}

describe('classifyChatMainText', () => {
  it('detects the in-thread generation failure banner from ChatGPT', () => {
    const banner = [
      '这周末想去杭州待两天',
      'Something went wrong while generating the response. If this issue persists please contact us through our help center at help.openai.com.',
      'Retry',
    ].join('\n');
    expect(classifyChatMainText(banner)).toEqual({
      errorish: true,
      generationFailed: true,
    });
  });

  it('does not treat a generic loaded thread as a generation failure', () => {
    expect(classifyChatMainText('鸡翅其实很适合拿来给空气炸锅开荒')).toEqual({
      errorish: false,
      generationFailed: false,
    });
  });
});

describe('probeChatSurface', () => {
  // New layouts remove both legacy message attributes and article wrappers.
  it.each([
    'article[data-testid*="conversation-turn"]',
    '[data-talvt-turn-state]',
    '[data-conversation-role]',
    '[data-chatgpt-search-unit-key]',
  ])('accepts a short rendered thread with %s markers', async (messageSelector) => {
    const page = evaluatedPage('A short answer', () => null, false, true, { messageSelector });
    const surface = await probeChatSurface(page);

    expect(surface.messages).toBe(1);
    expect(surface.mainLen).toBeLessThan(120);
    expect(surface.blankThread).toBe(false);
    expect(surface.broken).toBe(false);
  });

  // Long UI chrome is not evidence that the resumed transcript mounted.
  it('rejects an unrendered thread even when the shell has plenty of text', async () => {
    const surface = await probeChatSurface(evaluatedPage(
      'Loading previous conversations '.repeat(20), () => null, false, true, { messages: 0 },
    ));

    expect(surface.mainLen).toBeGreaterThan(120);
    expect(surface.blankThread).toBe(true);
    expect(surface.broken).toBe(true);
  });

  // A genuine new chat has no transcript and must remain usable.
  it('accepts an empty new-chat composer', async () => {
    const surface = await probeChatSurface(evaluatedPage('', () => null, false, true, {
      messages: 0, url: 'https://chatgpt.com/new',
    }));
    expect(surface.broken).toBe(false);
  });

  // A visible composer on another route must never satisfy a resumed request.
  it.each([
    'https://chatgpt.com/',
    'https://chatgpt.com/c/other-session',
    'https://example.com/c/expected-session',
  ])('rejects a requested conversation on %s', async (url) => {
    const surface = await probeChatSurface(
      evaluatedPage('Loaded content', () => null, false, true, { url }),
      { session: 'expected-session' },
    );
    expect(surface.sessionMismatch).toBe(true);
    expect(surface.broken).toBe(true);
  });

  it('recognizes the same conversation through a project URL', async () => {
    const surface = await probeChatSurface(evaluatedPage('Loaded content', () => null, false, true, {
      url: 'https://chatgpt.com/g/g-p-project/c/expected-session',
    }), { session: 'https://chatgpt.com/c/expected-session' });
    expect(surface.conversationId).toBe('expected-session');
    expect(surface.sessionMismatch).toBe(false);
    expect(surface.broken).toBe(false);
  });

  // An unavailable conversation can redirect to a homepage that still has a composer.
  it('detects the current unavailable-conversation notice after a redirect', async () => {
    const surface = await probeChatSurface(evaluatedPage(
      'Could not load this ChatGPT conversation', () => null, false, true,
      { url: 'https://chatgpt.com/', messages: 0 },
    ));
    expect(surface.composer).toBe(true);
    expect(surface.conversationUnavailable).toBe(true);
    expect(surface.broken).toBe(true);
  });

  // A mounted but zero-sized editor is not a usable composer; readiness must
  // keep waiting instead of skipping the page-health recovery.
  it('does not treat a hidden composer as ready', async () => {
    const surface = await probeChatSurface(evaluatedPage('', () => null, false, false));
    expect(surface.composer).toBe(false);
    expect(surface.broken).toBe(true);
  });

  // The current UI uses aria-label="Stop" rather than data-testid="stop-button".
  it('recognizes an active turn without the old test id', async () => {
    const surface = await probeChatSurface(evaluatedPage('回答生成中', () => null, true));
    expect(surface.generating).toBe(true);
    expect(surface.broken).toBe(false);
  });

  it('classifies generationFailed from the page main text', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        url: 'https://chatgpt.com/new',
        composer: true,
        messages: 1,
        mainLen: 240,
        mainText: 'Something went wrong while generating the response. Retry',
        onConversation: false,
        blankThread: false,
        generating: false,
      })),
    };
    const surface = await probeChatSurface(page);
    expect(surface.generationFailed).toBe(true);
    expect(surface.errorish).toBe(true);
    expect(surface.broken).toBe(true);
  });

  // Translated generation failures need not match the generic error-text expression.
  it.each(['生成回复时出错', '生成响应时出错'])('rejects the localized failure banner %s', async (banner) => {
    const surface = await probeChatSurface(evaluatedPage(banner));
    expect(surface.errorish).toBe(false);
    expect(surface.generationFailed).toBe(true);
    expect(surface.broken).toBe(true);
  });

  it('detects a failure outside the retained 8000-character diagnostic tail', async () => {
    const fullText = [
      'before'.repeat(1600),
      'Something went wrong while generating the response. Retry',
      'after'.repeat(1800),
    ].join('');

    const surface = await probeChatSurface(evaluatedPage(fullText));

    expect(surface.mainLen).toBe(fullText.length);
    expect(surface.mainText).toHaveLength(8000);
    expect(surface.mainText).not.toContain('Something went wrong');
    expect(surface.generationFailed).toBe(true);
    expect(surface.errorish).toBe(true);
  });

  it('does not reinterpret quoted error text in a user message as a banner', async () => {
    const quotedText = 'What does "Something went wrong while generating the response" mean?';

    const surface = await probeChatSurface(evaluatedPage(quotedText, (selector) => (
      selector.includes('[data-message-author-role="user"]') ? {} : null
    )));

    expect(surface.generationFailed).toBe(false);
    expect(surface.errorish).toBe(false);
    expect(surface.broken).toBe(false);
  });

  it('does not reinterpret quoted error text in normal assistant markdown as a banner', async () => {
    const quotedText = [
      '“Something went wrong while generating the response” usually means a transient error.',
      'Try refreshing the page.',
    ].join(' ');

    const surface = await probeChatSurface(evaluatedPage(quotedText, (selector) => (
      selector.includes('[data-message-author-role="assistant"] .markdown') ? {} : null
    )));

    expect(surface.generationFailed).toBe(false);
    expect(surface.errorish).toBe(false);
    expect(surface.broken).toBe(false);
  });

  // The current UI uses search-unit wrappers for user and assistant content.
  it.each([
    '[data-chatgpt-search-unit-key]',
    '[data-content-search-unit-key]',
  ])('ignores quoted error notices inside %s content', async (selector) => {
    const page = evaluatedPage(
      'Try again. Could not load this ChatGPT conversation. Something went wrong while generating the response.',
      (selectors) => selectors.includes(selector) ? {} : null,
      false, true, { messageSelector: '[data-talvt-turn-state]' },
    );
    const surface = await probeChatSurface(page);
    expect(surface.errorish).toBe(false);
    expect(surface.generationFailed).toBe(false);
    expect(surface.conversationUnavailable).toBe(false);
    expect(surface.broken).toBe(false);
  });

  // Excluding message bodies must not exclude a failure banner elsewhere in the same turn.
  it('still detects a real banner next to current message content', async () => {
    const banner = 'Something went wrong while generating the response';
    const page = evaluatedPage(`Quoted text ${banner}`, () => null, false, true, {
      messageSelector: '[data-talvt-turn-state]',
      textNodes: [
        {
          nodeValue: 'Try again is part of the answer',
          parentElement: { closest: (selector) => selector.includes('[data-chatgpt-search-unit-key]') ? {} : null },
        },
        { nodeValue: banner, parentElement: { closest: () => null } },
      ],
    });
    const surface = await probeChatSurface(page);
    expect(surface.generationFailed).toBe(true);
    expect(surface.broken).toBe(true);
  });

  // Real alert controls remain failures even when nested inside a message unit.
  it('does not filter an explicit alert inside current message content', async () => {
    const banner = 'Something went wrong while generating the response';
    const surface = await probeChatSurface(evaluatedPage(banner, (selector) => (
      selector === '[role="alert"]' || selector.includes('[data-chatgpt-search-unit-key]') ? {} : null
    ), false, true, { messageSelector: '[data-talvt-turn-state]' }));
    expect(surface.generationFailed).toBe(true);
    expect(surface.broken).toBe(true);
  });
});

describe('ensureHealthyChatSurface', () => {
  afterEach(() => vi.restoreAllMocks());

  const snapshot = (composer) => ({
    url: 'https://chatgpt.com/new',
    composer,
    messages: 0,
    mainLen: 0,
    mainText: '',
    onConversation: false,
    blankThread: false,
    generating: false,
  });

  // Delayed hydration is not grounds for another navigation if the composer
  // appears during the bounded settle window.
  it('waits for a late composer without reloading', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValueOnce(snapshot(false)).mockResolvedValueOnce(snapshot(true)),
      sleep: vi.fn(async () => {}),
    };
    const reload = vi.fn(async () => {});

    const result = await ensureHealthyChatSurface(page, { reload, settleMs: 2000 });

    expect(result.recovered).toBe(false);
    expect(result.after.composer).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  // A composer that never mounts gets only one pre-send reload; the caller
  // remains responsible for failing closed without submitting a prompt.
  it('reloads at most once when the composer stays unavailable', async () => {
    const page = {
      evaluate: vi.fn(async () => snapshot(false)),
      sleep: vi.fn(async () => {}),
    };
    const reload = vi.fn(async () => {});

    const result = await ensureHealthyChatSurface(page, { reload, settleMs: 2000 });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(true);
    expect(result.after.broken).toBe(true);
  });

  const resumed = (messages, url = 'https://chatgpt.com/c/expected-session') => ({
    ...snapshot(true), messages, url,
    mainLen: 300, mainText: 'Conversation shell',
  });

  function timedPage(stateAt) {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    return {
      evaluate: vi.fn(async () => stateAt(now)),
      sleep: vi.fn(async (seconds) => { now += seconds * 1000; }),
    };
  }

  // A composer can precede history by longer than the previous four-second grace.
  it('waits for delayed resumed history instead of prematurely reloading', async () => {
    const page = timedPage((now) => resumed(now >= 6500 ? 1 : 0));
    const reload = vi.fn();
    const result = await ensureHealthyChatSurface(page, {
      session: 'expected-session', reload, settleMs: 10_000,
    });

    expect(Date.now()).toBe(6500);
    expect(result.recovered).toBe(false);
    expect(result.after.broken).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // Reloads need the same hydration grace, not a fixed 1.5-second last chance.
  it('waits for history after the single reload without a second reload', async () => {
    let reloadedAt = null;
    const page = timedPage((now) => resumed(reloadedAt !== null && now - reloadedAt >= 4000 ? 1 : 0));
    const reload = vi.fn(async () => { reloadedAt = Date.now(); });
    const result = await ensureHealthyChatSurface(page, {
      session: 'expected-session', reload, settleMs: 5000,
    });

    expect(Date.now()).toBe(9000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(true);
    expect(result.after.messages).toBe(1);
    expect(result.after.broken).toBe(false);
  });

  // Permanent failures have a finite two-window budget and stay fail-closed.
  it('bounds both hydration windows for a permanently blank resumed thread', async () => {
    const page = timedPage(() => resumed(0));
    const reload = vi.fn();
    const result = await ensureHealthyChatSurface(page, {
      session: 'expected-session', reload, settleMs: 2000,
    });

    expect(Date.now()).toBe(4000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.after.blankThread).toBe(true);
    expect(result.after.broken).toBe(true);
  });

  // SPA redirects may complete while the composer and stale messages are already visible.
  it('waits for the requested route rather than accepting another loaded thread', async () => {
    const page = timedPage((now) => resumed(1, now >= 3000
      ? 'https://chatgpt.com/c/expected-session' : 'https://chatgpt.com/c/another-session'));
    const reload = vi.fn();
    const result = await ensureHealthyChatSurface(page, {
      session: 'expected-session', reload, settleMs: 5000,
    });

    expect(Date.now()).toBe(3000);
    expect(result.after.sessionMismatch).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // A definite access/load error is not hydration and must never fall back to /new.
  it('does not reload or accept an unavailable resumed conversation', async () => {
    const page = timedPage(() => ({
      ...snapshot(true), mainText: 'Could not load this ChatGPT conversation',
    }));
    const reload = vi.fn();
    const result = await ensureHealthyChatSurface(page, { session: 'expected-session', reload });

    expect(result.after.conversationUnavailable).toBe(true);
    expect(result.after.sessionMismatch).toBe(true);
    expect(result.after.broken).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(page.sleep).not.toHaveBeenCalled();
  });

  // Final pre-send validation must not reload away a staged attachment or draft.
  it('only polls when reload is explicitly disabled', async () => {
    const page = timedPage(() => resumed(0));
    page.reload = vi.fn();
    page.goto = vi.fn();
    const reload = vi.fn();
    const result = await ensureHealthyChatSurface(page, {
      session: 'expected-session', reload, allowReload: false, settleMs: 2000,
    });

    expect(Date.now()).toBe(2000);
    expect(result.recovered).toBe(false);
    expect(result.after.broken).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });
});

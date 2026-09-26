import { describe, expect, it, vi } from 'vitest';
import { classifyChatMainText, ensureHealthyChatSurface, probeChatSurface } from '../src/page-health.js';

function evaluatedPage(mainText, closest = () => null, stopButton = false, composerVisible = true) {
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
    querySelectorAll: (selector) => selector.includes('#prompt-textarea') ? [composer] : [{}],
    createTreeWalker: () => {
      let current = {
        nodeValue: mainText,
        parentElement: { closest },
      };
      return {
        nextNode: () => {
          const result = current;
          current = null;
          return result;
        },
      };
    },
  };
  const location = { href: 'https://chatgpt.com/c/conversation-id' };
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

    const surface = await probeChatSurface(evaluatedPage(quotedText, () => ({})));

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
});

describe('ensureHealthyChatSurface', () => {
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
});

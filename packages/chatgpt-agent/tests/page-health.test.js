import { describe, expect, it, vi } from 'vitest';
import { classifyChatMainText, probeChatSurface } from '../src/page-health.js';

function evaluatedPage(mainText, closest = () => null) {
  const main = { innerText: mainText };
  const document = {
    body: main,
    querySelector: (selector) => {
      if (selector.includes('#prompt-textarea')) return {};
      if (selector === 'main') return main;
      return null;
    },
    querySelectorAll: () => [{}],
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
      Function('document', 'location', `return ${script}`)(document, location)
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

import { describe, expect, it, vi } from 'vitest';
import { classifyChatMainText, probeChatSurface } from '../src/page-health.js';

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
});

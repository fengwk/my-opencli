import { describe, expect, it, vi } from 'vitest';
import { askCommand, resolveConversationInfo } from '../ask.js';
import { askCommand as chatgptAskCommand } from '../../chatgpt-agent/ask.js';

function normalizeArg(arg) {
  return {
    name: arg.name,
    positional: arg.positional,
    required: arg.required,
    type: arg.type,
    default: arg.default,
    repeatable: arg.repeatable,
    valueRequired: arg.valueRequired,
  };
}

describe('gemini-agent/ask command registration', () => {
  // Guards siteSession persistence while keeping Gemini's site-specific foreground requirement.
  it('uses a visible persistent foreground browser tab for trusted Gemini input', () => {
    expect(askCommand.siteSession).toBe('persistent');
    expect(askCommand.defaultWindowMode).toBe('foreground');
    expect(chatgptAskCommand.siteSession).toBe('persistent');
  });

  it('defaults the protocol turn timeout to 1200 seconds', () => {
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout).toMatchObject({ type: 'int', default: 1200 });
    expect(timeout.help).toContain('default 1200');
  });

  it('exposes the same result columns as chatgpt-agent ask', () => {
    expect(askCommand.columns).toEqual([
      'conversationId',
      'conversationUrl',
      'text',
      'files',
      'images',
      'sources',
      'downloads',
      'uploads',
      'source',
      'reason',
    ]);
    expect(askCommand.columns).toEqual(chatgptAskCommand.columns);
  });

  // Public structure is shared; site-specific help and runtime behavior remain independent.
  it('matches chatgpt-agent normalized public argument contract and output columns', () => {
    expect(askCommand.args.map(normalizeArg)).toEqual(
      chatgptAskCommand.args.map(normalizeArg),
    );
    expect(askCommand.columns).toEqual(chatgptAskCommand.columns);
    expect(askCommand.siteSession).toBe('persistent');
    expect(chatgptAskCommand.siteSession).toBe('persistent');
    expect(askCommand.defaultWindowMode).toBe('foreground');
  });

  it('accepts repeatable --file attachments', () => {
    const file = askCommand.args.find((arg) => arg.name === 'file');
    expect(file).toMatchObject({ repeatable: true, valueRequired: true });
  });

  it('rejects malformed session values before browser navigation', async () => {
    await expect(askCommand.func({}, {
      prompt: 'must not send',
      session: 'not a valid session',
      timeout: 30,
    })).rejects.toThrow(/--session is not a valid Gemini conversation/);
  });

  it('returns protocol conversation metadata without polling the page URL', async () => {
    // StreamGenerate already carries c_<id>; waiting for Gemini to rewrite /app
    // previously added a fixed 45-second tail after the answer was complete.
    const page = {
      getCurrentUrl: vi.fn(async () => 'https://gemini.google.com/app'),
    };

    await expect(resolveConversationInfo(page, 'dfb9fb176eef48bc', '')).resolves.toEqual({
      sessionId: 'dfb9fb176eef48bc',
      conversationUrl: 'https://gemini.google.com/app/dfb9fb176eef48bc',
    });
    expect(page.getCurrentUrl).not.toHaveBeenCalled();
  });
});

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
  // Gemini needs a fixed visible tab for trusted input; ChatGPT uses independent ephemeral leases.
  it('uses a visible persistent foreground browser tab for trusted Gemini input', () => {
    expect(askCommand.siteSession).toBe('persistent');
    expect(askCommand.defaultWindowMode).toBe('foreground');
    expect(chatgptAskCommand.siteSession).toBeUndefined();
  });

  it('defaults turn timeout to 1200 seconds with agent-facing help', () => {
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout).toMatchObject({ type: 'int', default: 1200 });
    expect(timeout.help).toContain('default 1200');
    expect(timeout.help).not.toContain('protocol turn');
  });

  it('uses agent-facing description without protocol-internal phrasing', () => {
    expect(askCommand.description).not.toContain('StreamGenerate');
    expect(askCommand.description).not.toContain('batchexecute');
    expect(askCommand.description).toMatch(/Gemini/i);
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

  // Public structure is shared; site-specific tab lifecycle and runtime behavior remain independent.
  it('matches chatgpt-agent public schema while preserving independent tab lifecycles', () => {
    expect(askCommand.args.map(normalizeArg)).toEqual(
      chatgptAskCommand.args.map(normalizeArg),
    );
    expect(askCommand.columns).toEqual(chatgptAskCommand.columns);
    expect(askCommand.siteSession).toBe('persistent');
    expect(chatgptAskCommand.siteSession).toBeUndefined();
    expect(askCommand.defaultWindowMode).toBe('foreground');
  });

  it('accepts repeatable --file attachments', () => {
    const file = askCommand.args.find((arg) => arg.name === 'file');
    expect(file).toMatchObject({ repeatable: true, valueRequired: true });
  });

  // Public path examples must not depend on the caller's current working directory and should state max limit.
  it('uses generic absolute paths and documents max 10 in attachment help', () => {
    const file = askCommand.args.find((arg) => arg.name === 'file');
    expect(file.help).toContain('--file "/absolute/path/to/a.png"');
    expect(file.help).toContain('--file "/absolute/path/to/b.png"');
    expect(file.help).toMatch(/up to 10 files/i);
  });

  it('keeps --op option scoped to image output directory', () => {
    const op = askCommand.args.find((arg) => arg.name === 'op');
    expect(op.help).toContain('exported images');
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

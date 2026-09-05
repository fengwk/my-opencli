import { describe, expect, it } from 'vitest';
import { askCommand } from '../ask.js';

describe('gemini-agent/ask command registration', () => {
  it('uses a visible ephemeral browser tab for trusted Gemini input', () => {
    expect(askCommand.siteSession).toBe('ephemeral');
    expect(askCommand.defaultWindowMode).toBe('foreground');
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
});

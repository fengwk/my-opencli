import { describe, expect, it } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { StreamCollector } from '../src/stream-collector.js';
import {
  askCommand,
  assertSuccessfulImageExports,
  resolvePreSendConversationId,
  resolveResultConversation,
  wireCollectorUrlBinding,
} from '../ask.js';

describe('chatgpt-agent/ask command registration', () => {
  it('defaults the remote protocol turn timeout to 1200 seconds', () => {
    // Keep the plugin contract aligned with the wrapper Skill default.
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout).toMatchObject({ type: 'int', default: 1200 });
    expect(timeout.help).toContain('default 1200');
  });

  it('relies on OpenCLI default ephemeral site session (does not opt into persistent)', () => {
    // Without an explicit siteSession declaration, OpenCLI defaults to ephemeral tab leases.
    expect(askCommand.siteSession).toBeUndefined();
  });

  // Verifies that the public command description is agent-facing and avoids protocol-internal jargon.
  it('uses agent-facing command description rather than protocol-internal details', () => {
    expect(askCommand.description).toContain('ChatGPT Agent');
    expect(askCommand.description).not.toContain('protocol stream');
    expect(askCommand.description).not.toContain('WS');
  });

  // Verifies that timeout help is framed as waiting for the agent turn rather than a protocol stream.
  it('uses agent-facing timeout help rather than protocol-internal wording', () => {
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout.help).toContain('agent turn');
    expect(timeout.help).not.toContain('protocol turn');
  });

  // Verifies that file help mentions up to 20 files and illustrates quoted generic absolute paths.
  it('documents up to 20 files with quoted generic absolute path examples in file help', () => {
    const file = askCommand.args.find((arg) => arg.name === 'file');
    expect(file.help).toMatch(/up to 20 files/i);
    expect(file.help).toContain('"/absolute/path/to/file1"');
    expect(file.help).toContain('"/absolute/path/to/file2"');
  });

  // Verifies that op help mentions both images and files.
  it('documents op arg help covering both images and files', () => {
    const op = askCommand.args.find((arg) => arg.name === 'op');
    expect(op.help).toContain('images and files');
  });
});

describe('resolvePreSendConversationId', () => {
  // Verifies that when session is absent (new chat), pre-bind ID is null even on a warm tab at /c/<id>.
  it('returns null when session is absent, preserving unbound state for new chats on warm tabs', async () => {
    const warmPage = {
      evaluate: async () => 'https://chatgpt.com/c/stale-warm-tab-id',
    };
    const cid = await resolvePreSendConversationId(warmPage, '');
    expect(cid).toBeNull();

    const cidUndefined = await resolvePreSendConversationId(warmPage, undefined);
    expect(cidUndefined).toBeNull();
  });

  // Verifies that when session is explicitly provided, it parses the conversation ID from URL or session.
  it('derives conversation ID from page URL when session is explicitly requested', async () => {
    const page = {
      evaluate: async () => 'https://chatgpt.com/c/6789abcd-1234-5678-90ab-cdef12345678',
    };
    const cid = await resolvePreSendConversationId(page, '6789abcd-1234-5678-90ab-cdef12345678');
    expect(cid).toBe('6789abcd-1234-5678-90ab-cdef12345678');
  });

  // Verifies that a raw session ID string is parsed even if page URL is not yet at /c/...
  it('falls back to parsing session kwarg directly if page evaluation fails', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('CDP target detached');
      },
    };
    const cid = await resolvePreSendConversationId(page, 'explicit-session-id');
    expect(cid).toBe('explicit-session-id');
  });
});

describe('wireCollectorUrlBinding', () => {
  // Verifies that resolving URL info immediately binds the guarded collector.
  it('binds collector when URL info resolves with a valid conversationId', async () => {
    const collector = new StreamCollector({ guarded: true });
    const urlInfoPromise = Promise.resolve({
      conversationId: 'cid-new',
      conversationUrl: 'https://chatgpt.com/c/cid-new',
    });

    const { bindingPromise, getBindingError } = wireCollectorUrlBinding(collector, urlInfoPromise);
    const info = await bindingPromise;

    expect(info.conversationId).toBe('cid-new');
    expect(collector.conversationId).toBe('cid-new');
    expect(collector.expectedConversationId).toBe('cid-new');
    expect(getBindingError()).toBeNull();
  });

  // Verifies that conflicting URL binding errors are captured without unhandled rejections.
  it('captures conflicting binding errors when URL waiter returns a mismatch', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: 'cid-original' });
    const urlInfoPromise = Promise.resolve({
      conversationId: 'cid-conflicting',
      conversationUrl: 'https://chatgpt.com/c/cid-conflicting',
    });

    const { bindingPromise, getBindingError } = wireCollectorUrlBinding(collector, urlInfoPromise);
    await bindingPromise;

    const err = getBindingError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Conflicting conversationId binding/);
  });

  // Verifies that rejected URL waiter promises do not cause unhandled rejections.
  it('handles rejected URL waiter promise safely', async () => {
    const collector = new StreamCollector({ guarded: true });
    const urlInfoPromise = Promise.reject(new Error('URL poll timed out'));

    const { bindingPromise, getBindingError } = wireCollectorUrlBinding(collector, urlInfoPromise);
    const info = await bindingPromise;

    expect(info).toEqual({ conversationId: '', conversationUrl: '' });
    expect(getBindingError()).toBeInstanceOf(Error);
    expect(getBindingError().message).toBe('URL poll timed out');
  });

  // A new-chat collector cannot safely consume account-level events until the
  // tab URL identifies the conversation, so missing URL binding is terminal.
  it('signals a binding failure when an unbound new chat never receives a conversationId', async () => {
    const collector = new StreamCollector({ guarded: true });
    const { bindingPromise, bindingFailurePromise, getBindingError } = wireCollectorUrlBinding(
      collector,
      Promise.resolve({ conversationId: '', conversationUrl: 'https://chatgpt.com/' }),
    );

    await expect(bindingFailurePromise).rejects.toThrow(/CONVERSATION_BIND_FAILED/);
    await bindingPromise;
    expect(getBindingError()).toBeInstanceOf(CommandExecutionError);
  });

  // Existing sessions are already authoritatively bound before send and can
  // retain that ID if a later URL probe is temporarily unavailable.
  it('keeps an existing authoritative binding when URL info is unavailable', async () => {
    const collector = new StreamCollector({ guarded: true, conversationId: 'cid-existing' });
    const { bindingPromise, getBindingError } = wireCollectorUrlBinding(
      collector,
      Promise.resolve({ conversationId: '', conversationUrl: '' }),
    );

    await bindingPromise;
    expect(collector.conversationId).toBe('cid-existing');
    expect(getBindingError()).toBeNull();
  });
});

describe('resolveResultConversation', () => {
  // Verifies that the authoritative URL conversationId takes precedence over collector's state.
  it('prefers URL waiter conversationId over collector conversationId', () => {
    const result = resolveResultConversation(
      { conversationId: 'cid-from-url', conversationUrl: 'https://chatgpt.com/c/cid-from-url' },
      'cid-from-collector',
    );
    expect(result.conversationId).toBe('cid-from-url');
    expect(result.conversationUrl).toBe('https://chatgpt.com/c/cid-from-url');
  });

  // Verifies fallback to collector conversationId if URL info lacks conversationId.
  it('falls back to collector conversationId when URL info lacks ID', () => {
    const result = resolveResultConversation(
      { conversationId: '', conversationUrl: 'https://chatgpt.com/' },
      'cid-from-collector',
    );
    expect(result.conversationId).toBe('cid-from-collector');
    expect(result.conversationUrl).toBe('https://chatgpt.com/c/cid-from-collector');
  });
});

describe('assertSuccessfulImageExports', () => {
  // Verifies that when protocol reported images but zero exports succeeded, CommandExecutionError is thrown.
  it('throws CommandExecutionError when protocol reported images but downloads is empty (e.g. skipped due to time)', () => {
    const artifacts = {
      images: [{ type: 'sediment', id: 'img-1' }],
    };
    const downloads = [];

    expect(() => assertSuccessfulImageExports(artifacts, downloads)).toThrowError(CommandExecutionError);
    expect(() => assertSuccessfulImageExports(artifacts, downloads)).toThrow(/IMAGE_EXPORT_FAILED/);
  });

  // Verifies that when all image exports failed (downloaded: false), CommandExecutionError is thrown with compact error codes.
  it('throws CommandExecutionError when all image export results failed and includes actual compact error codes in hint', () => {
    const artifacts = {
      images: [{ type: 'sediment', id: 'img-1' }, { type: 'sediment', id: 'img-2' }],
    };
    const downloads = [
      { kind: 'image-export', index: 1, downloaded: false, error: 'sparse-placeholder-rejected' },
      { kind: 'image-export', index: 2, downloaded: false, error: 'fetch-failed' },
    ];

    try {
      assertSuccessfulImageExports(artifacts, downloads);
      expect.unreachable('should have thrown CommandExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExecutionError);
      expect(err.message).toContain('IMAGE_EXPORT_FAILED');
      expect(err.hint).toContain('sparse-placeholder-rejected');
      expect(err.hint).toContain('fetch-failed');
      expect(err.hint).toMatch(/expected=2, successful=0/);
    }
  });

  // Verifies that partial success (at least one image downloaded: true) succeeds without throwing.
  it('does not throw when at least one image was successfully exported', () => {
    const artifacts = {
      images: [{ type: 'sediment', id: 'img-1' }, { type: 'sediment', id: 'img-2' }],
    };
    const downloads = [
      { kind: 'image-export', index: 1, downloaded: true, path: '/tmp/img1.png' },
      { kind: 'image-export', index: 2, downloaded: false, error: 'fetch failed' },
    ];

    expect(() => assertSuccessfulImageExports(artifacts, downloads)).not.toThrow();
  });

  // Verifies that turns without generated images do not throw.
  it('does not throw when protocol reported no images', () => {
    const artifacts = { images: [] };
    const downloads = [];
    expect(() => assertSuccessfulImageExports(artifacts, downloads)).not.toThrow();
  });
});

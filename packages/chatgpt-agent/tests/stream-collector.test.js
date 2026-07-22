import { describe, expect, it } from 'vitest';
import { StreamCollector, parseSseFrames, sanitizeOutputText } from '../src/stream-collector.js';

describe('parseSseFrames', () => {
  // Ensures multi-line SSE blocks inside encoded_item split correctly.
  it('parses event/data blocks separated by blank lines', () => {
    const frames = parseSseFrames('event: delta\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    expect(frames).toHaveLength(2);
    expect(frames[0].data).toContain('"a"');
    expect(frames[1].data).toBe('[DONE]');
  });
});

describe('StreamCollector', () => {
  function streamItem(encoded, turnId = 't1') {
    return {
      type: 'message',
      topic_id: `conversation-turn-${turnId}`,
      payload: {
        type: 'conversation-turn-stream',
        payload: {
          turn_id: turnId,
          encoded_item: encoded,
        },
      },
    };
  }

  function conversationUpdate(messages, conversationId = '') {
    return {
      type: 'conversation-update',
      payload: {
        ...(conversationId ? { conversation_id: conversationId } : {}),
        update_type: 'add-messages',
        update_content: { messages },
      },
    };
  }

  it('appends text patches and exits after strong lifecycle + settle', () => {
    const c = new StreamCollector();
    const append = JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: '你好',
      conversation_id: 'cid-1',
    });
    const done = JSON.stringify({ type: 'message_stream_complete' });

    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${append}\n\n`),
    ]));
    expect(c.text).toBe('你好');
    expect(c.conversationId).toBe('cid-1');
    expect(c.canExit(0)).toBe(false);

    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${done}\n\ndata: [DONE]\n\n`),
    ]));
    expect(c.hasAnyStrongLifecycle()).toBe(true);
    // Force settle clock
    c.lastTextChangeAt = Date.now() - 5000;
    expect(c.canExit(3000)).toBe(true);
  });

  it('collects sandbox file refs from tool message add', () => {
    const c = new StreamCollector();
    const add = {
      o: 'add',
      v: {
        message: {
          id: 'm1',
          author: { role: 'tool' },
          content: { parts: ['see sandbox:/mnt/data/report.csv for output'] },
        },
      },
    };
    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${JSON.stringify(add)}\n\n`),
    ]));
    expect(c.fileRefs).toHaveLength(1);
    expect(c.fileRefs[0].fileName).toBe('report.csv');
    expect(c.fileRefs[0].messageId).toBe('m1');
  });

  // A raw assistant-only update must use the same full-message text and source collectors as SSE.
  it('collects assistant text and sources from conversation-update add-messages', () => {
    const c = new StreamCollector();
    c.ingestFramePayload(JSON.stringify(conversationUpdate([{
      id: 'assistant-update',
      author: { role: 'assistant' },
      content: { parts: ['来自 conversation-update 的回答'] },
      metadata: {
        content_references: [{
          title: 'Protocol reference',
          url: 'https://example.com/protocol',
          matched_text: 'reference',
        }],
      },
    }], 'cid-update')));

    expect(c.text).toBe('来自 conversation-update 的回答');
    expect(c.rawText).toBe('来自 conversation-update 的回答');
    expect(c.conversationId).toBe('cid-update');
    expect(c.sources).toEqual([{
      title: 'Protocol reference',
      url: 'https://example.com/protocol',
      ref: 'reference',
    }]);
  });

  it('does not expose image tool arguments as assistant text while image generation is pending', () => {
    const c = new StreamCollector();
    c.pendingImageGen = true;
    const imageToolArguments = JSON.stringify({
      prompt: 'Edit the provided image.',
      reference_image_paths: ['/mnt/data/source.png'],
      aspect_ratio: '1:1',
    });

    c.ingestFramePayload(JSON.stringify(conversationUpdate([{
      id: 'assistant-tool-args',
      author: { role: 'assistant' },
      content: { parts: [imageToolArguments] },
    }])));

    expect(c.rawText).toBe('');
    expect(c.text).toBe('');
  });

  it('clears a replaced image tool argument patch instead of preserving stale text', () => {
    const c = new StreamCollector();
    c.pendingImageGen = true;
    c.rawText = 'stale assistant text';
    c.text = 'stale assistant text';
    const imageToolArguments = JSON.stringify({
      prompt: 'Edit the provided image.',
      reference_image_paths: ['/mnt/data/source.png'],
      aspect_ratio: '1:1',
    });
    const patch = {
      p: '/message/content/parts/0',
      o: 'replace',
      v: imageToolArguments,
    };

    c.ingestFramePayload(JSON.stringify([streamItem(`data: ${JSON.stringify(patch)}\n\n`)]));

    expect(c.rawText).toBe('');
    expect(c.text).toBe('');
  });

  it('ignores hidden and tool-recipient assistant messages from conversation updates', () => {
    const c = new StreamCollector();
    c.ingestFramePayload(JSON.stringify(conversationUpdate([
      {
        id: 'assistant-hidden',
        author: { role: 'assistant' },
        content: { parts: ['internal planning text'] },
        metadata: { is_visually_hidden_from_conversation: true },
      },
      {
        id: 'assistant-tool-call',
        author: { role: 'assistant' },
        recipient: 't2uay3k.sj1i4kz',
        content: { content_type: 'code', text: '{"prompt":"internal tool arguments"}' },
      },
    ])));

    expect(c.rawText).toBe('');
    expect(c.text).toBe('');

    c.ingestFramePayload(JSON.stringify(conversationUpdate([
      {
        id: 'assistant-visible',
        author: { role: 'assistant' },
        recipient: 'all',
        content: { parts: ['visible final response'] },
      },
    ])));

    expect(c.rawText).toBe('visible final response');
    expect(c.text).toBe('visible final response');
  });

  it('keeps an ordinary JSON assistant response when no image generation is pending', () => {
    const c = new StreamCollector();
    const jsonResponse = JSON.stringify({ prompt: 'The user asked for this JSON value.' });

    c.ingestFramePayload(JSON.stringify(conversationUpdate([{
      id: 'assistant-json',
      author: { role: 'assistant' },
      content: { parts: [jsonResponse] },
    }])));

    expect(c.text).toBe(jsonResponse);
  });

  // Both producer roles can carry downloadable sandbox links in raw add-messages.
  it('collects tool and assistant sandbox refs from conversation-update add-messages', () => {
    const c = new StreamCollector();
    c.ingestFramePayload(JSON.stringify(conversationUpdate([
      {
        id: 'tool-file',
        author: { role: 'tool' },
        content: { parts: ['created sandbox:/mnt/data/tool-output.csv'] },
      },
      {
        id: 'assistant-file',
        author: { role: 'assistant' },
        content: { parts: ['Download [summary](sandbox:/mnt/data/summary.md)'] },
      },
    ])));

    expect(c.fileRefs).toEqual([
      {
        messageId: 'tool-file',
        sandboxPath: '/mnt/data/tool-output.csv',
        fileName: 'tool-output.csv',
        status: 'in_progress',
        role: 'tool',
      },
      {
        messageId: 'assistant-file',
        sandboxPath: '/mnt/data/summary.md',
        fileName: 'summary.md',
        status: 'in_progress',
        role: 'assistant',
      },
    ]);
  });

  it('collects image pointers from image_gen tool messages', () => {
    const c = new StreamCollector();
    const add = {
      o: 'add',
      v: {
        message: {
          id: 'img1',
          author: { role: 'tool' },
          metadata: { async_task_type: 'image_gen' },
          content: { parts: ['file-service://abc123'] },
        },
      },
    };
    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${JSON.stringify(add)}\n\n`),
    ]));
    expect(c.imagePointers).toEqual([
      { type: 'file-service', id: 'abc123', messageId: 'img1' },
    ]);
  });

  // Final image assets arrive on conversation-update add-messages (live ghostrider).
  it('collects image pointers from conversation-update add-messages', () => {
    const c = new StreamCollector();
    // Intermediate placeholder from turn stream
    c.ingestFramePayload(JSON.stringify([{
      type: 'message',
      topic_id: 'conversation-turn-a',
      payload: {
        type: 'conversation-turn-stream',
        payload: {
          turn_id: 'a',
          encoded_item: `data: ${JSON.stringify({
            o: 'add',
            v: {
              message: {
                id: 'tool-1',
                author: { role: 'tool', name: 't2uay3k.sj1i4kz' },
                content: { content_type: 'multimodal_text', parts: [] },
                metadata: {
                  ghostrider: { status: 'intermediate' },
                  permissions: [{ notification_channel_id: 'image_gen' }],
                },
              },
            },
          })}\n\ndata: ${JSON.stringify({ type: 'message_stream_complete' })}\n\n`,
        },
      },
    }]));
    expect(c.pendingImageGen).toBe(true);
    expect(c.canExit(0)).toBe(false);

    // Final asset via conversation-update (not turn-stream)
    c.ingestFramePayload(JSON.stringify({
      type: 'conversation-update',
      payload: {
        conversation_id: 'cid-img',
        update_type: 'add-messages',
        update_content: {
          messages: [{
            id: 'tool-1',
            author: { role: 'tool', name: 't2uay3k.sj1i4kz' },
            content: {
              content_type: 'multimodal_text',
              parts: [{
                content_type: 'image_asset_pointer',
                asset_pointer: 'sediment://file_00000000deadbeef',
                mime_type: 'image/png',
              }],
            },
            metadata: { ghostrider: { status: 'final' } },
          }],
        },
      },
    }));
    expect(c.imagePointers).toEqual([
      { type: 'sediment', id: 'file_00000000deadbeef', messageId: 'tool-1' },
    ]);
    expect(c.imageGenFinalSeen).toBe(true);
    expect(c.pendingImageGen).toBe(false);
    c.lastProgressAt = Date.now() - 5000;
    expect(c.canExit(3000)).toBe(true);
  });

  // First asset must not clear pending (multi-gen would exit early).
  it('keeps pendingImageGen until ghostrider final even after first asset', () => {
    const c = new StreamCollector();
    c.ingestFramePayload(JSON.stringify({
      type: 'conversation-update',
      payload: {
        update_type: 'add-messages',
        update_content: {
          messages: [{
            id: 't1',
            author: { role: 'tool', name: 't2uay3k.sj1i4kz' },
            content: {
              parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_one' }],
            },
            metadata: { ghostrider: { status: 'intermediate' } },
          }],
        },
      },
    }));
    expect(c.imagePointers).toHaveLength(1);
    expect(c.pendingImageGen).toBe(true);
    expect(c.canExit(0)).toBe(false);
  });

  // Image gen may finish on a later turn_id after an early stream complete.
  it('still collects image pointers from a subsequent turn stream', () => {
    const c = new StreamCollector();
    const done = JSON.stringify({ type: 'message_stream_complete' });
    const imgAdd = {
      o: 'add',
      v: {
        message: {
          id: 'img-later',
          author: { role: 'tool' },
          metadata: { async_task_type: 'image_gen' },
          content: { parts: ['file-service://file_later'] },
        },
      },
    };
    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${done}\n\n`, 'turn-a'),
    ]));
    expect(c.hasAnyStrongLifecycle()).toBe(true);
    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${JSON.stringify(imgAdd)}\n\n`, 'turn-b'),
    ]));
    expect(c.imagePointers).toEqual([
      { type: 'file-service', id: 'file_later', messageId: 'img-later' },
    ]);
  });

  // Upstream often uses object parts, not bare strings (chatgpt2api docs).
  it('collects object asset_pointer parts from image_gen tool messages', () => {
    const c = new StreamCollector();
    const add = {
      o: 'add',
      v: {
        message: {
          id: 'img2',
          author: { role: 'tool' },
          metadata: { async_task_type: 'image_gen' },
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file_obj1' },
              { asset_pointer: 'sediment://sed_obj2' },
            ],
          },
        },
      },
    };
    c.ingestFramePayload(JSON.stringify([
      streamItem(`data: ${JSON.stringify(add)}\n\n`),
    ]));
    expect(c.imagePointers).toEqual([
      { type: 'file-service', id: 'file_obj1', messageId: 'img2' },
      { type: 'sediment', id: 'sed_obj2', messageId: 'img2' },
    ]);
    // Without ghostrider final, multi-gen pending stays true — clear for exit check.
    c.pendingImageGen = false;
    c.imageGenFinalSeen = true;
    c.lastProgressAt = Date.now() - 5000;
    c.strongLifecycle.messageStreamCompleteSeen = true;
    expect(c.canExit(3000)).toBe(true);
  });

  // Private-use cite markers must become readable labels (chatgpt2api sanitize).
  it('sanitizes cite private-use markers', () => {
    const raw = `Kubernetes\uE200cite\uE202CNCF\uE202turn0search0\uE201 is popular.`;
    expect(sanitizeOutputText(raw)).toContain('CNCF');
    expect(sanitizeOutputText(raw)).not.toMatch(/turn0search/);
  });
});

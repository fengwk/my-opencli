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

  describe('guarded conversation demux', () => {
    // Verifies multi-tab interleaving: foreign final/turn-complete cannot mutate cid-A collector.
    it('demuxes interleaved multi-conversation events: cid-A intermediate -> cid-B final -> cid-B turn complete -> cid-A final', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // 1. cid-A intermediate image gen
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turnA',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turnA',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              o: 'add',
              v: {
                message: {
                  id: 'tool-A',
                  author: { role: 'tool', name: 'image_gen' },
                  content: { content_type: 'multimodal_text', parts: [] },
                  metadata: {
                    ghostrider: { status: 'intermediate' },
                    permissions: [{ notification_channel_id: 'image_gen' }],
                  },
                },
              },
            })}\n\n`,
          },
        },
      }]));

      expect(c.pendingImageGen).toBe(true);
      expect(c.imageGenFinalSeen).toBe(false);
      expect(c.frameCount).toBe(1);
      const progressAfterA = c.lastProgressAt;
      expect(progressAfterA).not.toBeNull();

      // 2. cid-B final image arrives on conversation-update broadcast
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          conversation_id: 'cid-B',
          update_type: 'add-messages',
          update_content: {
            messages: [{
              id: 'tool-B',
              author: { role: 'tool', name: 'image_gen' },
              content: {
                content_type: 'multimodal_text',
                parts: [{
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'sediment://file_foreign_b',
                }],
              },
              metadata: { ghostrider: { status: 'final' } },
            }],
          },
        },
      }));

      // B final MUST NOT clear pendingImageGen, set imageGenFinalSeen, add pointers, or update progress
      expect(c.pendingImageGen).toBe(true);
      expect(c.imageGenFinalSeen).toBe(false);
      expect(c.imagePointers).toHaveLength(0);
      expect(c.frameCount).toBe(1);
      expect(c.lastProgressAt).toBe(progressAfterA);

      // 3. cid-B turn complete arrives on conversation-turn-turnB
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversation-turn-turnB',
        payload: {
          type: 'conversation-turn-complete',
          payload: {
            turn_id: 'turnB',
            conversation_id: 'cid-B',
          },
        },
      }));

      // B turn-complete MUST NOT set turnCompleteSeen or refresh progress
      expect(c.strongLifecycle.turnCompleteSeen).toBe(false);
      expect(c.lastProgressAt).toBe(progressAfterA);
      expect(c.canExit(0)).toBe(false);

      // 4. cid-A final image arrives on conversation-update
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          conversation_id: 'cid-A',
          update_type: 'add-messages',
          update_content: {
            messages: [{
              id: 'tool-A',
              author: { role: 'tool', name: 'image_gen' },
              content: {
                content_type: 'multimodal_text',
                parts: [{
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'sediment://file_matching_a',
                }],
              },
              metadata: { ghostrider: { status: 'final' } },
            }],
          },
        },
      }));

      expect(c.pendingImageGen).toBe(false);
      expect(c.imageGenFinalSeen).toBe(true);
      expect(c.imagePointers).toEqual([
        { type: 'sediment', id: 'file_matching_a', messageId: 'tool-A' },
      ]);
      expect(c.frameCount).toBe(2);

      // 5. cid-A turn complete arrives
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversation-turn-turnA',
        payload: {
          type: 'conversation-turn-complete',
          payload: {
            turn_id: 'turnA',
            conversation_id: 'cid-A',
          },
        },
      }));

      expect(c.strongLifecycle.turnCompleteSeen).toBe(true);
      c.lastProgressAt = Date.now() - 5000;
      expect(c.canExit(3000)).toBe(true);
    });

    // Verifies that un-bound guarded collector buffers events with zero progress/state mutation,
    // and correctly replays matching events upon authoritative bind while discarding foreign ones.
    it('buffers events before bind with zero state mutation, then replays matching events on bind', () => {
      const c = new StreamCollector({ guarded: true });

      // Ingest cid-A message
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Content from A',
            })}\n\n`,
          },
        },
      }]));

      // Ingest cid-B message
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn2',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn2',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Content from B',
            })}\n\n`,
          },
        },
      }]));

      // Before bind, collector must have zero state mutations
      expect(c.text).toBe('');
      expect(c.rawText).toBe('');
      expect(c.frameCount).toBe(0);
      expect(c.eventCount).toBe(0);
      expect(c.firstProgressAt).toBeNull();
      expect(c.lastProgressAt).toBeNull();
      expect(c.lastTextChangeAt).toBeNull();
      expect(c.activeTurnId).toBeNull();
      expect(c.fileRefs).toEqual([]);
      expect(c.imagePointers).toEqual([]);
      expect(c.sources).toEqual([]);
      expect(c.pendingImageGen).toBe(false);
      expect(c.imageGenFinalSeen).toBe(false);

      // Authoritative bind to cid-A
      c.bindConversationId('cid-A');

      // Matching cid-A events are replayed, foreign cid-B events are discarded
      expect(c.text).toBe('Content from A');
      expect(c.conversationId).toBe('cid-A');
      expect(c.frameCount).toBe(1);
      expect(c.eventCount).toBe(1);
      expect(c.firstProgressAt).not.toBeNull();
      expect(c.lastProgressAt).not.toBeNull();
    });

    // Verifies that binding to a conflicting second ID fails closed.
    it('fails closed when binding to a conflicting second conversationId', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Same ID is safe no-op
      expect(() => c.bindConversationId('cid-A')).not.toThrow();

      // Conflicting ID throws
      expect(() => c.bindConversationId('cid-B')).toThrow(/Conflicting conversationId binding/);

      // Empty / invalid ID throws
      expect(() => c.bindConversationId('')).toThrow(/non-empty/);
      expect(() => c.bindConversationId(null)).toThrow(/non-empty/);
    });

    // Verifies matching vs foreign account completion broadcast on topic "conversations".
    it('accepts matching account completion and drops foreign account completion on topic conversations', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Foreign account completion on topic conversations
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-turn-complete',
          payload: {
            turn_id: 'turn-foreign',
            conversation_id: 'cid-B',
          },
        },
      }));

      expect(c.strongLifecycle.turnCompleteSeen).toBe(false);
      expect(c.frameCount).toBe(0);

      // Foreign conversation-created on topic conversations
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-created',
          payload: {
            conversation_id: 'cid-B',
          },
        },
      }));
      expect(c.frameCount).toBe(0);

      // Matching account completion on topic conversations
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-turn-complete',
          payload: {
            turn_id: 'turn-matching',
            conversation_id: 'cid-A',
          },
        },
      }));

      expect(c.strongLifecycle.turnCompleteSeen).toBe(true);
      expect(c.frameCount).toBe(1);
    });

    // Verifies turn events without cid are buffered until turn association is learned.
    it('gates unassociated turn events until association with bound conversation is learned', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Frame 1 on turn-1 without cid
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Part 1',
            })}\n\n`,
          },
        },
      }]));

      // Turn is not yet associated with cid-A -> buffered, no text change
      expect(c.text).toBe('');
      expect(c.frameCount).toBe(0);

      // Frame 2 on turn-1 carries explicit conversation_id: 'cid-A'
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: ' Part 2',
            })}\n\n`,
          },
        },
      }]));

      // Turn-1 is now associated with cid-A -> buffered Frame 1 replayed + Frame 2 applied
      expect(c.text).toBe('Part 1 Part 2');
      expect(c.frameCount).toBe(2);

      // Frame 3 on turn-2 without cid -> buffered
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn2',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn2',
            encoded_item: `data: ${JSON.stringify({
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Foreign text',
            })}\n\n`,
          },
        },
      }]));
      expect(c.text).toBe('Part 1 Part 2');

      // Frame 4 on turn-2 carries explicit conversation_id: 'cid-B'
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn2',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn2',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: ' more foreign',
            })}\n\n`,
          },
        },
      }]));

      // Turn-2 is foreign -> buffered Frame 3 discarded, Frame 4 dropped
      expect(c.text).toBe('Part 1 Part 2');
      expect(c.frameCount).toBe(2);
    });

    // Verifies individual SSE events with explicit mismatches are dropped before mutation.
    it('drops individual SSE events with explicit conversation_id mismatch inside a stream frame', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Frame for turn-1 carries an SSE matching cid-A and an SSE with explicit cid-B
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Valid text',
            })}\n\ndata: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: ' Mismatched text',
            })}\n\n`,
          },
        },
      }]));

      expect(c.text).toBe('Valid text');
      expect(c.text).not.toContain('Mismatched');
    });

    // Verifies turn association stability: foreign events cannot overwrite an already associated turn.
    it('preserves target turn association when a foreign event arrives on the same turn, keeping subsequent continuations valid', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // 1. Accept cid-A on turn-X
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turnX',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turnX',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Initial text',
            })}\n\n`,
          },
        },
      }]));

      expect(c.text).toBe('Initial text');
      expect(c.frameCount).toBe(1);
      const progressAfterInitial = c.lastProgressAt;

      // 2. Foreign event claims turnX with explicit cid-B
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turnX',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turnX',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: ' Foreign hijacking attempt',
            })}\n\n`,
          },
        },
      }]));

      // Foreign attempt MUST NOT mutate text, progress, or turn association
      expect(c.text).toBe('Initial text');
      expect(c.frameCount).toBe(1);
      expect(c.lastProgressAt).toBe(progressAfterInitial);

      // 3. No-cid target continuation arrives on turnX
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turnX',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turnX',
            encoded_item: `data: ${JSON.stringify({
              p: '/message/content/parts/0',
              o: 'append',
              v: ' and continuation',
            })}\n\n`,
          },
        },
      }]));

      // Continuation must be accepted because turnX remains associated with cid-A
      expect(c.text).toBe('Initial text and continuation');
      expect(c.frameCount).toBe(2);
    });

    // Foreign turns must not consume the bounded target-turn map and evict an
    // active target association.
    it('keeps the active target turn associated across a flood of foreign turns', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });
      const stream = (turnId, conversationId, text) => ({
        type: 'message',
        topic_id: `conversation-turn-${turnId}`,
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: turnId,
            encoded_item: `data: ${JSON.stringify({
              ...(conversationId ? { conversation_id: conversationId } : {}),
              p: '/message/content/parts/0',
              o: 'append',
              v: text,
            })}\n\n`,
          },
        },
      });

      c.ingestFramePayload(JSON.stringify([stream('target-turn', 'cid-A', 'Target start')]));
      for (let index = 0; index < 120; index += 1) {
        c.ingestFramePayload(JSON.stringify([
          stream(`foreign-turn-${index}`, 'cid-B', `foreign-${index}`),
        ]));
      }
      c.ingestFramePayload(JSON.stringify([stream('target-turn', '', ' and continuation')]));

      expect(c.text).toBe('Target start and continuation');
      expect(c.frameCount).toBe(2);
      expect(c.turnConversationMap.get('target-turn')).toBe('cid-A');
      expect(c.turnConversationMap.size).toBe(1);
    });

    // Verifies guarded server_ste_metadata buffering and replay for target vs foreign turn association.
    it('buffers guarded server_ste_metadata without cid and applies it only when turn is associated with target conversation', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // 1. server_ste_metadata arrives on turn-tool1 without cid
      c.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversation-turn-turn-tool1',
        payload: {
          type: 'server_ste_metadata',
          payload: {
            turn_id: 'turn-tool1',
            tool_invoked: true,
          },
        },
      }));

      // Not yet associated: toolInvoked is null, frameCount is 0
      expect(c.toolInvoked).toBeNull();
      expect(c.frameCount).toBe(0);

      // 2. turn-tool1 is associated with cid-A via stream frame
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn-tool1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn-tool1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Tool output',
            })}\n\n`,
          },
        },
      }]));

      // Replayed and applied
      expect(c.toolInvoked).toBe(true);

      // 3. server_ste_metadata arrives on turn-tool2 without cid
      const c2 = new StreamCollector({ guarded: true, conversationId: 'cid-A' });
      c2.ingestFramePayload(JSON.stringify({
        type: 'message',
        topic_id: 'conversation-turn-turn-tool2',
        payload: {
          type: 'server_ste_metadata',
          payload: {
            turn_id: 'turn-tool2',
            tool_invoked: true,
          },
        },
      }));
      expect(c2.toolInvoked).toBeNull();

      // turn-tool2 is associated with foreign cid-B
      c2.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn-tool2',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn-tool2',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Foreign tool output',
            })}\n\n`,
          },
        },
      }]));

      // Foreign turn discarded: toolInvoked remains null
      expect(c2.toolInvoked).toBeNull();
      expect(c2.frameCount).toBe(0);
    });

    // Verifies that unassociated turn event buffer is globally bounded.
    it('bounds unassociated turn event buffer globally to prevent unbounded memory growth', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Ingest 120 unassociated stream events across different turns
      for (let i = 0; i < 120; i += 1) {
        c.ingestFramePayload(JSON.stringify([{
          type: 'message',
          topic_id: `conversation-turn-turn-unassociated-${i}`,
          payload: {
            type: 'conversation-turn-stream',
            payload: {
              turn_id: `turn-unassociated-${i}`,
              encoded_item: `data: ${JSON.stringify({
                p: '/message/content/parts/0',
                o: 'append',
                v: `Unassociated ${i}`,
              })}\n\n`,
            },
          },
        }]));
      }

      expect(c.bufferedUnassociatedEvents.length).toBeLessThanOrEqual(100);
      expect(c.frameCount).toBe(0);
      expect(c.text).toBe('');
    });

    // Verifies mixed-CID stream frames in reversed order (foreign CID first, then target CID).
    it('handles mixed-CID stream frames in reversed order without dropping valid target items', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Single frame containing foreign item first, then target item, then no-cid continuation
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turnMixed',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turnMixed',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Foreign item',
            })}\n\ndata: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Target item',
            })}\n\ndata: ${JSON.stringify({
              p: '/message/content/parts/0',
              o: 'append',
              v: ' and continuation',
            })}\n\n`,
          },
        },
      }]));

      expect(c.text).toBe('Target item and continuation');
      expect(c.text).not.toContain('Foreign');
    });

    // Verifies fail-closed behavior for mixed/conflicting conversation-update envelopes.
    it('fails closed and drops conversation-update envelopes with mixed or conflicting message CIDs', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Top-level cid-A but contains a mixed foreign message -> drop whole update
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          conversation_id: 'cid-A',
          update_type: 'add-messages',
          update_content: {
            messages: [
              {
                id: 'm1',
                conversation_id: 'cid-A',
                author: { role: 'assistant' },
                content: { parts: ['Valid message'] },
              },
              {
                id: 'm2',
                conversation_id: 'cid-B',
                author: { role: 'assistant' },
                content: { parts: ['Foreign message'] },
              },
            ],
          },
        },
      }));

      expect(c.text).toBe('');
      expect(c.frameCount).toBe(0);

      // No top-level CID and contains mixed CIDs -> drop
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          update_type: 'add-messages',
          update_content: {
            messages: [
              {
                id: 'm3',
                conversation_id: 'cid-A',
                author: { role: 'assistant' },
                content: { parts: ['Target message'] },
              },
              {
                id: 'm4',
                conversation_id: 'cid-B',
                author: { role: 'assistant' },
                content: { parts: ['Foreign message'] },
              },
            ],
          },
        },
      }));

      expect(c.text).toBe('');
      expect(c.frameCount).toBe(0);

      // No top-level CID but all messages explicitly match cid-A -> accept
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          update_type: 'add-messages',
          update_content: {
            messages: [
              {
                id: 'm5',
                conversation_id: 'cid-A',
                author: { role: 'assistant' },
                content: { parts: ['Pure target message'] },
              },
            ],
          },
        },
      }));

      expect(c.text).toBe('Pure target message');
      expect(c.frameCount).toBe(1);
    });

    // Verifies that a foreign-only explicit frame on an already-target-associated turn is completely inert,
    // including no-cid lifecycle signals such as [DONE].
    it('drops foreign-only explicit stream frames completely, leaving frameCount, all lifecycle fields, progress, and text unchanged even with no-cid [DONE]', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // 1. Associate turn-1 with target cid-A
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-A',
              p: '/message/content/parts/0',
              o: 'append',
              v: 'Target content',
            })}\n\n`,
          },
        },
      }]));

      expect(c.text).toBe('Target content');
      expect(c.frameCount).toBe(1);
      const progressBefore = c.lastProgressAt;
      expect(progressBefore).not.toBeNull();
      expect(c.strongLifecycle).toEqual({
        doneSeen: false,
        lastTokenSeen: false,
        endTurnSeen: false,
        messageStreamCompleteSeen: false,
        turnCompleteSeen: false,
      });

      // 2. Foreign-only explicit frame arriving on turn1 with foreign cid-B and no-cid [DONE]
      c.ingestFramePayload(JSON.stringify([{
        type: 'message',
        topic_id: 'conversation-turn-turn1',
        payload: {
          type: 'conversation-turn-stream',
          payload: {
            turn_id: 'turn1',
            encoded_item: `data: ${JSON.stringify({
              conversation_id: 'cid-B',
              p: '/message/content/parts/0',
              o: 'append',
              v: ' foreign content',
            })}\n\ndata: [DONE]\n\n`,
          },
        },
      }]));

      // Assert whole frame was inert: frameCount, all lifecycle fields, progress, and text completely unchanged
      expect(c.text).toBe('Target content');
      expect(c.frameCount).toBe(1);
      expect(c.lastProgressAt).toBe(progressBefore);
      expect(c.strongLifecycle).toEqual({
        doneSeen: false,
        lastTokenSeen: false,
        endTurnSeen: false,
        messageStreamCompleteSeen: false,
        turnCompleteSeen: false,
      });
    });

    // Verifies fail-closed behavior for conversation-update without top-level CID when containing target + unknown (no-cid) messages.
    it('drops conversation-update without top-level CID if any message lacks explicit CID, accepting only when every message explicitly matches target', () => {
      const c = new StreamCollector({ guarded: true, conversationId: 'cid-A' });

      // Target + unknown message without conversation_id -> must drop whole update
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          update_type: 'add-messages',
          update_content: {
            messages: [
              {
                id: 'm-target',
                conversation_id: 'cid-A',
                author: { role: 'assistant' },
                content: { parts: ['Target message'] },
              },
              {
                id: 'm-unknown',
                // Lacks conversation_id
                author: { role: 'assistant' },
                content: { parts: ['Unknown message overwriting text'] },
              },
            ],
          },
        },
      }));

      expect(c.text).toBe('');
      expect(c.frameCount).toBe(0);

      // All messages explicitly have conversation_id === cid-A -> accepted
      c.ingestFramePayload(JSON.stringify({
        type: 'conversation-update',
        payload: {
          update_type: 'add-messages',
          update_content: {
            messages: [
              {
                id: 'm-valid-1',
                conversation_id: 'cid-A',
                author: { role: 'assistant' },
                content: { parts: ['Valid target message'] },
              },
              {
                id: 'm-valid-2',
                conversation_id: 'cid-A',
                author: { role: 'tool' },
                content: { parts: ['sandbox:/mnt/data/output.csv'] },
              },
            ],
          },
        },
      }));

      expect(c.text).toBe('Valid target message');
      expect(c.fileRefs).toHaveLength(1);
      expect(c.fileRefs[0].fileName).toBe('output.csv');
      expect(c.frameCount).toBe(1);
    });
  });
});

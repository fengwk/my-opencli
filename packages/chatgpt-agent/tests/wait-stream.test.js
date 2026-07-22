import { describe, expect, it } from 'vitest';
import { hasReturnableArtifacts, resolveArtifacts } from '../src/resolve.js';
import { StreamCollector } from '../src/stream-collector.js';
import { waitForProtocolStream } from '../src/wait-stream.js';

function streamItem(events, turnId = 't1') {
  const encoded = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
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

function ingestStreamEvents(collector, events) {
  collector.ingestFramePayload(JSON.stringify([streamItem(events)]));
}

function idlePage() {
  return {
    readWsCapture: async () => [],
    sleep: async () => {},
  };
}

function queuedPage(batches) {
  let reads = 0;
  return {
    page: {
      readWsCapture: async () => {
        reads += 1;
        return batches.shift() || [];
      },
      sleep: async () => {},
    },
    readCount: () => reads,
  };
}

function conversationUpdate(messages) {
  return {
    type: 'conversation-update',
    payload: {
      update_type: 'add-messages',
      update_content: { messages },
    },
  };
}

function immediateWaitOptions(overrides = {}) {
  return {
    timeoutMs: 50,
    textSettleMs: 3000,
    imageSettleMs: 0,
    graceMs: 0,
    pollMs: 0,
    ...overrides,
  };
}

function pendingImageMessage(parts = []) {
  return {
    o: 'add',
    v: {
      message: {
        id: 'image-tool',
        author: { role: 'tool', name: 'image_gen' },
        content: { parts },
        metadata: {
          async_task_type: 'image_gen',
          ghostrider: { status: 'intermediate' },
        },
      },
    },
  };
}

const streamComplete = { type: 'message_stream_complete' };

describe('waitForProtocolStream phase semantics', () => {
  it('waits for a final pointer when an image tool emits assistant JSON arguments first', async () => {
    const imageToolArguments = JSON.stringify({
      prompt: 'Edit the provided image.',
      reference_image_paths: ['/mnt/data/source.png'],
      aspect_ratio: '1:1',
    });
    const { page, readCount } = queuedPage([
      [
        {
          direction: 'received',
          payload: JSON.stringify([streamItem([pendingImageMessage(), streamComplete])]),
        },
        {
          direction: 'received',
          payload: JSON.stringify(conversationUpdate([{
            id: 'assistant-tool-args',
            author: { role: 'assistant' },
            content: { parts: [imageToolArguments] },
          }])),
        },
      ],
      [{
        direction: 'received',
        payload: JSON.stringify(conversationUpdate([{
          id: 'image-tool',
          author: { role: 'tool', name: 'image_gen' },
          content: {
            parts: [{
              content_type: 'image_asset_pointer',
              asset_pointer: 'sediment://final_image',
            }],
          },
          metadata: { ghostrider: { status: 'final' } },
        }])),
      }],
    ]);
    const collector = new StreamCollector();
    const result = await waitForProtocolStream(
      page,
      collector,
      immediateWaitOptions(),
    );

    expect(readCount()).toBeGreaterThanOrEqual(2);
    expect(collector.text).toBe('');
    expect(collector.imagePointers).toEqual([
      { type: 'sediment', id: 'final_image', messageId: 'image-tool' },
    ]);
    expect(result).toEqual({ reason: 'stream-ended-await-post', text: '' });
  });

  it('returns assistant error text after an explicit image-generation final marker', async () => {
    const collector = new StreamCollector();
    ingestStreamEvents(collector, [pendingImageMessage(), streamComplete]);
    collector.ingestFramePayload(JSON.stringify(conversationUpdate([
      {
        id: 'image-tool',
        author: { role: 'tool', name: 'image_gen' },
        content: { parts: [] },
        metadata: { ghostrider: { status: 'final' } },
      },
      {
        id: 'assistant-error',
        author: { role: 'assistant' },
        content: { parts: ['图像生成工具出错了，请重试。'] },
      },
    ])));
    collector.lastTextChangeAt = Date.now() - 5000;

    expect(collector.pendingImageGen).toBe(false);
    expect(collector.imageGenFinalSeen).toBe(true);
    const result = await waitForProtocolStream(idlePage(), collector, immediateWaitOptions());

    expect(result).toEqual({ reason: 'protocol-complete', text: '图像生成工具出错了，请重试。' });
  });

  // A fixed terminal signal hands protocol file metadata to post-stream resolution immediately.
  it('returns stream-ended-await-post for empty text with a protocol artifact', async () => {
    const collector = new StreamCollector();
    ingestStreamEvents(collector, [
      {
        o: 'add',
        v: {
          message: {
            id: 'tool-file',
            author: { role: 'tool' },
            content: { parts: ['sandbox:/mnt/data/result.csv'] },
          },
        },
      },
      streamComplete,
    ]);

    const result = await waitForProtocolStream(
      idlePage(),
      collector,
      immediateWaitOptions(),
    );

    expect(collector.fileRefs).toHaveLength(1);
    expect(result).toEqual({ reason: 'stream-ended-await-post', text: '' });
  });

  // A protocol tool marker is also enough to enter post-stream resolution.
  it('returns stream-ended-await-post for empty text with tool metadata', async () => {
    const collector = new StreamCollector();
    ingestStreamEvents(collector, [streamComplete]);
    collector.toolInvoked = true;

    const result = await waitForProtocolStream(
      idlePage(),
      collector,
      immediateWaitOptions(),
    );

    expect(result).toEqual({ reason: 'stream-ended-await-post', text: '' });
  });

  // Empty fixed completion without protocol output is classified directly, not after a quiet heuristic.
  it('returns protocol-complete-text-empty for empty text without an artifact', async () => {
    const collector = new StreamCollector();
    ingestStreamEvents(collector, [streamComplete]);

    const result = await waitForProtocolStream(
      idlePage(),
      collector,
      immediateWaitOptions(),
    );

    expect(collector.needsPostStreamResolve()).toBe(false);
    expect(result).toEqual({ reason: 'protocol-complete-text-empty', text: '' });
  });

  // Once a real pointer exists, pending still protects multi-image batches until the safety boundary.
  it('keeps a pending image pointer blocked until final or pointer-specific quiet safety', async () => {
    const collector = new StreamCollector();
    ingestStreamEvents(collector, [
      pendingImageMessage([{
        content_type: 'image_asset_pointer',
        asset_pointer: 'sediment://file_one',
      }]),
      streamComplete,
    ]);

    expect(collector.pendingImageGen).toBe(true);
    expect(collector.imagePointers).toHaveLength(1);
    expect(collector.canExit(0)).toBe(false);

    const result = await waitForProtocolStream(
      idlePage(),
      collector,
      immediateWaitOptions({ pendingImageMaxQuietMs: 0 }),
    );

    expect(collector.pendingImageGen).toBe(false);
    expect(result.reason).toBe('stream-ended-await-post');
  });
});

describe('wait-timeout artifact decision', () => {
  // Ask resolves protocol metadata after timeout; only real text/files/images make it returnable.
  it('distinguishes resolved output from an empty timed-out collector', async () => {
    const textCollector = new StreamCollector();
    textCollector.text = 'partial answer';

    const fileCollector = new StreamCollector();
    fileCollector.fileRefs.push({
      fileName: 'result.csv',
      messageId: 'tool-file',
      sandboxPath: '/mnt/data/result.csv',
      status: 'finished_successfully',
    });

    const imageCollector = new StreamCollector();
    imageCollector.imagePointers.push({
      type: 'sediment',
      id: 'file_one',
      messageId: 'image-tool',
    });

    const emptyCollector = new StreamCollector();
    emptyCollector.sources.push({ title: 'metadata only', url: 'https://example.com' });

    const waitResult = await waitForProtocolStream(
      idlePage(),
      textCollector,
      immediateWaitOptions({ timeoutMs: 0 }),
    );
    expect(waitResult.reason).toBe('wait-timeout');

    const resolved = await Promise.all([
      resolveArtifacts(textCollector, null),
      resolveArtifacts(fileCollector, null),
      resolveArtifacts(imageCollector, null),
      resolveArtifacts(emptyCollector, null),
    ]);
    expect(resolved.map(hasReturnableArtifacts)).toEqual([true, true, true, false]);
  });
});

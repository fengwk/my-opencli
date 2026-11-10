import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  open: vi.fn(), url: vi.fn(), login: vi.fn(), export: vi.fn(),
}));
vi.mock('../src/host-chatgpt.js', async (load) => ({
  ...await load(),
  openChatGPTConversation: mocks.open,
  currentChatGPTUrl: mocks.url,
  ensureChatGPTLogin: mocks.login,
}));
vi.mock('../src/image-export.js', () => ({
  exportNewImagesLikeOfficial: mocks.export,
  resolveImageOutputDir: (dir) => dir,
}));
import { imagesCommand, normalizeImageRecoveryArgs } from '../images.js';

const args = { session: 'conversation-current', 'message-id': ['message-current'], expected: 1, op: '/tmp/images' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.url.mockResolvedValue('https://chatgpt.com/c/conversation-current');
  mocks.export.mockResolvedValue([{ kind: 'image-export', downloaded: true, path: '/tmp/images/image.png' }]);
});

describe('existing-image recovery command', () => {
  // Explicit IDs/count are required before navigation; no latest-history guess.
  it('validates and deduplicates explicit image identities before doing browser work', () => {
    expect(normalizeImageRecoveryArgs({ ...args, 'message-id': ['message-current, message-other', 'message-current'] }))
      .toMatchObject({ messageIds: ['message-current', 'message-other'], expectedCount: 1 });
    for (const bad of [{ 'message-id': [] }, { expected: 0 }, { timeout: 601 }, { 'message-id': ['data:image/png,x'] }]) {
      expect(() => normalizeImageRecoveryArgs({ ...args, ...bad })).toThrow();
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });

  // The recovery flow never invokes a composer, upload or send API: it only
  // opens the existing route and delegates to the same scoped native exporter.
  it('exports from the exact existing conversation with no prompt submission', async () => {
    const page = { goto: vi.fn() };
    const [row] = await imagesCommand.func(page, args);
    expect(mocks.open).toHaveBeenCalledWith(page, 'conversation-current');
    expect(mocks.export).toHaveBeenCalledWith(page, expect.objectContaining({
      messageIds: ['message-current'], expectedCount: 1, outputDir: '/tmp/images',
    }));
    expect(row.text).toContain('no prompt sent');
    expect(JSON.parse(row.downloads)[0].downloaded).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
  });

  // A redirect cannot silently export a different conversation's pictures.
  it('fails before export on a session mismatch', async () => {
    mocks.url.mockResolvedValue('https://chatgpt.com/c/conversation-other');
    await expect(imagesCommand.func({}, args)).rejects.toThrow(/SESSION_MISMATCH/);
    expect(mocks.export).not.toHaveBeenCalled();
  });

  // Failed/partial downloads remain explicit; the command never converts 2/3
  // files into success or invokes a generation retry.
  it('reports incomplete recovery without resubmitting', async () => {
    mocks.export.mockResolvedValue([
      { downloaded: true, path: '/tmp/images/first.png' },
      { downloaded: false, error: 'image-source-unavailable' },
    ]);
    await expect(imagesCommand.func({}, { ...args, expected: 2 })).rejects.toThrow(/IMAGE_RECOVERY_INCOMPLETE/);
    expect(mocks.export).toHaveBeenCalledTimes(1);
  });
});

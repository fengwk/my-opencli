/**
 * Recover already-generated images, never resubmit a prompt. Callers supply the
 * exact conversation and message IDs plus expected count; history is not guessed.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  CHATGPT_DOMAIN, CHATGPT_URL, currentChatGPTUrl, ensureChatGPTLogin,
  openChatGPTConversation, parseChatGPTConversationId,
} from './src/host-chatgpt.js';
import { exportNewImagesLikeOfficial, resolveImageOutputDir } from './src/image-export.js';

export function normalizeImageRecoveryArgs(kwargs) {
  const conversationId = parseChatGPTConversationId(kwargs.session);
  const raw = Array.isArray(kwargs['message-id']) ? kwargs['message-id'] : [kwargs['message-id']];
  const messageIds = [...new Set(raw.flatMap((value) => String(value || '').split(','))
    .map((id) => id.trim()).filter(Boolean))];
  const expectedCount = Number(kwargs.expected);
  const timeout = Number(kwargs.timeout ?? 180);
  if (!messageIds.length || messageIds.length > 20 || messageIds.some((id) => !/^[A-Za-z0-9_-]{8,}$/.test(id))) {
    throw new ArgumentError('Supply 1–20 exact --message-id values from the existing generated-image turn');
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20) {
    throw new ArgumentError('--expected must be an integer between 1 and 20');
  }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
    throw new ArgumentError('--timeout must be an integer between 1 and 600 seconds');
  }
  return { conversationId, messageIds, expectedCount, timeout };
}

export const imagesCommand = cli({
  site: 'chatgpt-agent',
  name: 'images',
  access: 'read',
  description: 'Download existing generated images by exact conversation/message IDs; never sends a prompt',
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'session', positional: true, required: true, help: 'Existing conversation id or /c/<id> URL' },
    { name: 'message-id', valueRequired: true, repeatable: true, required: true, help: 'Exact generated-image message ID; repeat for multiple IDs' },
    { name: 'expected', type: 'int', required: true, help: 'Exact number of images expected from those messages' },
    { name: 'timeout', type: 'int', default: 180, help: 'Total recovery timeout in seconds (1–600)' },
    { name: 'op', valueRequired: true, help: 'Managed output directory (Hub injects this automatically)' },
  ],
  columns: ['conversationId', 'text', 'downloads'],
  func: async (page, kwargs) => {
    const { conversationId, messageIds, expectedCount, timeout } = normalizeImageRecoveryArgs(kwargs);
    const deadline = Date.now() + timeout * 1000;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    await openChatGPTConversation(page, conversationId);
    if (parseChatGPTConversationId(await currentChatGPTUrl(page)) !== conversationId) {
      throw new CommandExecutionError('IMAGE_RECOVERY_SESSION_MISMATCH: requested conversation did not open');
    }
    await ensureChatGPTLogin(page);
    const downloads = await exportNewImagesLikeOfficial(page, {
      messageIds, expectedCount, remainingMs,
      outputDir: resolveImageOutputDir(kwargs.op),
      canContinue: () => remainingMs() > 0,
      canRetry: () => remainingMs() >= 35_000,
      reloadConversation: async () => {
        await page.goto(CHATGPT_URL, { settleMs: 500 });
        await openChatGPTConversation(page, conversationId);
      },
    });
    const successful = downloads.filter((item) => item.downloaded === true);
    if (successful.length !== expectedCount) {
      const errors = [...new Set(downloads.map((item) => item.error).filter(Boolean))];
      throw new CommandExecutionError(
        'IMAGE_RECOVERY_INCOMPLETE: not all existing images were exported',
        `expected=${expectedCount}, successful=${successful.length}, conversationId=${conversationId}. `
          + `errors=[${errors.join(', ')}]. Keep completed files; do not resubmit the generation prompt.`,
      );
    }
    return [{ conversationId, text: `Exported ${successful.length} existing image(s); no prompt sent.`,
      downloads: JSON.stringify(downloads) }];
  },
});

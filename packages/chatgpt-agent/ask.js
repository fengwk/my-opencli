/**
 * chatgpt-agent ask — protocol-stream turn against ChatGPT web.
 *
 * Flow: boot session → ensure idle → startWsCapture → send → wait protocol end → resolve → return
 * On failure: stop generation and recover the shell so the next turn can submit.
 * No DOM content fallback. DOM only for composer send (and optional download probe).
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import {
  CHATGPT_DOMAIN,
  CHATGPT_URL,
  clearChatGPTDraft,
  currentChatGPTUrl,
  ensureChatGPTComposer,
  ensureChatGPTLogin,
  openChatGPTConversation,
  parseChatGPTConversationId,
  requireNonEmptyPrompt,
  requirePositiveInt,
  sendChatGPTMessage,
  startNewChat,
} from './src/host-chatgpt.js';
import { StreamCollector } from './src/stream-collector.js';
import { waitForProtocolStream } from './src/wait-stream.js';
import { resolveArtifacts } from './src/resolve.js';
import {
  collectExpectedFileNames,
  downloadFilesViaDomClick,
  enrichFilesFromText,
} from './src/download-dom.js';
import { prepareLocalFiles, uploadComposerFiles } from './src/upload-dom.js';
import { ensureHealthyChatSurface, probeChatSurface } from './src/page-health.js';
import {
  exportNewImagesLikeOfficial,
  snapshotVisibleImageUrls,
} from './src/image-export.js';
import {
  ensureNotGenerating,
  recoverChatSurfaceAfterFailure,
} from './src/session-recovery.js';

const DEFAULT_TIMEOUT_SEC = 300;
/**
 * Capture all WebSockets on the automation tab.
 * A dedicated chatgpt-agent tab only talks to ChatGPT; filtering by URL is harmful
 * because long-lived sockets opened before Network.enable often never re-emit
 * webSocketCreated, so URL-filtered capture silently drops their frames.
 */
const WS_PATTERN = '';

async function waitForConversationId(page, timeoutSeconds = 45) {
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    const url = await currentChatGPTUrl(page);
    try {
      const id = parseChatGPTConversationId(url);
      return { conversationId: id, conversationUrl: url };
    } catch {
      await page.sleep(1);
    }
  }
  return { conversationId: '', conversationUrl: await currentChatGPTUrl(page) };
}

function serializeJson(value) {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    return '[]';
  }
}

export const askCommand = cli({
  site: 'chatgpt-agent',
  name: 'ask',
  access: 'write',
  description:
    'Send a prompt to ChatGPT via protocol stream (WS); return text, files, and images for one turn',
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'prompt', positional: true, required: true, help: 'Prompt to send' },
    {
      name: 'session',
      valueRequired: true,
      help: 'Continue an existing conversation id or /c/<id> URL; omit to start a new chat',
    },
    {
      name: 'timeout',
      type: 'int',
      default: DEFAULT_TIMEOUT_SEC,
      help: `Max seconds to wait for the protocol turn (default ${DEFAULT_TIMEOUT_SEC})`,
    },
    {
      name: 'file',
      valueRequired: true,
      repeatable: true,
      help: 'Local file to attach (repeatable: --file a.png --file b.png); comma-separated also ok',
    },
    {
      name: 'op',
      valueRequired: true,
      help: 'Output directory for exported images (default: ~/Pictures/chatgpt-agent)',
    },
  ],
  columns: [
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
  ],
  func: async (page, kwargs) => {
    const prompt = requireNonEmptyPrompt(kwargs.prompt, 'chatgpt-agent ask');
    const timeoutSec = requirePositiveInt(
      Number(kwargs.timeout ?? DEFAULT_TIMEOUT_SEC),
      'chatgpt-agent ask --timeout',
      'Example: opencli chatgpt-agent ask "hello" --timeout 300',
    );
    const timeoutMs = timeoutSec * 1000;
    const session = kwargs.session != null && String(kwargs.session).trim()
      ? String(kwargs.session).trim()
      : '';

    // --- Boot ---
    const bootConversation = async () => {
      if (session) {
        await openChatGPTConversation(page, session);
      } else {
        await startNewChat(page);
      }
      await ensureChatGPTLogin(page, 'chatgpt-agent ask requires a logged-in ChatGPT browser session.');
      await ensureChatGPTComposer(
        page,
        'chatgpt-agent ask requires a visible composer. Open chatgpt.com and finish any interstitial.',
      );
    };

    await bootConversation();

    // Blank white thread / failed hydrate: reload once so the next send is not doomed.
    const health = await ensureHealthyChatSurface(page, {
      session,
      reload: async () => {
        if (session) {
          await openChatGPTConversation(page, session);
        } else {
          await startNewChat(page);
        }
        await ensureChatGPTLogin(page, 'chatgpt-agent ask requires a logged-in ChatGPT browser session.');
        await ensureChatGPTComposer(
          page,
          'chatgpt-agent ask requires a visible composer after recovery reload.',
        );
      },
    });
    if (health.recovered && health.after?.broken) {
      // One more hard navigation to session / new chat.
      await bootConversation();
      await page.sleep(2);
      const retry = await probeChatSurface(page);
      if (retry.broken) {
        throw new CommandExecutionError(
          'PAGE_BROKEN: ChatGPT thread shell is blank after reload',
          'Open the automation tab, hard-refresh chatgpt.com, confirm the conversation loads, then retry.',
        );
      }
    }

    // Previous failed turns may leave Thinking / stop-button active. Wait or stop
    // before sending, otherwise the next prompt fills the composer but cannot submit.
    const preSendGen = await ensureNotGenerating(page, {
      timeoutSec: Math.min(45, timeoutSec),
    });
    if (preSendGen.stillGenerating) {
      throw new CommandExecutionError(
        'STILL_GENERATING: previous ChatGPT turn is still active after stop',
        'Open the automation tab, stop generation or open chatgpt.com/new, then retry.',
      );
    }

    // Clear leftover composer text/attachments from a previous failed or partial turn
    // (official chatgpt image does the same via clearChatGPTDraft before upload).
    await clearChatGPTDraft(page);

    // --- Optional attachments (setFileInput / DataTransfer on composer file input) ---
    let uploads = [];
    const prepared = prepareLocalFiles(kwargs.file);
    if (!prepared.ok) {
      throw new ArgumentError(prepared.reason, 'Pass an existing local path via --file');
    }
    if (prepared.files.length) {
      const up = await uploadComposerFiles(page, prepared.files);
      if (!up.ok) {
        throw new CommandExecutionError(
          `UPLOAD_FAILED: ${up.reason || 'could not attach file'}`,
          'Reload OpenCLI extension if setFileInput fails; ensure file upload is allowed for this ChatGPT account.',
        );
      }
      uploads = up.files || prepared.files.map((f) => f.name);
      if (process.env.OPENCLI_VERBOSE) {
        console.error(`[chatgpt-agent] uploaded=${JSON.stringify(uploads)}`);
      }
    }

    // Snapshot visible images before send (official image.js pattern).
    const beforeImageUrls = await snapshotVisibleImageUrls(page);

    // --- Arm WS capture BEFORE send ---
    if (typeof page.startWsCapture !== 'function') {
      throw new CommandExecutionError(
        'WS_CAPTURE_UNSUPPORTED: page.startWsCapture is not available',
        'Use the forked OpenCLI CLI + Browser Bridge extension with ws-capture support.',
      );
    }
    const armed = await page.startWsCapture(WS_PATTERN);
    if (!armed) {
      throw new CommandExecutionError(
        'WS_CAPTURE_UNSUPPORTED: Browser Bridge extension does not support ws-capture-start',
        'Load the forked extension from OpenCLI/extension-package and reload it, then retry.',
      );
    }

    // Always disarm capture after the turn so persistent site sessions do not
    // keep buffering WebSocket frames between commands (bounded ring, but still
    // holds requestId maps and keeps hasActiveNetworkCapture true).
    // On failure, also stop generation and recover the shell so the next ask can submit.
    let turnSucceeded = false;
    try {
      // Brief settle so Network.enable is live before the page opens stream sockets.
      await page.sleep(0.3);

      const collector = new StreamCollector();
      const t0 = Date.now();

      // --- Send ---
      const sent = await sendChatGPTMessage(page, prompt);
      if (!sent) {
        throw new CommandExecutionError(
          'SEND_FAILED: could not fill/submit ChatGPT composer',
          `Open ${CHATGPT_URL} in the automation window and verify the composer is ready.`,
        );
      }

      // Conversation id may appear via URL and/or stream payloads.
      const urlWaitBudget = Math.min(45, timeoutSec);
      const urlInfoPromise = waitForConversationId(page, urlWaitBudget);

      // --- Listen protocol stream ---
      let waitResult;
      try {
        waitResult = await waitForProtocolStream(page, collector, {
          timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)),
        });
      } catch (err) {
        if (err && err.code === 'STUCK_NO_WS_PROGRESS') {
          throw new CommandExecutionError(
            err.message,
            'WS capture armed before send but no frames arrived. Check Browser Bridge extension, '
            + 'login state, and that ChatGPT is actually streaming on this tab.',
          );
        }
        throw err;
      }

      const urlInfo = await urlInfoPromise;
      const conversationId = collector.conversationId || urlInfo.conversationId || '';
      let conversationUrl = urlInfo.conversationUrl || '';
      if (conversationId && !/\/c\//.test(conversationUrl || '')) {
        conversationUrl = `${CHATGPT_URL}/c/${conversationId}`;
      }

      if (waitResult.reason === 'wait-timeout') {
        const partial = (collector.text || '').trim();
        throw new TimeoutError(
          'chatgpt-agent ask',
          timeoutSec,
          partial
            ? `Protocol turn incomplete; partial text length=${partial.length}. Re-run with higher --timeout.`
            : 'No protocol stream completion before timeout.',
        );
      }

      // --- Package protocol artifacts only (no extra backend HTTP) ---
      let artifacts = await resolveArtifacts(collector, page, { conversationId });
      artifacts = enrichFilesFromText(artifacts);

      if (process.env.OPENCLI_VERBOSE) {
        console.error(
          `[chatgpt-agent] resolve textLen=${(artifacts.text || '').length} `
          + `sources=${(artifacts.sources || []).length} `
          + `files=${(artifacts.files || []).length} `
          + `images=${(artifacts.images || []).length} `
          + `frames=${collector.frameCount} events=${collector.eventCount}`,
        );
      }

      if (!artifacts.text && artifacts.files.length === 0 && artifacts.images.length === 0) {
        throw new CommandExecutionError(
          'EMPTY_REPLY: stream finished without text/files/images',
          `reason=${waitResult.reason}; frames=${collector.frameCount}`,
        );
      }

      // Data-driven downloads from THIS turn only:
      //   files  → chip / flyout Download (chrome.downloads)
      //   images → official-style DOM export (fetch/canvas → local file)
      let downloads = [];
      const remainingMs = () => Math.max(0, timeoutMs - (Date.now() - t0));
      const fileNames = collectExpectedFileNames(artifacts);
      if (fileNames.length > 0) {
        await page.sleep(1.0);
        const downloadBudget = Math.min(20_000, Math.max(8_000, Math.floor(remainingMs() * 0.3)));
        if (downloadBudget >= 5_000) {
          downloads = await downloadFilesViaDomClick(page, fileNames, {
            timeoutMs: downloadBudget,
          });
        } else if (process.env.OPENCLI_VERBOSE) {
          console.error('[chatgpt-agent] skip file download: no time budget left');
        }
      }

      if ((artifacts.images || []).length > 0 && remainingMs() >= 3_000) {
        const imgDl = await exportNewImagesLikeOfficial(page, {
          beforeUrls: beforeImageUrls,
          expectedCount: artifacts.images.length,
          outputDir: kwargs.op,
          settleMs: 1200,
        });
        downloads = downloads.concat(imgDl);
      }

      if (process.env.OPENCLI_VERBOSE && downloads.length) {
        console.error(
          `[chatgpt-agent] fileNames=${JSON.stringify(fileNames)} `
          + `images=${(artifacts.images || []).length} downloads=${JSON.stringify(downloads)}`,
        );
      }

      const result = [{
        conversationId,
        conversationUrl,
        text: artifacts.text || '',
        files: serializeJson(artifacts.files),
        images: serializeJson(artifacts.images),
        sources: serializeJson(artifacts.sources || []),
        downloads: serializeJson(downloads),
        uploads: serializeJson(uploads),
        source: 'ws',
        reason: waitResult.reason,
      }];
      turnSucceeded = true;
      return result;
    } finally {
      if (typeof page.stopWsCapture === 'function') {
        await page.stopWsCapture().catch(() => null);
      }
      if (!turnSucceeded) {
        await recoverChatSurfaceAfterFailure(page, {
          session,
          hardReset: bootConversation,
        }).catch((err) => {
          if (process.env.OPENCLI_VERBOSE) {
            console.error(`[chatgpt-agent] recovery after failure failed: ${err?.message || err}`);
          }
        });
      }
    }
  },
});

/**
 * chatgpt-agent ask — protocol-stream turn against ChatGPT web.
 *
 * Flow: boot session → ensure idle → arm HTTP-SSE + WS capture → send →
 * wait protocol end → resolve → return
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
  getChatGPTSendFailureState,
  openChatGPTConversation,
  parseChatGPTConversationId,
  requireNonEmptyPrompt,
  requirePositiveInt,
  sendChatGPTMessage,
  startNewChat,
} from './src/host-chatgpt.js';
import {
  SSE_CAPTURE_INCOMPLETE,
  SSE_CAPTURE_UNSUPPORTED,
  StreamCollector,
} from './src/stream-collector.js';
import { CHATGPT_CONVERSATION_SSE_URL, SseCaptureStream } from './src/sse-stream.js';
import { waitForProtocolStream } from './src/wait-stream.js';
import { hasReturnableArtifacts, resolveArtifacts } from './src/resolve.js';
import {
  collectExpectedFileNames,
  downloadFilesViaDomClick,
  enrichFilesFromText,
} from './src/download-dom.js';
import { prepareLocalFiles, uploadComposerFiles } from './src/upload-dom.js';
import { ensureHealthyChatSurface, probeChatSurface } from './src/page-health.js';
import {
  exportNewImagesLikeOfficial,
  resolveImageOutputDir,
  snapshotVisibleImageUrls,
} from './src/image-export.js';
import { collectDownloadsToOutputDir } from './src/artifact-collect.js';
import {
  ensureIdleSurfaceWithRecovery,
  recoverChatSurfaceAfterFailure,
} from './src/session-recovery.js';

const DEFAULT_TIMEOUT_SEC = 1200;
/**
 * Capture all WebSockets on the automation tab.
 * A dedicated chatgpt-agent tab only talks to ChatGPT; filtering by URL is harmful
 * because long-lived sockets opened before Network.enable often never re-emit
 * webSocketCreated, so URL-filtered capture silently drops their frames.
 */
const WS_PATTERN = '';
/**
 * Arm only our own conversation POST. The extension's pattern is a substring
 * filter, so /backend-api/f/conversation/prepare also matches; the SSE reader
 * re-checks the URL exactly before trusting any byte as turn output.
 */
const SSE_PATTERN = CHATGPT_CONVERSATION_SSE_URL;

const SSE_CAPTURE_ARM_HINT = 'Update both the forked OpenCLI CLI and Browser Bridge extension to the release that '
  + 'streams HTTP text/event-stream bodies, then reload the extension and retry.';

/**
 * Arm the turn's two non-invasive captures before the send: the HTTP stream is
 * the turn's authoritative transport, WebSockets stay armed for images/files.
 * Callers own the disarm (ask's finally stops both), so an arming failure after
 * a partial arm still leaves the tab clean and aborts before the prompt is sent.
 */
async function armTurnCaptures(page) {
  if (typeof page.startSseCapture !== 'function' || typeof page.readSseCapture !== 'function') {
    throw new CommandExecutionError(
      `${SSE_CAPTURE_UNSUPPORTED}: page.startSseCapture/readSseCapture is not available`,
      SSE_CAPTURE_ARM_HINT,
    );
  }
  if (typeof page.startWsCapture !== 'function') {
    throw new CommandExecutionError(
      'WS_CAPTURE_UNSUPPORTED: page.startWsCapture is not available',
      'Use the forked OpenCLI CLI + Browser Bridge extension with ws-capture support.',
    );
  }

  const wsArmed = await page.startWsCapture(WS_PATTERN);
  if (!wsArmed) {
    throw new CommandExecutionError(
      'WS_CAPTURE_UNSUPPORTED: Browser Bridge extension does not support ws-capture-start',
      'Load the forked extension from OpenCLI/extension-package and reload it, then retry.',
    );
  }

  const sseArmed = await page.startSseCapture(SSE_PATTERN);
  if (!sseArmed) {
    throw new CommandExecutionError(
      `${SSE_CAPTURE_UNSUPPORTED}: Browser Bridge extension does not support sse-capture-start`,
      SSE_CAPTURE_ARM_HINT,
    );
  }
}

async function waitForConversationId(page, timeoutSeconds = 45) {
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    try {
      const url = await currentChatGPTUrl(page);
      const id = parseChatGPTConversationId(url);
      return { conversationId: id, conversationUrl: url };
    } catch {
      await page.sleep(1);
    }
  }
  let fallbackUrl = '';
  try {
    fallbackUrl = await currentChatGPTUrl(page);
  } catch {}
  return { conversationId: '', conversationUrl: fallbackUrl };
}

export async function resolvePreSendConversationId(page, session) {
  const normalizedSession = session != null && String(session).trim() ? String(session).trim() : '';
  if (!normalizedSession) {
    return null;
  }
  try {
    const currentUrl = await currentChatGPTUrl(page);
    return parseChatGPTConversationId(currentUrl);
  } catch {
    try {
      return parseChatGPTConversationId(normalizedSession);
    } catch {
      return normalizedSession.startsWith('http') ? null : normalizedSession;
    }
  }
}

export function wireCollectorUrlBinding(collector, urlInfoPromise) {
  let urlBindingError = null;
  let signalBindingError = null;
  const bindingFailurePromise = new Promise((_, reject) => {
    signalBindingError = reject;
  });
  bindingFailurePromise.catch(() => {});

  const recordBindingError = (err) => {
    if (!urlBindingError) urlBindingError = err;
    if (signalBindingError) signalBindingError(err);
  };

  const bindingPromise = Promise.resolve(urlInfoPromise)
    .then((urlInfo) => {
      if (urlInfo && urlInfo.conversationId) {
        try {
          collector.bindConversationId(urlInfo.conversationId);
        } catch (err) {
          recordBindingError(err);
        }
      } else if (!collector.expectedConversationId) {
        recordBindingError(new CommandExecutionError(
          'CONVERSATION_BIND_FAILED: ChatGPT did not expose a conversation id after send',
          'The automation tab never entered /c/<id>. Verify the prompt was submitted and retry.',
        ));
      }
      return urlInfo;
    })
    .catch((err) => {
      recordBindingError(err);
      return { conversationId: '', conversationUrl: '' };
    });

  return {
    bindingPromise,
    bindingFailurePromise,
    getBindingError: () => urlBindingError,
  };
}

export function resolveResultConversation(urlInfo, collectorConversationId) {
  const conversationId = (urlInfo && urlInfo.conversationId) || collectorConversationId || '';
  let conversationUrl = (urlInfo && urlInfo.conversationUrl) || '';
  if (conversationId && !/\/c\//.test(conversationUrl || '')) {
    conversationUrl = `${CHATGPT_URL}/c/${conversationId}`;
  }
  return { conversationId, conversationUrl };
}

export function assertSuccessfulImageExports(artifacts, downloads) {
  const expectedImageCount = (artifacts && Array.isArray(artifacts.images)) ? artifacts.images.length : 0;
  if (expectedImageCount > 0) {
    const imageExports = (downloads || []).filter((d) => d && d.kind === 'image-export');
    const successfulImages = imageExports.filter((d) => d.downloaded === true);
    if (successfulImages.length === 0) {
      const errorCodes = imageExports
        .map((d) => d.error)
        .filter(Boolean);
      const uniqueCodes = [...new Set(errorCodes)];
      const codeDetails = uniqueCodes.length > 0 ? ` errors=[${uniqueCodes.join(', ')}].` : '';
      throw new CommandExecutionError(
        'IMAGE_EXPORT_FAILED: protocol reported generated image(s) but no image export succeeded',
        `expected=${expectedImageCount}, successful=0.${codeDetails} Check if images were rendered on page or time was insufficient.`,
      );
    }
  }
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
    'Send a prompt to ChatGPT Agent; return text, files, and images for one turn',
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
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
      help: `Max seconds to wait for the agent turn (default ${DEFAULT_TIMEOUT_SEC})`,
    },
    {
      name: 'file',
      valueRequired: true,
      repeatable: true,
      help: 'Local file to attach (repeatable up to 20 files: --file "/absolute/path/to/file1" --file "/absolute/path/to/file2"); comma-separated also ok',
    },
    {
      name: 'op',
      valueRequired: true,
      help: 'Output directory for images and files (default: ~/Pictures/chatgpt-agent)',
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
      'Example: opencli chatgpt-agent ask "hello" --timeout 1200',
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
    };

    await bootConversation();

    // The /new route can still be hydrating when its first composer wait ends.
    // Give it a bounded settle and at most one reload before requiring the
    // composer; never submit a prompt during recovery.
    const health = await ensureHealthyChatSurface(page, {
      session,
      reload: bootConversation,
    });
    if (health.after?.broken) {
      throw new CommandExecutionError(
        'PAGE_BROKEN: ChatGPT composer or thread did not become ready before send',
        `reloadAttempted=${!!health.recovered} composer=${!!health.after.composer} `
          + `errorish=${!!health.after.errorish}. Inspect the automation tab's login state or interstitial before retrying.`,
      );
    }
    await ensureChatGPTComposer(
      page,
      'chatgpt-agent ask requires a visible composer. Open chatgpt.com and finish any interstitial.',
    );

    // Previous failed turns may leave Thinking / stop-button active. Wait or stop
    // before sending; if still generating, perform hard recovery before giving up.
    const preSendIdle = await ensureIdleSurfaceWithRecovery(page, {
      timeoutSec: Math.min(45, timeoutSec),
      session,
      hardReset: bootConversation,
    });
    if (!preSendIdle.ok) {
      throw new CommandExecutionError(
        'STILL_GENERATING: previous ChatGPT turn is still active after stop',
        'Open the automation tab, stop generation or open chatgpt.com/new, then retry.',
      );
    }
    // The idle recovery may have navigated again; revalidate before touching
    // the composer or arming capture, with no automatic retry after a send.
    await ensureChatGPTComposer(
      page,
      'chatgpt-agent ask requires a visible composer after idle recovery.',
    );

    // Clear leftover composer text/attachments from a previous failed or partial turn
    // (official chatgpt image does the same via clearChatGPTDraft before upload).
    await clearChatGPTDraft(page);

    // --- Optional attachments (setFileInput on composer file input) ---
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

    // Always disarm both captures after the turn so the tab lease does not keep
    // buffering frames/chunks between commands (bounded rings, but they still
    // hold requestId maps and keep hasActiveNetworkCapture true).
    // On failure, also stop generation and recover the shell so the next ask can submit.
    let turnSucceeded = false;
    let promptSent = false;
    try {
      // --- Arm HTTP-stream + WS capture BEFORE send ---
      await armTurnCaptures(page);

      // Brief settle so Network.enable is live before the page opens stream sockets.
      await page.sleep(0.3);

      const initialConversationId = await resolvePreSendConversationId(page, session);
      const collector = new StreamCollector({
        guarded: true,
        conversationId: initialConversationId || null,
      });
      const sseStream = new SseCaptureStream(collector);
      const t0 = Date.now();

      // --- Send ---
      const sent = await sendChatGPTMessage(page, prompt);
      if (!sent) {
        const state = await getChatGPTSendFailureState(page).catch(() => null);
        const diagnostics = state
          ? `composer=${!!state.composer} draftPresent=${!!state.draftPresent} `
            + `composerForm=${!!state.composerForm} buttonPresent=${!!state.buttonPresent} `
            + `buttonDisabled=${!!state.buttonDisabled}`
          : 'sendDiagnostics=unavailable';
        throw new CommandExecutionError(
          'SEND_FAILED: could not fill/submit ChatGPT composer',
          `${diagnostics}. Open ${CHATGPT_URL} in the automation window and verify the composer is ready.`,
        );
      }
      promptSent = true;

      // Conversation id may appear via URL and/or stream payloads.
      const urlWaitBudget = Math.min(45, timeoutSec);
      const urlInfoPromise = waitForConversationId(page, urlWaitBudget);
      const { bindingPromise, bindingFailurePromise, getBindingError } = wireCollectorUrlBinding(collector, urlInfoPromise);

      // --- Listen protocol stream ---
      // Honor the user's --timeout for both the outer bound and the
      // inner "no progress" budget so a long edit isn't cut off by the
      // 60s default while the overall timeout is still well within range.
      // The inner budget keeps a 30s cushion under the outer remaining time
      // and never drops below the original 60s safety floor.
      const wsBudgetMs = Math.max(1000, timeoutMs - (Date.now() - t0));
      const wsNoProgressMs = Math.min(wsBudgetMs, Math.max(60_000, wsBudgetMs - 30_000));
      let waitResult;
      let lastSurfaceProbeAt = 0;
      let lastSurface = null;
      // One throttled page probe serves both failure-banner detection and the
      // "still generating" gate, so each polling cycle costs at most one evaluate.
      const probeSurface = async () => {
        const now = Date.now();
        if (now - lastSurfaceProbeAt >= 1000) {
          lastSurfaceProbeAt = now;
          lastSurface = await probeChatSurface(page);
        }
        return lastSurface;
      };
      try {
        waitResult = await waitForProtocolStream(page, collector, {
          timeoutMs: wsBudgetMs,
          noProgressMs: wsNoProgressMs,
          abortPromise: bindingFailurePromise,
          sse: sseStream,
          isPageBusy: async () => {
            const surface = await probeSurface();
            return !!(surface && surface.generating);
          },
          checkPage: async () => {
            const surface = await probeSurface();
            if (!surface || !surface.generationFailed) return;
            const err = new Error(
              'GENERATION_FAILED: ChatGPT showed a generation error banner',
            );
            err.code = 'GENERATION_FAILED';
            throw err;
          },
        });
      } catch (err) {
        if (err && err.code === 'STUCK_NO_WS_PROGRESS') {
          throw new CommandExecutionError(
            err.message,
            'WS/HTTP-stream capture was armed before send but nothing arrived. Check Browser Bridge extension, '
            + 'login state, and that ChatGPT is actually streaming on this tab.',
          );
        }
        if (err && err.code === 'GENERATION_FAILED') {
          throw new CommandExecutionError(
            err.message,
            'ChatGPT failed while generating the response (often a transient gateway error). Retry the ask.',
          );
        }
        // A captured HTTP stream that is incomplete or undecodable already
        // discarded itself; never let a partial answer look successful.
        if (err && (err.code === SSE_CAPTURE_INCOMPLETE || err.code === SSE_CAPTURE_UNSUPPORTED)) {
          throw new CommandExecutionError(err.message, err.hint || SSE_CAPTURE_ARM_HINT);
        }
        throw err;
      }

      const urlInfo = await bindingPromise;
      const bindingErr = getBindingError();
      if (bindingErr) {
        throw bindingErr;
      }

      // Our own HTTP stream started but never reported its terminal event, so
      // the turn response is missing its tail: a quiet stream cannot be
      // distinguished from a truncated one, and partial output must never be
      // returned as a successful answer. This is reached at the user timeout.
      if (sseStream.isOpen()) {
        throw new CommandExecutionError(
          `${SSE_CAPTURE_INCOMPLETE}: the turn response did not report completion before the wait ended`,
          `reason=${waitResult.reason}; capture ${sseStream.describe()}. The partial response was discarded; `
          + 're-run with a higher --timeout or check the connection and retry.',
        );
      }

      const { conversationId, conversationUrl } = resolveResultConversation(urlInfo, collector.conversationId);

      // --- Package protocol artifacts only (no extra backend HTTP) ---
      let artifacts = await resolveArtifacts(collector, page, { conversationId });
      artifacts = enrichFilesFromText(artifacts);

      // A timeout is only fatal when protocol resolution produced no actual
      // text/file/image output. Preserve partial artifacts instead of discarding
      // them — the legacy WebSocket-only path, since an own HTTP stream that
      // started without terminating failed closed above.
      if (waitResult.reason === 'wait-timeout' && !hasReturnableArtifacts(artifacts)) {
        const partial = (collector.text || '').trim();
        throw new TimeoutError(
          'chatgpt-agent ask',
          timeoutSec,
          partial
            ? `Protocol turn incomplete; partial text length=${partial.length}. Re-run with higher --timeout.`
            : 'No protocol stream completion before timeout.',
        );
      }

      if (process.env.OPENCLI_VERBOSE) {
        console.error(
          `[chatgpt-agent] resolve textLen=${(artifacts.text || '').length} `
          + `sources=${(artifacts.sources || []).length} `
          + `files=${(artifacts.files || []).length} `
          + `images=${(artifacts.images || []).length} `
          + `frames=${collector.frameCount} events=${collector.eventCount} `
          + `${sseStream.describe()}`,
        );
      }

      if (!hasReturnableArtifacts(artifacts)) {
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
      // Managed output dir: Hub injects --op; local default remains ~/Pictures/chatgpt-agent.
      const managedOutputDir = resolveImageOutputDir(kwargs.op);

      if (fileNames.length > 0) {
        await page.sleep(1.0);
        const downloadBudget = Math.min(20_000, Math.max(8_000, Math.floor(remainingMs() * 0.3)));
        if (downloadBudget >= 5_000) {
          downloads = await downloadFilesViaDomClick(page, fileNames, {
            timeoutMs: downloadBudget,
          });
          // Chrome downloads land outside --op; copy completed files into managed dir.
          downloads = collectDownloadsToOutputDir(downloads, managedOutputDir);
        } else if (process.env.OPENCLI_VERBOSE) {
          console.error('[chatgpt-agent] skip file download: no time budget left');
        }
      }

      if ((artifacts.images || []).length > 0 && remainingMs() >= 3_000) {
        const imgDl = await exportNewImagesLikeOfficial(page, {
          beforeUrls: beforeImageUrls,
          expectedCount: artifacts.images.length,
          outputDir: managedOutputDir,
          settleMs: 1200,
          pollIterations: 60,
          canContinue: () => remainingMs() >= 2_000,
          // Caller owns route validation: build the reload hook only for a
          // verified /c/<id> conversation URL. At most one reload happens in
          // the dedicated automation tab when the first visual export has no
          // valid asset (e.g. ChatGPT still shows a sparse transparent
          // placeholder for the generated image).
          reloadConversation: conversationUrl && /\/(?:g\/g-p-[^/]+\/)?c\/[A-Za-z0-9_-]{8,}/.test(conversationUrl)
            ? async () => {
              await openChatGPTConversation(page, conversationUrl);
              await page.sleep(2);
            }
            : null,
          // Don't add a navigation reload unless there is enough remaining
          // user-timeout for reload + settle + a second polling pass
          // (~25s in practice). Below that the reload itself risks
          // exceeding the outer bound.
          canRetry: () => remainingMs() >= 25_000,
        });
        downloads = downloads.concat(imgDl);
      }

      assertSuccessfulImageExports(artifacts, downloads);

      // Successful image turns may leave the web UI in a lagging "Thinking" / stop state
      // even after protocol stream and DOM export finish. Run bounded idle recovery so subsequent
      // turns are not blocked. Never discard obtained artifacts if cleanup warns or fails.
      if ((artifacts.images || []).length > 0 && remainingMs() >= 15_000) {
        try {
          const cleanupBudgetSec = Math.min(10, Math.max(2, Math.floor((remainingMs() - 5_000) / 1000)));
          const cleanup = await ensureIdleSurfaceWithRecovery(page, {
            timeoutSec: cleanupBudgetSec,
            session,
            hardReset: bootConversation,
          });
          if (!cleanup.ok && process.env.OPENCLI_VERBOSE) {
            console.error('[chatgpt-agent] post-image idle recovery warning: surface still not idle after cleanup');
          }
        } catch (err) {
          if (process.env.OPENCLI_VERBOSE) {
            console.error(`[chatgpt-agent] post-image idle cleanup warning: ${err?.message || err}`);
          }
        }
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
        // Which transport actually delivered this turn's turn stream.
        source: sseStream.eventCount > 0 ? 'sse' : 'ws',
        reason: waitResult.reason,
      }];
      turnSucceeded = true;
      return result;
    } finally {
      if (typeof page.stopSseCapture === 'function') {
        await page.stopSseCapture().catch(() => null);
      }
      if (typeof page.stopWsCapture === 'function') {
        await page.stopWsCapture().catch(() => null);
      }
      // Recover only after a prompt was actually submitted: an arm failure
      // before send left the shell untouched and must not be "recovered".
      if (!turnSucceeded && promptSent) {
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

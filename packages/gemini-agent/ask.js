/**
 * gemini-agent ask — protocol-stream turn against Gemini web.
 *
 * Flow: boot session → arm StreamGenerate capture → fill+Enter → wait HTTP body
 * → resolve text/images → export new images.
 *
 * Reply parsing is StreamGenerate/batchexecute only. DOM is limited to
 * composer fill, Enter, setFileInput, and image bytes export.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { requireNonEmptyPrompt, requirePositiveInt } from './src/eval.js';
import {
  GEMINI_APP_URL,
  GEMINI_DOMAIN,
  geminiConversationUrl,
  parseGeminiSessionId,
  parseGeminiUrlSessionId,
} from './src/session.js';
import { STREAM_GENERATE_PATH } from './src/protocol.js';
import { StreamCollector } from './src/collector.js';
import { waitForProtocolCapture } from './src/wait-capture.js';
import {
  snapshotLoadedGeneratedImageCount,
  snapshotPerformanceMark,
} from './src/stream-timing.js';
import { hasReturnableArtifacts, resolveArtifacts } from './src/resolve.js';
import {
  clearGeminiDraft,
  currentGeminiUrl,
  ensureGeminiComposer,
  ensureGeminiLogin,
  openGeminiConversation,
  probeGeminiSurface,
  sendGeminiPrompt,
  startNewGeminiChat,
} from './src/composer.js';
import { prepareLocalFiles, uploadComposerFiles } from './src/upload.js';
import {
  exportTurnImages,
  resolveImageOutputDir,
  snapshotVisibleImageUrls,
} from './src/image-export.js';
import { collectDownloadsToOutputDir } from './src/artifact-collect.js';

const DEFAULT_TIMEOUT_SEC = 1200;
const CAPTURE_PATTERN = STREAM_GENERATE_PATH;

function serializeJson(value) {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    return '[]';
  }
}

export async function resolveConversationInfo(page, protocolSessionId = '', requestedSessionId = '') {
  const knownSessionId = protocolSessionId || requestedSessionId;
  if (knownSessionId) {
    return {
      sessionId: knownSessionId,
      conversationUrl: geminiConversationUrl(knownSessionId),
    };
  }
  const currentUrl = await currentGeminiUrl(page);
  const urlSessionId = parseGeminiUrlSessionId(currentUrl);
  return {
    sessionId: urlSessionId,
    conversationUrl: urlSessionId
      ? geminiConversationUrl(urlSessionId)
      : currentUrl || GEMINI_APP_URL,
  };
}

export const askCommand = cli({
  site: 'gemini-agent',
  name: 'ask',
  access: 'write',
  description:
    'Send a prompt to Gemini via StreamGenerate protocol; return text, files, and images for one turn',
  domain: GEMINI_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'ephemeral',
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    { name: 'prompt', positional: true, required: true, help: 'Prompt to send' },
    {
      name: 'session',
      valueRequired: true,
      help: 'Continue an existing conversation id or /app/<id> URL; omit to start a new chat',
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
      help: 'Output directory for exported images (default: ~/Pictures/gemini-agent)',
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
    const prompt = requireNonEmptyPrompt(kwargs.prompt, 'gemini-agent ask');
    const timeoutSec = requirePositiveInt(
      Number(kwargs.timeout ?? DEFAULT_TIMEOUT_SEC),
      'gemini-agent ask --timeout',
      'Example: opencli gemini-agent ask "hello" --timeout 1200',
    );
    const timeoutMs = timeoutSec * 1000;
    const session = kwargs.session != null && String(kwargs.session).trim()
      ? String(kwargs.session).trim()
      : '';
    const requestedSessionId = session ? parseGeminiSessionId(session) : '';
    if (session && !requestedSessionId) {
      throw new ArgumentError(
        'gemini-agent ask --session is not a valid Gemini conversation id or URL',
        'Pass a bare id, c_<id>, /app/<id>, or https://gemini.google.com/app/<id>.',
      );
    }

    const bootConversation = async () => {
      if (requestedSessionId) {
        await openGeminiConversation(page, requestedSessionId);
      } else {
        await startNewGeminiChat(page);
      }
      await ensureGeminiLogin(page, 'gemini-agent ask requires a logged-in Gemini browser session.');
      await ensureGeminiComposer(
        page,
        'gemini-agent ask requires a visible composer. Open gemini.google.com/app and finish any interstitial.',
      );
    };

    await bootConversation();
    await clearGeminiDraft(page);

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
          'Reload OpenCLI extension if setFileInput fails; ensure file upload is allowed for this Gemini account.',
        );
      }
      uploads = up.files || prepared.files.map((f) => f.name);
    }

    const beforeImageUrls = await snapshotVisibleImageUrls(page);
    const beforeLoadedImages = await snapshotLoadedGeneratedImageCount(page);

    if (typeof page.startNetworkCapture !== 'function') {
      throw new CommandExecutionError(
        'NETWORK_CAPTURE_UNSUPPORTED: page.startNetworkCapture is not available',
        'Use the forked OpenCLI CLI + Browser Bridge extension with network-capture support.',
      );
    }
    const armed = await page.startNetworkCapture(CAPTURE_PATTERN);
    if (!armed) {
      throw new CommandExecutionError(
        'NETWORK_CAPTURE_UNSUPPORTED: Browser Bridge extension does not support network-capture-start',
        'Load the forked extension from OpenCLI/extension-package and reload it, then retry.',
      );
    }

    const t0 = Date.now();
    const collector = new StreamCollector();
    try {
      if (typeof page.readNetworkCapture === 'function') {
        await page.readNetworkCapture().catch(() => []);
      }
      if (typeof page.sleep === 'function') await page.sleep(0.3);

      const streamMark = await snapshotPerformanceMark(page).catch(() => 0);
      const sent = await sendGeminiPrompt(page, prompt, {
        streamMark,
        controlTimeoutMs: prepared.files.length > 0 ? 60_000 : 3000,
      });
      if (!sent || sent.ok === false) {
        const reason = sent && sent.reason ? sent.reason : 'unknown';
        throw new CommandExecutionError(
          reason === 'fill'
            ? 'SEND_FAILED: could not fill Gemini composer'
            : reason === 'control'
              ? 'SEND_FAILED: Gemini send control did not become ready'
            : reason === 'hidden'
              ? 'SEND_FAILED: Gemini tab is not visible for trusted input'
              : 'SEND_FAILED: composer still holds the draft after Enter/submit',
          reason === 'hidden'
            ? 'Run with --window foreground --site-session ephemeral so Gemini can receive trusted mouse/keyboard input.'
            : reason === 'control'
              ? 'Wait for attachment processing to finish, remove any failed preview, and retry.'
            : sent && sent.dump
              ? `composerButtons=${JSON.stringify(sent.dump.buttons || [])}`
              : `Open ${GEMINI_APP_URL} in the automation window and verify the composer is ready.`,
        );
      }

      const captureBudgetMs = Math.max(1000, timeoutMs - (Date.now() - t0));
      const noProgressMs = Math.min(captureBudgetMs, Math.max(60_000, captureBudgetMs - 30_000));
      let waitResult;
      try {
        waitResult = await waitForProtocolCapture(page, collector, {
          timeoutMs: captureBudgetMs,
          noProgressMs,
          streamMark,
          beforeLoadedImages,
        });
      } catch (err) {
        if (err && err.code === 'STUCK_NO_STREAM_PROGRESS') {
          throw new CommandExecutionError(
            err.message,
            'Network capture armed before send but StreamGenerate did not start. Check login state and that Gemini actually submitted this turn.',
          );
        }
        throw err;
      }

      const { sessionId, conversationUrl } = await resolveConversationInfo(
        page,
        collector.sessionId,
        requestedSessionId,
      );

      let artifacts = resolveArtifacts(collector, { sessionId });
      if (waitResult.reason === 'wait-timeout' && !hasReturnableArtifacts(artifacts)) {
        const partial = (collector.text || '').trim();
        throw new TimeoutError(
          'gemini-agent ask',
          timeoutSec,
          partial
            ? `Protocol turn incomplete; partial text length=${partial.length}. Re-run with higher --timeout.`
            : 'No StreamGenerate completion before timeout.',
        );
      }

      if (!hasReturnableArtifacts(artifacts)) {
        throw new CommandExecutionError(
          'EMPTY_REPLY: stream finished without text/files/images',
          `reason=${waitResult.reason}; requests=${collector.requestCount} complete=${collector.completeCount}`,
        );
      }

      const managedOutputDir = resolveImageOutputDir(kwargs.op);
      let downloads = [];
      const remainingMs = () => Math.max(0, timeoutMs - (Date.now() - t0));
      if (artifacts.images.length > 0 && remainingMs() >= 2500) {
        const imgDl = await exportTurnImages(page, {
          beforeUrls: beforeImageUrls,
          protocolUrls: artifacts.images.map((image) => image.url).filter(Boolean),
          outputDir: managedOutputDir,
          settleMs: artifacts.images.length ? 800 : 400,
          downloadTimeoutMs: Math.min(60_000, Math.max(2000, remainingMs() - 1000)),
        });
        downloads = collectDownloadsToOutputDir(imgDl, managedOutputDir);
      }

      if (process.env.OPENCLI_VERBOSE) {
        console.error(
          `[gemini-agent] resolve textLen=${(artifacts.text || '').length} `
          + `images=${(artifacts.images || []).length} downloads=${downloads.length} `
          + `requests=${collector.requestCount}`,
        );
      }

      return [{
        conversationId: sessionId || '',
        conversationUrl,
        text: artifacts.text || '',
        files: serializeJson(artifacts.files),
        images: serializeJson(artifacts.images),
        sources: serializeJson(artifacts.sources || []),
        downloads: serializeJson(downloads),
        uploads: serializeJson(uploads),
        source: 'stream',
        reason: waitResult.reason,
      }];
    } finally {
      if (typeof page.readNetworkCapture === 'function') {
        await page.readNetworkCapture().catch(() => []);
      }
      const surface = await probeGeminiSurface(page).catch(() => null);
      if (surface?.overlayVisible && session) {
        await openGeminiConversation(page, session).catch(() => null);
      }
    }
  },
});

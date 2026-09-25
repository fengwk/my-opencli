/**
 * Poll OpenCLI page.readWsCapture / page.readSseCapture into a StreamCollector
 * until protocol end.
 *
 * Stateless relative to product features: exit on strong lifecycle + settled
 * text/images, or immediately classify a strong lifecycle with empty text.
 * Image gen often delivers final assets via conversation-update after an early
 * turn-stream complete — keep draining while image generation is pending.
 * A live own-POST SSE stream (opts.sse) is the turn's authoritative transport:
 * once it has started, only its terminal event may end the turn — a quiet or
 * timed-out stream fails closed in the command layer instead of returning a
 * partial answer. While it has not started yet, a WebSocket-only empty terminal
 * state is held for a bounded startup grace.
 */

export const STREAM_DEFAULTS = {
  TEXT_SETTLE_MS: 3000,
  /**
   * Multi-image batches often arrive several seconds apart; use a longer settle
   * when any image pointer is present so we do not exit after the first sibling.
   */
  IMAGE_SETTLE_MS: 12_000,
  /** After canExit, keep draining briefly so late citation/image patches arrive. */
  GRACE_MS: 4000,
  /** Safety: if pendingImageGen never sees ghostrider final, stop after this quiet. */
  PENDING_IMAGE_MAX_QUIET_MS: 45_000,
  /**
   * Startup bound for the turn's own POST: until its first chunk arrives, a
   * WebSocket-only empty terminal state is not proof that the turn is over
   * (legacy handshake frame, stale completion). Bounded so a build that never
   * streams over HTTP still classifies as before.
   */
  SSE_START_GRACE_MS: 4000,
  NO_PROGRESS_MS: 60_000,
  POLL_MS: 250,
};

/**
 * @param {object} page OpenCLI IPage
 * @param {import('./stream-collector.js').StreamCollector} collector
 * @param {{ timeoutMs: number, textSettleMs?: number, noProgressMs?: number, pollMs?: number, graceMs?: number, pendingImageMaxQuietMs?: number, imageSettleMs?: number, sseStartGraceMs?: number, abortPromise?: Promise<never>, checkPage?: () => Promise<void>, isPageBusy?: () => Promise<boolean>, sse?: { drain: (page: object) => Promise<number>, isOpen: () => boolean, describe: () => string, sawOwnStream: boolean } }} opts
 */
export async function waitForProtocolStream(page, collector, opts) {
  const timeoutMs = opts.timeoutMs;
  const textSettleMs = opts.textSettleMs ?? STREAM_DEFAULTS.TEXT_SETTLE_MS;
  const imageSettleMs = opts.imageSettleMs ?? STREAM_DEFAULTS.IMAGE_SETTLE_MS;
  const noProgressMs = opts.noProgressMs ?? STREAM_DEFAULTS.NO_PROGRESS_MS;
  const pollMs = opts.pollMs ?? STREAM_DEFAULTS.POLL_MS;
  const graceMs = opts.graceMs ?? STREAM_DEFAULTS.GRACE_MS;
  const pendingImageMaxQuietMs = opts.pendingImageMaxQuietMs ?? STREAM_DEFAULTS.PENDING_IMAGE_MAX_QUIET_MS;
  const sseStartGraceMs = opts.sseStartGraceMs ?? STREAM_DEFAULTS.SSE_START_GRACE_MS;
  const abortPromise = opts.abortPromise;
  const sse = opts.sse || null;
  const start = Date.now();
  const verbose = !!process.env.OPENCLI_VERBOSE;

  function waitAbortable(promise) {
    return abortPromise ? Promise.race([promise, abortPromise]) : promise;
  }

  async function checkPage() {
    if (typeof opts.checkPage === 'function') {
      await waitAbortable(opts.checkPage());
    }
  }

  async function pageBusy() {
    if (typeof opts.isPageBusy !== 'function') return false;
    try {
      return (await waitAbortable(opts.isPageBusy())) === true;
    } catch {
      return false;
    }
  }

  function settleMsForCollector() {
    if (collector.imagePointers.length > 0 || collector.pendingImageGen) {
      return imageSettleMs;
    }
    return textSettleMs;
  }

  function isPendingImageGeneration() {
    return collector.pendingImageGen && !collector.imageGenFinalSeen;
  }

  async function drainOnce() {
    const frames = typeof page.readWsCapture === 'function'
      ? await waitAbortable(page.readWsCapture())
      : [];
    for (const frame of frames || []) {
      if (!frame || frame.direction === 'sent') continue;
      collector.ingestFramePayload(frame.payload);
    }
    return frames?.length || 0;
  }

  /** Drain our own conversation POST's HTTP stream (integrity errors abort the turn). */
  async function drainSseOnce() {
    if (!sse) return 0;
    return await waitAbortable(sse.drain(page));
  }

  /**
   * Our own POST started (bytes captured) but has not reached its terminal
   * event. Such a turn is never complete: it is drained until the outer (user
   * --timeout) bound and then failed closed by the command layer, because a
   * quiet stream cannot be distinguished from a truncated one and partial
   * output must never look successful.
   */
  function sseUnterminated() {
    return !!(sse && sse.isOpen());
  }

  /**
   * The turn's own POST has not produced its first byte yet. While that is
   * still plausible, an empty WebSocket-only terminal state must not be
   * classified as the finished turn (that produced EMPTY_REPLY for turns whose
   * content only ever arrives over HTTP). The window is bounded from the start
   * of the wait, so a build that never streams over HTTP classifies as before.
   */
  function sseAwaitingFirstChunk() {
    return !!(sse && !sse.sawOwnStream && Date.now() - start < sseStartGraceMs);
  }

  async function graceDrain() {
    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline && Date.now() - start < timeoutMs) {
      await waitAbortable(page.sleep(pollMs / 1000));
      await drainOnce();
      await drainSseOnce();
      await checkPage();
    }
  }

  while (Date.now() - start < timeoutMs) {
    const n = await drainOnce();
    const sseChunks = await drainSseOnce();
    await checkPage();
    if (verbose && (n > 0 || sseChunks > 0)) {
      console.error(
        `[chatgpt-agent] ws frames+=${n} totalFrames=${collector.frameCount} `
        + `events=${collector.eventCount} textLen=${collector.text.length} `
        + `images=${collector.imagePointers.length} files=${collector.fileRefs.length} `
        + `tool=${collector.toolInvoked} pendingImg=${collector.pendingImageGen} `
        + `${sse ? `sse[${sse.describe()}]` : ''}`,
      );
    }

    const settleMs = settleMsForCollector();

    // Safety valve: stuck pending without final and no progress for a long time.
    if (collector.pendingImageGen && !collector.imageGenFinalSeen) {
      const last = collector.lastProgressAt || collector.firstProgressAt || start;
      if (Date.now() - last >= pendingImageMaxQuietMs && collector.imagePointers.length > 0) {
        collector.pendingImageGen = false;
        if (verbose) {
          console.error(
            `[chatgpt-agent] pending-image quiet timeout → accept ${collector.imagePointers.length} image(s)`,
          );
        }
      }
    }

    // A fixed terminal signal with empty text is a phase boundary, not a
    // last-progress quiet heuristic. A pending image tool has not completed
    // until its final marker, even before its first pointer arrives.
    if (collector.hasAnyStrongLifecycle() && collector.text.length === 0) {
      if (!isPendingImageGeneration()) {
        await graceDrain();
        if (collector.text.length > 0 || isPendingImageGeneration()) continue;
        // Post-stream resolution is only safe once the turn's own stream is
        // done: an open (or not yet started) HTTP stream may still deliver the
        // visible answer that the WebSocket side never carries.
        if (collector.needsPostStreamResolve() && !sseUnterminated() && !sseAwaitingFirstChunk()) {
          return { reason: 'stream-ended-await-post', text: '' };
        }
        // A finished turn stream with no visible text is not proof that the turn
        // is over: thinking models complete the stream while the visible answer
        // (and any image tool call) is still being produced, and that content
        // arrives later through conversation updates. While the page itself
        // reports an active turn — or our own HTTP stream is still open or has
        // not started yet — keep draining; the outer timeout still bounds it.
        if (await pageBusy() || sseUnterminated() || sseAwaitingFirstChunk()) {
          if (verbose) {
            console.error('[chatgpt-agent] turn stream ended empty but the turn is still live → keep draining');
          }
          await waitAbortable(page.sleep(pollMs / 1000));
          continue;
        }
        return { reason: 'protocol-complete-text-empty', text: '' };
      }
    }

    if (collector.canExit(settleMs)) {
      await graceDrain();
      // Grace may have delivered a late image pointer/text patch. Re-check with
      // the collector's new artifact-specific settle rule before terminating.
      if (!collector.canExit(settleMsForCollector())) continue;
      // WebSocket evidence alone (legacy handshake frames, an unrelated
      // stream's completion) must not end an HTTP stream that has not reported
      // its terminal event — citations and late patches land there, and a
      // quiet stream may simply be truncated.
      if (sseUnterminated()) {
        if (verbose) {
          console.error('[chatgpt-agent] protocol settled but own HTTP stream is still open → keep draining');
        }
        await waitAbortable(page.sleep(pollMs / 1000));
        continue;
      }
      if (verbose) {
        console.error(
          `[chatgpt-agent] protocol-complete textLen=${collector.text.length} `
          + `sources=${collector.sources.length} files=${collector.fileRefs.length} `
          + `images=${collector.imagePointers.length}`,
        );
      }
      return { reason: 'protocol-complete', text: collector.text };
    }

    // Non-empty text may still be settling. A pending image tool remains open
    // because its visible asset is delivered by a later protocol update.
    if (collector.hasAnyStrongLifecycle() || collector.pendingImageGen) {
      await waitAbortable(page.sleep(pollMs / 1000));
      continue;
    }

    if (collector.firstProgressAt === null && Date.now() - start >= noProgressMs) {
      const err = new Error(
        `STUCK_NO_WS_PROGRESS: no websocket stream activity within ${Math.round(noProgressMs / 1000)}s`,
      );
      err.code = 'STUCK_NO_WS_PROGRESS';
      throw err;
    }

    await waitAbortable(page.sleep(pollMs / 1000));
  }

  return {
    reason: 'wait-timeout',
    text: collector.text,
    partial: true,
  };
}

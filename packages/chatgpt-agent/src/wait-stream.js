/**
 * Poll OpenCLI page.readWsCapture into a StreamCollector until protocol end.
 *
 * Stateless relative to product features: exit on strong lifecycle + settled
 * text/images, or immediately classify a strong lifecycle with empty text.
 * Image gen often delivers final assets via conversation-update after an early
 * turn-stream complete — keep draining while an actual image pointer is pending.
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
  NO_PROGRESS_MS: 60_000,
  POLL_MS: 250,
};

/**
 * @param {object} page OpenCLI IPage
 * @param {import('./stream-collector.js').StreamCollector} collector
 * @param {{ timeoutMs: number, textSettleMs?: number, noProgressMs?: number, pollMs?: number, graceMs?: number, pendingImageMaxQuietMs?: number, imageSettleMs?: number }} opts
 */
export async function waitForProtocolStream(page, collector, opts) {
  const timeoutMs = opts.timeoutMs;
  const textSettleMs = opts.textSettleMs ?? STREAM_DEFAULTS.TEXT_SETTLE_MS;
  const imageSettleMs = opts.imageSettleMs ?? STREAM_DEFAULTS.IMAGE_SETTLE_MS;
  const noProgressMs = opts.noProgressMs ?? STREAM_DEFAULTS.NO_PROGRESS_MS;
  const pollMs = opts.pollMs ?? STREAM_DEFAULTS.POLL_MS;
  const graceMs = opts.graceMs ?? STREAM_DEFAULTS.GRACE_MS;
  const pendingImageMaxQuietMs = opts.pendingImageMaxQuietMs ?? STREAM_DEFAULTS.PENDING_IMAGE_MAX_QUIET_MS;
  const start = Date.now();
  const verbose = !!process.env.OPENCLI_VERBOSE;

  function settleMsForCollector() {
    if (collector.imagePointers.length > 0) {
      return imageSettleMs;
    }
    return textSettleMs;
  }

  function isPendingImageBatch() {
    return collector.imagePointers.length > 0
      && collector.pendingImageGen
      && !collector.imageGenFinalSeen;
  }

  async function drainOnce() {
    const frames = typeof page.readWsCapture === 'function'
      ? await page.readWsCapture()
      : [];
    for (const frame of frames || []) {
      if (!frame || frame.direction === 'sent') continue;
      collector.ingestFramePayload(frame.payload);
    }
    return frames?.length || 0;
  }

  async function graceDrain() {
    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline && Date.now() - start < timeoutMs) {
      await page.sleep(pollMs / 1000);
      await drainOnce();
    }
  }

  while (Date.now() - start < timeoutMs) {
    const n = await drainOnce();
    if (verbose && n > 0) {
      console.error(
        `[chatgpt-agent] ws frames+=${n} totalFrames=${collector.frameCount} `
        + `events=${collector.eventCount} textLen=${collector.text.length} `
        + `images=${collector.imagePointers.length} files=${collector.fileRefs.length} `
        + `tool=${collector.toolInvoked} pendingImg=${collector.pendingImageGen}`,
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
    // last-progress quiet heuristic. Preserve an already-started multi-image
    // batch until its final marker (or the pointer-specific safety valve).
    if (collector.hasAnyStrongLifecycle() && collector.text.length === 0) {
      if (!isPendingImageBatch()) {
        await graceDrain();
        if (collector.text.length > 0 || isPendingImageBatch()) continue;
        if (collector.needsPostStreamResolve()) {
          return { reason: 'stream-ended-await-post', text: '' };
        }
        return { reason: 'protocol-complete-text-empty', text: '' };
      }
    }

    if (collector.canExit(settleMs)) {
      await graceDrain();
      // Grace may have delivered a late image pointer/text patch. Re-check with
      // the collector's new artifact-specific settle rule before terminating.
      if (!collector.canExit(settleMsForCollector())) continue;
      if (verbose) {
        console.error(
          `[chatgpt-agent] protocol-complete textLen=${collector.text.length} `
          + `sources=${collector.sources.length} files=${collector.fileRefs.length} `
          + `images=${collector.imagePointers.length}`,
        );
      }
      return { reason: 'protocol-complete', text: collector.text };
    }

    // Non-empty text may still be settling. Pending image generation without an
    // actual pointer is not an output expectation, but still waits for a fixed
    // lifecycle or the outer timeout when no terminal signal has arrived.
    if (collector.hasAnyStrongLifecycle() || collector.pendingImageGen) {
      await page.sleep(pollMs / 1000);
      continue;
    }

    if (collector.firstProgressAt === null && Date.now() - start >= noProgressMs) {
      const err = new Error(
        `STUCK_NO_WS_PROGRESS: no websocket stream activity within ${Math.round(noProgressMs / 1000)}s`,
      );
      err.code = 'STUCK_NO_WS_PROGRESS';
      throw err;
    }

    await page.sleep(pollMs / 1000);
  }

  return {
    reason: 'wait-timeout',
    text: collector.text,
    partial: true,
  };
}

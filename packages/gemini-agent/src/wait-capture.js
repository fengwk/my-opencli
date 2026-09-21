/**
 * Wait for Gemini StreamGenerate to finish, then drain OpenCLI network capture.
 *
 * Do not poll readNetworkCapture while the HTTP stream is in flight: the
 * extension clears the in-progress entry and loadingFinished can no longer
 * attach the body.
 */

import {
  isStreamGenerateBusy,
  isStreamGenerateFinished,
  probeStreamGenerateTiming,
} from './stream-timing.js';

export const CAPTURE_DEFAULTS = {
  SETTLE_MS: 800,
  IMAGE_SETTLE_MS: 2500,
  NO_PROGRESS_MS: 60_000,
  POLL_MS: 250,
  IDLE_FALLBACK_MS: 8000,
  BODY_GRACE_MS: 400,
  VISUAL_SETTLE_MS: 8000,
};

async function sleepPage(page, ms) {
  const seconds = Math.max(0, ms / 1000);
  if (typeof page.sleep === 'function') await page.sleep(seconds);
  else if (typeof page.wait === 'function') await page.wait(seconds);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForProtocolCapture(page, collector, opts) {
  const timeoutMs = opts.timeoutMs;
  const settleMs = opts.settleMs ?? CAPTURE_DEFAULTS.SETTLE_MS;
  const imageSettleMs = opts.imageSettleMs ?? CAPTURE_DEFAULTS.IMAGE_SETTLE_MS;
  const noProgressMs = opts.noProgressMs ?? CAPTURE_DEFAULTS.NO_PROGRESS_MS;
  const pollMs = opts.pollMs ?? CAPTURE_DEFAULTS.POLL_MS;
  const idleFallbackMs = opts.idleFallbackMs ?? CAPTURE_DEFAULTS.IDLE_FALLBACK_MS;
  const bodyGraceMs = opts.bodyGraceMs ?? CAPTURE_DEFAULTS.BODY_GRACE_MS;
  const visualSettleMs = opts.visualSettleMs ?? CAPTURE_DEFAULTS.VISUAL_SETTLE_MS;
  const streamMark = opts.streamMark;
  const start = Date.now();
  const verbose = !!process.env.OPENCLI_VERBOSE;
  const useTimingProbe = streamMark !== undefined && typeof page.evaluate === 'function';

  async function drainOnce() {
    const entries = typeof page.readNetworkCapture === 'function'
      ? await page.readNetworkCapture()
      : [];
    const n = collector.ingestCaptureEntries(entries);
    return { n, raw: entries?.length || 0 };
  }

  function currentSettleMs() {
    if (collector.images.length > 0 || collector.toolFlags.includes('image_gen')) {
      return imageSettleMs;
    }
    return settleMs;
  }

  let allowedToDrain = !useTimingProbe;
  let idleSince = null;
  let visualSince = null;
  let grantedDrainAt = 0;
  const beforeLoadedImages = Number(opts.beforeLoadedImages) || 0;

  while (Date.now() - start < timeoutMs) {
    if (!allowedToDrain) {
      const probe = await probeStreamGenerateTiming(page, streamMark);
      const finished = Number(streamMark) > 0 && isStreamGenerateFinished(probe);
      const busy = isStreamGenerateBusy(probe);
      const visualDone = !probe.overlayVisible && !probe.busy && probe.loadedImages > beforeLoadedImages;
      if (visualDone) {
        if (visualSince == null) visualSince = Date.now();
      } else {
        visualSince = null;
      }
      if (finished || (visualSince != null && Date.now() - visualSince >= visualSettleMs)) {
        allowedToDrain = true;
        grantedDrainAt = Date.now();
        if (verbose) {
          console.error(
            `[gemini-agent] stream ready count=${probe.count} allDone=${probe.allDone} `
            + `loadedImages=${probe.loadedImages}`,
          );
        }
        await sleepPage(page, bodyGraceMs);
      } else if (!busy && opts.allowIdleFallback === true) {
        if (idleSince == null) idleSince = Date.now();
        if (Date.now() - idleSince >= idleFallbackMs) {
          allowedToDrain = true;
          grantedDrainAt = Date.now();
          if (verbose) {
            console.error('[gemini-agent] stream idle fallback → drain capture');
          }
          await sleepPage(page, bodyGraceMs);
        }
      } else {
        idleSince = null;
      }

      if (!allowedToDrain) {
        if (probe.count === 0 && Date.now() - start >= noProgressMs) {
          const err = new Error(
            `STUCK_NO_STREAM_PROGRESS: no StreamGenerate activity within ${Math.round(noProgressMs / 1000)}s`,
          );
          err.code = 'STUCK_NO_STREAM_PROGRESS';
          throw err;
        }
        await sleepPage(page, pollMs);
        continue;
      }
    }

    const { n } = await drainOnce();
    if (verbose && n > 0) {
      console.error(
        `[gemini-agent] capture +=${n} requests=${collector.requestCount} `
        + `complete=${collector.completeCount} textLen=${collector.text.length} `
        + `images=${collector.images.length}`,
      );
    }

    if (collector.canExit(currentSettleMs())) {
      await drainOnce();
      if (!collector.canExit(currentSettleMs())) continue;
      return {
        reason: 'protocol-complete',
        text: collector.text,
      };
    }

    if (!collector.hasStarted() && Date.now() - start >= noProgressMs) {
      const err = new Error(
        `STUCK_NO_STREAM_PROGRESS: no StreamGenerate activity within ${Math.round(noProgressMs / 1000)}s`,
      );
      err.code = 'STUCK_NO_STREAM_PROGRESS';
      throw err;
    }

    // After we were allowed to drain, keep polling a short while for the
    // loadingFinished body. If it never arrives, the outer timeout still binds.
    if (useTimingProbe && grantedDrainAt && Date.now() - grantedDrainAt > 20_000 && collector.hasCompleteBody()) {
      return {
        reason: 'protocol-complete',
        text: collector.text,
      };
    }

    await sleepPage(page, pollMs);
  }

  await drainOnce();
  if (collector.hasCompleteBody() && (collector.hasReturnableOutput() || collector.finished)) {
    return {
      reason: 'protocol-complete',
      text: collector.text,
    };
  }
  return {
    reason: 'wait-timeout',
    text: collector.text,
    partial: true,
  };
}

/**
 * Detect StreamGenerate completion without draining CDP capture.
 *
 * OpenCLI readNetworkCapture copies and clears the in-flight entry. If we
 * drain after responseReceived but before loadingFinished, the body is lost
 * and the turn hangs until timeout. Use Performance resource timing instead.
 */

import { unwrapEvaluateResult } from './eval.js';

export function snapshotPerformanceMarkScript() {
  return `(() => ({ now: performance.now() }))()`;
}

export async function snapshotPerformanceMark(page) {
  const raw = await page.evaluate(snapshotPerformanceMarkScript()).catch(() => ({ now: 0 }));
  const data = unwrapEvaluateResult(raw) || {};
  const now = Number(data.now);
  return Number.isFinite(now) ? now : 0;
}

export function loadedGeneratedImageCountScript() {
  return `(() => ({
    count: document.querySelectorAll('main img.image.loaded, main img.image.animate.loaded').length,
  }))()`;
}

export async function snapshotLoadedGeneratedImageCount(page) {
  const raw = await page.evaluate(loadedGeneratedImageCountScript()).catch(() => ({ count: 0 }));
  const data = unwrapEvaluateResult(raw) || {};
  const count = Number(data.count);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function streamGenerateTimingScript(minStartTime) {
  const minStart = Number(minStartTime) || 0;
  return `(() => {
    const minStart = ${minStart};
    const entries = (performance.getEntriesByType('resource') || []).filter((entry) => {
      const name = String(entry.name || '');
      return name.includes('StreamGenerate') && Number(entry.startTime) >= minStart - 50;
    });
    const overlays = [...document.querySelectorAll('[data-test-id="image-loading-overlay"]')];
    const overlayVisible = overlays.some((overlay) => (
      overlay instanceof HTMLElement
      && !overlay.classList.contains('done-generating')
      && overlay.offsetWidth
      && overlay.offsetHeight
    ));
    const busy = !!document.querySelector('[aria-busy="true"]');
    const allDone = entries.length > 0 && entries.every((entry) => Number(entry.responseEnd) > 0);
    const loadedImages = document.querySelectorAll('main img.image.loaded, main img.image.animate.loaded').length;
    return {
      count: entries.length,
      allDone,
      overlayVisible,
      busy,
      loadedImages,
    };
  })()`;
}

export async function probeStreamGenerateTiming(page, minStartTime) {
  const raw = await page.evaluate(streamGenerateTimingScript(minStartTime)).catch(() => null);
  const data = unwrapEvaluateResult(raw);
  if (!data || typeof data !== 'object') {
    return { count: 0, allDone: false, overlayVisible: false, busy: false };
  }
  return {
    count: Number(data.count) || 0,
    allDone: !!data.allDone,
    overlayVisible: !!data.overlayVisible,
    busy: !!data.busy,
    loadedImages: Number(data.loadedImages) || 0,
  };
}

export function isStreamGenerateBusy(probe) {
  if (!probe) return false;
  if (probe.overlayVisible || probe.busy) return true;
  if (probe.count > 0 && !probe.allDone) return true;
  return false;
}

export function isStreamGenerateFinished(probe) {
  return !!(probe && probe.count > 0 && probe.allDone && !probe.overlayVisible && !probe.busy);
}

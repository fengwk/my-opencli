import { describe, expect, it } from 'vitest';
import {
  loadedGeneratedImageCountScript,
  streamGenerateTimingScript,
} from '../src/stream-timing.js';

describe('streamGenerateTimingScript', () => {
  it('treats a persistent done-generating overlay as completed UI', () => {
    const script = streamGenerateTimingScript(12.5);
    expect(script).toContain("querySelectorAll('[data-test-id=\"image-loading-overlay\"]')");
    expect(script).toContain("!overlay.classList.contains('done-generating')");
  });

  it('counts only completed generated-image nodes for the visual baseline', () => {
    const script = loadedGeneratedImageCountScript();
    expect(script).toContain('main img.image.loaded');
    expect(script).toContain('main img.image.animate.loaded');
    expect(script).not.toContain('input-area-v2 img');
  });
});

import { describe, expect, it } from 'vitest';
import { StreamCollector } from '../src/collector.js';
import { waitForProtocolCapture } from '../src/wait-capture.js';

function wrbLine(payload) {
  return JSON.stringify([['wrb.fr', null, JSON.stringify(payload)]]);
}

function streamEntry(text) {
  const payload = [null, ['c_a70ce6d4e6eeb15d', 'r_1'], null, null, [['rc_1', [text], null, null, null, null, null, null, [2]]]];
  const line = wrbLine(payload);
  return {
    url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    method: 'POST',
    responseStatus: 200,
    responsePreview: `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`,
  };
}

describe('waitForProtocolCapture', () => {
  it('returns protocol-complete after StreamGenerate body arrives', async () => {
    let reads = 0;
    const page = {
      readNetworkCapture: async () => {
        reads += 1;
        return reads === 1 ? [streamEntry('hello from stream')] : [];
      },
      sleep: async () => {},
    };
    const collector = new StreamCollector();
    const result = await waitForProtocolCapture(page, collector, {
      timeoutMs: 50,
      settleMs: 0,
      imageSettleMs: 0,
      pollMs: 0,
      noProgressMs: 50,
    });
    expect(result.reason).toBe('protocol-complete');
    expect(collector.text).toBe('hello from stream');
  });

  it('throws when no StreamGenerate starts before noProgressMs', async () => {
    const page = {
      readNetworkCapture: async () => [],
      sleep: async () => {},
    };
    const collector = new StreamCollector();
    await expect(waitForProtocolCapture(page, collector, {
      timeoutMs: 20,
      noProgressMs: 0,
      pollMs: 0,
      settleMs: 0,
    })).rejects.toMatchObject({ code: 'STUCK_NO_STREAM_PROGRESS' });
  });

  it('does not drain capture until StreamGenerate resource timing completes', async () => {
    let reads = 0;
    let probes = 0;
    const page = {
      evaluate: async () => {
        probes += 1;
        if (probes < 2) {
          return { count: 1, allDone: false, overlayVisible: false, busy: false };
        }
        return { count: 1, allDone: true, overlayVisible: false, busy: false };
      },
      readNetworkCapture: async () => {
        reads += 1;
        return [streamEntry('hello after idle')];
      },
      sleep: async () => {},
    };
    const collector = new StreamCollector();
    const result = await waitForProtocolCapture(page, collector, {
      timeoutMs: 50,
      settleMs: 0,
      imageSettleMs: 0,
      pollMs: 0,
      noProgressMs: 50,
      bodyGraceMs: 0,
      streamMark: 12.5,
    });
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(result.reason).toBe('protocol-complete');
    expect(collector.text).toBe('hello after idle');
  });

  it('uses a stable loaded image as a fallback when resource timing never closes', async () => {
    let reads = 0;
    const page = {
      evaluate: async () => ({
        count: 1,
        allDone: false,
        overlayVisible: false,
        busy: false,
        loadedImages: 1,
      }),
      readNetworkCapture: async () => {
        reads += 1;
        return reads === 1 ? [streamEntry('image response metadata')] : [];
      },
      sleep: async () => {},
    };
    const collector = new StreamCollector();
    const result = await waitForProtocolCapture(page, collector, {
      timeoutMs: 50,
      settleMs: 0,
      imageSettleMs: 0,
      visualSettleMs: 0,
      pollMs: 0,
      noProgressMs: 50,
      bodyGraceMs: 0,
      streamMark: 12.5,
      beforeLoadedImages: 0,
    });
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(result.reason).toBe('protocol-complete');
    expect(collector.text).toBe('image response metadata');
  });
});

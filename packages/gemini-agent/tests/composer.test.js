import { describe, expect, it, vi } from 'vitest';
import {
  fillGeminiComposer,
  sendGeminiPrompt,
  sendTargetLocatorScript,
} from '../src/composer.js';

describe('sendGeminiPrompt with trusted CDP click', () => {
  it('executes trusted slow CDP click (mouseMoved -> mousePressed -> 80ms sleep -> mouseReleased) and confirms submit', async () => {
    let hasText = false;
    const events = [];
    const evaluateCalls = [];

    const page = {
      evaluate: vi.fn(async (script) => {
        if (typeof script !== 'string') return { ok: true, ready: true };
        evaluateCalls.push(script);
        if (script.includes('text.length > 0')) return hasText;
        if (script.includes('findSendTarget')) {
          return {
            ok: true,
            ready: true,
            x: 120,
            y: 340,
            rect: { left: 100, top: 320, width: 40, height: 40 },
          };
        }
        return { ok: true, ready: true };
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async (s) => {
        events.push({ type: 'sleep', s });
      }),
      cdp: vi.fn(async (method, params) => {
        events.push({ type: 'cdp', method, params });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          hasText = false;
        }
        return {};
      }),
    };

    const res = await sendGeminiPrompt(page, 'What is the capital of France?');

    expect(res).toMatchObject({ ok: true, via: 'click' });
    expect(page.nativeType).toHaveBeenCalledWith('What is the capital of France?');

    // Verify slow CDP click sequence: mouseMoved -> mousePressed -> sleep 80ms -> mouseReleased
    const cdpMouseEvents = events.filter((e) => e.type === 'cdp' && e.method === 'Input.dispatchMouseEvent');
    expect(cdpMouseEvents).toEqual([
      {
        type: 'cdp',
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 120, y: 340, pointerType: 'mouse' },
      },
      {
        type: 'cdp',
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          x: 120,
          y: 340,
          button: 'left',
          clickCount: 1,
          buttons: 1,
          pointerType: 'mouse',
        },
      },
      {
        type: 'cdp',
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: 120,
          y: 340,
          button: 'left',
          clickCount: 1,
          buttons: 0,
          pointerType: 'mouse',
        },
      },
    ]);

    // Verify 80ms sleep occurs between mousePressed and mouseReleased
    const mousePressedIndex = events.findIndex(
      (e) => e.type === 'cdp' && e.params?.type === 'mousePressed',
    );
    const sleep80Index = events.findIndex((e) => e.type === 'sleep' && e.s === 0.08);
    const mouseReleasedIndex = events.findIndex(
      (e) => e.type === 'cdp' && e.params?.type === 'mouseReleased',
    );

    expect(mousePressedIndex).toBeGreaterThanOrEqual(0);
    expect(sleep80Index).toBe(mousePressedIndex + 1);
    expect(mouseReleasedIndex).toBe(sleep80Index + 1);

    // Verify evaluate scripts do not contain localized text
    const allScripts = evaluateCalls.join('\n');
    expect(allScripts).not.toMatch(/发送|Send message|send prompt|提交/i);
  });

  it('falls back to raw CDP Enter when slow click does not clear composer', async () => {
    let hasText = false;
    const events = [];
    const evaluateCalls = [];

    const page = {
      evaluate: vi.fn(async (script) => {
        if (typeof script !== 'string') return { ok: true, ready: true };
        evaluateCalls.push(script);
        if (script.includes('text.length > 0')) return hasText;
        if (script.includes('findSendTarget')) {
          return {
            ok: true,
            ready: true,
            x: 150,
            y: 300,
            rect: { left: 130, top: 280, width: 40, height: 40 },
          };
        }
        return { ok: true, ready: true };
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async (s) => {
        events.push({ type: 'sleep', s });
      }),
      cdp: vi.fn(async (method, params) => {
        events.push({ type: 'cdp', method, params });
        // Slow click fails to clear composer (hasText stays true),
        // but raw Enter keyUp clears the composer.
        if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
          hasText = false;
        }
        return {};
      }),
    };

    const res = await sendGeminiPrompt(page, 'Explain quantum entanglement', { submitTimeoutMs: 50 });

    expect(res).toMatchObject({ ok: true, via: 'enter' });

    // Verify mouse events happened first, followed by rawKeyDown and keyUp Enter key events
    const mouseReleasedIndex = events.findIndex(
      (e) => e.type === 'cdp' && e.params?.type === 'mouseReleased',
    );
    const rawKeyDownIndex = events.findIndex(
      (e) => e.type === 'cdp' && e.params?.type === 'rawKeyDown',
    );
    const keyUpIndex = events.findIndex(
      (e) => e.type === 'cdp' && e.params?.type === 'keyUp',
    );

    expect(mouseReleasedIndex).toBeGreaterThanOrEqual(0);
    expect(rawKeyDownIndex).toBeGreaterThan(mouseReleasedIndex);
    expect(keyUpIndex).toBe(rawKeyDownIndex + 1);

    expect(events[rawKeyDownIndex]).toEqual({
      type: 'cdp',
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      },
    });

    expect(events[keyUpIndex]).toEqual({
      type: 'cdp',
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      },
    });

    const allScripts = evaluateCalls.join('\n');
    expect(allScripts).not.toMatch(/发送|Send message|send prompt|提交/i);
  });

  it('recognizes StreamGenerate performance resource after streamMark as submit signal', async () => {
    let hasText = true;
    let streamProbeCount = 0;

    const page = {
      evaluate: vi.fn(async (script) => {
        if (typeof script !== 'string') return { ok: true, ready: true };
        if (script.includes('text.length > 0')) return hasText;
        if (script.includes('findSendTarget')) {
          return { ok: true, ready: true, x: 100, y: 200, rect: { left: 80, top: 180, width: 40, height: 40 } };
        }
        if (script.includes('StreamGenerate')) {
          return { count: streamProbeCount, allDone: false, overlayVisible: false, busy: false };
        }
        return { ok: true, ready: true };
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async () => {}),
      cdp: vi.fn(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          // StreamGenerate request begins even if composer still temporarily holds text
          streamProbeCount = 1;
        }
        return {};
      }),
    };

    const res = await sendGeminiPrompt(page, 'Test with streamMark', { streamMark: 5432.1 });
    expect(res).toMatchObject({ ok: true, via: 'click' });
  });

  it('falls back to nativeClick and nativeKeyPress when CDP is unavailable', async () => {
    let hasText = true;
    const clicks = [];
    const keyPresses = [];

    const page = {
      evaluate: vi.fn(async (script) => {
        if (typeof script !== 'string') return { ok: true, ready: true };
        if (script.includes('text.length > 0')) return hasText;
        if (script.includes('findSendTarget')) {
          return { ok: true, ready: true, x: 250, y: 400, rect: { left: 230, top: 380, width: 40, height: 40 } };
        }
        return { ok: true, ready: true };
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async () => {}),
      nativeClick: vi.fn(async (x, y) => {
        clicks.push({ x, y });
        // Native click does not clear, requiring Enter
      }),
      nativeKeyPress: vi.fn(async (key) => {
        keyPresses.push(key);
        hasText = false;
      }),
    };

    const res = await sendGeminiPrompt(page, 'Fallback path', { submitTimeoutMs: 50 });
    expect(res).toMatchObject({ ok: true, via: 'enter' });
    expect(clicks).toEqual([{ x: 250, y: 400 }]);
    expect(keyPresses).toEqual(['Enter']);
  });

  it('returns failure dump when neither click nor Enter submits', async () => {
    let hasText = true;

    const page = {
      evaluate: vi.fn(async (script) => {
        if (typeof script !== 'string') return { ok: true, ready: true };
        if (script.includes('text.length > 0')) return hasText;
        if (script.includes('composerText') || script.includes('sendContainer')) {
          return {
            url: 'https://gemini.google.com/app',
            composerText: 'unsent text',
            sendContainer: true,
            sendTargetFound: true,
            sendTargetRect: { left: 100, top: 200, width: 40, height: 40 },
            buttons: [{ tag: 'gem-icon-button', disabled: false, w: 40, h: 40 }],
          };
        }
        if (script.includes('findSendTarget')) {
          return { ok: true, ready: true, x: 100, y: 200, rect: { left: 80, top: 180, width: 40, height: 40 } };
        }
        return { ok: true, ready: true };
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async () => {}),
      cdp: vi.fn(async () => ({})),
    };

    const res = await sendGeminiPrompt(page, 'Stuck draft', { submitTimeoutMs: 50 });
    expect(res).toMatchObject({
      ok: false,
      reason: 'submit',
      dump: {
        url: 'https://gemini.google.com/app',
        composerText: 'unsent text',
        sendContainer: true,
        sendTargetFound: true,
      },
    });
  });

  it('fails before typing when the Gemini tab is hidden', async () => {
    const page = {
      getActivePage: vi.fn(() => 'page-1'),
      selectTab: vi.fn(async () => {}),
      evaluate: vi.fn(async (script) => {
        if (String(script).includes('visibilityState')) {
          return { visibilityState: 'hidden', documentHasFocus: true };
        }
        return { ok: true };
      }),
      nativeType: vi.fn(async () => {}),
    };

    const res = await sendGeminiPrompt(page, 'Do not type this prompt');
    expect(res).toMatchObject({
      ok: false,
      reason: 'hidden',
      dump: { visibilityState: 'hidden' },
    });
    expect(page.selectTab).toHaveBeenCalledWith('page-1');
    expect(page.nativeType).not.toHaveBeenCalled();
  });

  it('distinguishes an unavailable send control from a text-fill failure', async () => {
    let hasText = false;
    const page = {
      evaluate: vi.fn(async (script) => {
        if (String(script).includes('visibilityState')) {
          return { visibilityState: 'visible', documentHasFocus: true };
        }
        if (String(script).includes('text.length > 0')) return hasText;
        if (String(script).includes('findSendTarget')) return { ready: false, ok: false };
        if (String(script).includes('return { ok: true }')) return { ok: true };
        return true;
      }),
      nativeType: vi.fn(async () => {
        hasText = true;
      }),
      sleep: vi.fn(async () => {}),
    };

    await expect(sendGeminiPrompt(page, 'Wait for the attachment', {
      controlTimeoutMs: 1,
    })).resolves.toMatchObject({ ok: false, reason: 'control' });
  });
});

describe('fillGeminiComposer', () => {
  it('returns false when the composer cannot be focused', async () => {
    const page = {
      evaluate: vi.fn(async () => ({ ok: false })),
      sleep: vi.fn(async () => {}),
    };
    await expect(fillGeminiComposer(page, 'hello')).resolves.toBe(false);
  });
});

describe('sendTargetLocatorScript and evaluate scripts', () => {
  it('does not contain localized submit text in generated locator scripts', () => {
    const locatorScript = sendTargetLocatorScript();
    expect(locatorScript).toContain('[data-test-id="send-button-container"]');
    expect(locatorScript).toContain('gem-icon-button');
    expect(locatorScript).not.toMatch(/发送|Send message|send prompt|提交/i);
  });
});

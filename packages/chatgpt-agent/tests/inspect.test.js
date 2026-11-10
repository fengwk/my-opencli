import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/host-chatgpt.js', async (importOriginal) => ({
  ...await importOriginal(),
  startNewChat: vi.fn(async () => {}),
  ensureChatGPTLogin: vi.fn(async () => {}),
}));

import { inspectCommand, probeNewChat, surfaceMetadata } from '../inspect.js';
import { startNewChat, ensureChatGPTLogin } from '../src/host-chatgpt.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('read-only new-chat diagnostics', () => {
  // Production polling/reload is exercised, but this command must never gain
  // the draft/upload/send methods, and its evidence must omit private content.
  it('records failed hydration and one reload without submitting a prompt', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      daemonVersion: '2.0.2-fengwk.6', extensionVersion: '1.0.39',
      profiles: [{ extensionVersion: '1.0.39', contextId: 'PRIVATE-PROFILE' }],
      sessionLeases: [{ owner: 'PRIVATE-OWNER' }],
    }) })));
    let probes = 0;
    const page = {
      evaluate: vi.fn(async () => ({
        url: 'https://chatgpt.com/?token=PRIVATE-TOKEN',
        composer: ++probes > 31, messages: 0, mainLen: 3772, mainText: 'PRIVATE-DRAFT',
        errorish: false, generationFailed: false, conversationUnavailable: false,
        visibility: 'hidden', composerCandidates: [], readyState: 'complete',
      })),
      sleep: vi.fn(async (seconds) => { vi.advanceTimersByTime(seconds * 1000); }),
      tabs: vi.fn(async () => [{ page: 'own-target', active: false,
        url: 'https://chatgpt.com/?token=PRIVATE-TAB-TOKEN', title: 'PRIVATE-TITLE' }]),
      getActivePage: () => 'own-target',
    };
    const result = await probeNewChat(page);
    expect(result.ready).toBe(true);
    expect(result.recovered).toBe(true);
    expect(startNewChat).toHaveBeenCalledTimes(2);
    expect(ensureChatGPTLogin).toHaveBeenCalledTimes(2);
    expect(result.timeline[0]).toMatchObject({ phase: 'initial', composer: false, visibility: 'hidden' });
    expect(result.timeline.at(-1)).toMatchObject({ phase: 'reload', composer: true });
    expect(result.runtime).toMatchObject({ daemonVersion: '2.0.2-fengwk.6', extensionVersions: ['1.0.39'] });
    expect(result.tabs.at(-1).tabs[0]).toEqual({ page: 'own-target', active: false, url: 'https://chatgpt.com/' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.timeline.length).toBeLessThanOrEqual(80);
  });

  // Reject accidental navigation of an existing conversation in new-chat mode.
  it('rejects conflicting diagnostic arguments before touching a browser', async () => {
    await expect(inspectCommand.func({}, { mode: 'new-chat', session: 'conversation-current' }))
      .rejects.toThrow('without a session');
    expect(startNewChat).not.toHaveBeenCalled();
  });

  // Screenshots are privileged opt-in evidence, never default diagnostics.
  // An unready phase is captured only once even when many polls fail.
  it('awaits one opt-in screenshot per unready phase before a reload', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-unready-probe-'));
    try {
      let count = 0;
      const page = {
        evaluate: async () => ({
          url: 'https://chatgpt.com/', composer: ++count > 31, messages: 0,
          mainLen: 3772, errorish: false, conversationUnavailable: false,
        }),
        sleep: async (seconds) => { vi.advanceTimersByTime(seconds * 1000); },
        screenshot: vi.fn(async () => {}),
      };
      const rows = await inspectCommand.func(page, {
        mode: 'new-chat', 'capture-unready': true, op: output,
      });
      const result = JSON.parse(rows[0].diagnostics);
      expect(result.ready).toBe(true);
      expect(page.screenshot).toHaveBeenCalledExactlyOnceWith({
        path: path.join(output, 'unready-initial.png'), fullPage: false, format: 'png',
      });
      expect(result.captures).toHaveLength(1);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  // newTab returns an ID without binding Page._page; select it explicitly so
  // a "cold" probe cannot silently return to a previously reclaimed target.
  it('selects the newly created target before the cold boot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const page = {
      newTab: vi.fn(async () => 'cold-target'),
      selectTab: vi.fn(async () => {}),
      evaluate: async () => ({
        url: 'https://chatgpt.com/', composer: true, messages: 0, errorish: false,
      }),
    };
    const rows = await inspectCommand.func(page, { mode: 'new-chat', 'fresh-tab': true });
    expect(page.selectTab).toHaveBeenCalledExactlyOnceWith('cold-target');
    expect(page.selectTab.mock.invocationCallOrder[0]).toBeLessThan(startNewChat.mock.invocationCallOrder[0]);
    expect(JSON.parse(rows[0].diagnostics).freshTarget).toBe('cold-target');
  });

  it('keeps only explicitly allowed surface fields', () => {
    const result = surfaceMetadata({
      url: 'https://chatgpt.com/c/current-conversation?secret=PRIVATE',
      composer: false, mainLen: 3772, mainText: 'PRIVATE',
      unknownField: 'PRIVATE', cookie: 'PRIVATE',
    });
    expect(result).toEqual({ url: 'https://chatgpt.com/c/current-conversation', composer: false, mainLen: 3772 });
  });
});

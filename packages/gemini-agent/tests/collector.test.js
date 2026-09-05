import { describe, expect, it } from 'vitest';
import { StreamCollector } from '../src/collector.js';

function wrbLine(payload) {
  return JSON.stringify([['wrb.fr', null, JSON.stringify(payload)]]);
}

function streamBody(text, cid = 'c_a70ce6d4e6eeb15d') {
  const payload = [null, [cid, 'r_1'], null, null, [['rc_1', [text], null, null, null, null, null, null, [2]]]];
  const line = wrbLine(payload);
  return `)]}'\n\n${Buffer.byteLength(line, 'utf8')}\n${line}\n`;
}

describe('StreamCollector', () => {
  it('ingests StreamGenerate capture entries and exposes session id without c_ prefix', () => {
    const collector = new StreamCollector();
    collector.ingestCaptureEntries([
      {
        url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
        method: 'POST',
        responseStatus: 200,
        responsePreview: streamBody('OPENCLI_ENTER_2'),
      },
    ]);
    expect(collector.hasCompleteBody()).toBe(true);
    expect(collector.text).toBe('OPENCLI_ENTER_2');
    expect(collector.conversationId).toBe('c_a70ce6d4e6eeb15d');
    expect(collector.sessionId).toBe('a70ce6d4e6eeb15d');
    collector.lastProgressAt = Date.now() - 2000;
    expect(collector.canExit(1500)).toBe(true);
  });

  it('ignores unrelated network entries', () => {
    const collector = new StreamCollector();
    collector.ingestCaptureEntry({
      url: 'https://play.google.com/log',
      responsePreview: '[]',
    });
    expect(collector.hasStarted()).toBe(false);
  });

  it('does not treat a status-only StreamGenerate as a complete body', () => {
    const collector = new StreamCollector();
    collector.ingestCaptureEntry({
      url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      method: 'POST',
      responseStatus: 200,
      responsePreview: '',
    });
    expect(collector.hasStarted()).toBe(true);
    expect(collector.hasCompleteBody()).toBe(false);
    expect(collector.text).toBe('');
  });
});

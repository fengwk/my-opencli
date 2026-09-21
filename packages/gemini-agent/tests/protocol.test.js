import { describe, expect, it } from 'vitest';
import {
  extractConversationIdFromPayload,
  extractTextFromPayload,
  isLikelyGeneratedImageUrl,
  isStreamGenerateUrl,
  normalizeGeneratedImageUrl,
  parseBatchexecuteBody,
  summarizeStreamBody,
} from '../src/protocol.js';

function wrbLine(payload) {
  return JSON.stringify([['wrb.fr', null, JSON.stringify(payload)]]);
}

function batchexecute(payloads) {
  const chunks = [];
  for (const payload of payloads) {
    const line = wrbLine(payload);
    chunks.push(`${Buffer.byteLength(line, 'utf8')}\n${line}`);
  }
  chunks.push('25\n[["e",4,null,null,167]]');
  return `)]}'\n\n${chunks.join('\n')}\n`;
}

function textPayload(cid, text, phase = 1) {
  const candidate = [
    'rc_1',
    [text],
    null,
    null,
    null,
    null,
    null,
    null,
    [phase],
  ];
  return [null, [cid, 'r_1'], null, null, [candidate]];
}

describe('StreamGenerate URL', () => {
  it('matches the live BardFrontendService endpoint', () => {
    expect(isStreamGenerateUrl(
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
    )).toBe(true);
  });

  it('ignores unrelated batchexecute RPCs', () => {
    expect(isStreamGenerateUrl(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D',
    )).toBe(false);
  });
});

describe('batchexecute parsing', () => {
  // Live Gemini 2026-09-05: text is payload[4][0][1][0], cid is payload[1][0].
  it('extracts growing text and conversation id from wrb.fr chunks', () => {
    const body = batchexecute([
      textPayload('c_a70ce6d4e6eeb15d', 'OPENCLI', 1),
      textPayload('c_a70ce6d4e6eeb15d', 'OPENCLI_ENTER_2', 2),
    ]);
    const chunks = parseBatchexecuteBody(body);
    expect(chunks).toHaveLength(2);
    expect(extractTextFromPayload(chunks[0].payload)).toBe('OPENCLI');
    expect(extractTextFromPayload(chunks[1].payload)).toBe('OPENCLI_ENTER_2');
    expect(extractConversationIdFromPayload(chunks[1].payload)).toBe('c_a70ce6d4e6eeb15d');
    expect(chunks[1].finished).toBe(true);

    const summary = summarizeStreamBody(body);
    expect(summary.text).toBe('OPENCLI_ENTER_2');
    expect(summary.conversationId).toBe('c_a70ce6d4e6eeb15d');
    expect(summary.finished).toBe(true);
  });

  it('collects generated image URLs and ignores chrome/avatar URLs', () => {
    const payload = textPayload('c_abc12345def67890', 'here is the image');
    payload[4][0].push([
      'https://lh3.googleusercontent.com/image_generation_content/abc123',
      'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/expand/default/24px.svg',
      'https://lh3.googleusercontent.com/a/ACg8ocProfile=s64-c',
    ]);
    const body = batchexecute([payload]);
    const summary = summarizeStreamBody(body);
    expect(summary.images.map((i) => i.url)).toEqual([
      'https://lh3.googleusercontent.com/image_generation_content/abc123',
    ]);
  });

  it('normalizes live image URL whitespace and drops pseudo URLs when a concrete asset exists', () => {
    const payload = textPayload('c_abc12345def67890', 'image ready');
    payload[4][0].push([
      '\n\nhttp://googleusercontent.com/image_generation_content/0_469\n\n',
      'http://googleusercontent.com/image_generation_content/0_469',
      'https://lh3.googleusercontent.com/gg-dl/full-size-image',
    ]);
    const summary = summarizeStreamBody(batchexecute([payload]));
    expect(summary.images.map((image) => image.url)).toEqual([
      'https://lh3.googleusercontent.com/gg-dl/full-size-image',
    ]);
  });
});

describe('isLikelyGeneratedImageUrl', () => {
  it('accepts image_generation_content and rejects sparkle/profile assets', () => {
    expect(isLikelyGeneratedImageUrl('https://lh3.googleusercontent.com/image_generation_content/x')).toBe(true);
    expect(isLikelyGeneratedImageUrl('https://www.gstatic.com/lamda/images/gemini_sparkle_aurora.svg')).toBe(false);
    expect(isLikelyGeneratedImageUrl('https://lh3.googleusercontent.com/a/ACg8ocKo=s64-c')).toBe(false);
  });

  it('trims and upgrades googleusercontent image URLs', () => {
    expect(normalizeGeneratedImageUrl(
      '\nhttp://googleusercontent.com/image_generation_content/0_469\n',
    )).toBe('https://googleusercontent.com/image_generation_content/0_469');
  });
});

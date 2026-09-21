import { describe, expect, it } from 'vitest';
import {
  geminiConversationUrl,
  parseGeminiSessionId,
  protocolConversationIdToSession,
  sessionToProtocolConversationId,
} from '../src/session.js';

describe('parseGeminiSessionId', () => {
  it('accepts URL, path, bare id, and protocol c_ id', () => {
    expect(parseGeminiSessionId('https://gemini.google.com/app/a70ce6d4e6eeb15d')).toBe('a70ce6d4e6eeb15d');
    expect(parseGeminiSessionId('/app/a70ce6d4e6eeb15d')).toBe('a70ce6d4e6eeb15d');
    expect(parseGeminiSessionId('a70ce6d4e6eeb15d')).toBe('a70ce6d4e6eeb15d');
    expect(parseGeminiSessionId('c_a70ce6d4e6eeb15d')).toBe('a70ce6d4e6eeb15d');
  });

  it('returns empty for new-chat /app', () => {
    expect(parseGeminiSessionId('https://gemini.google.com/app')).toBe('');
    expect(parseGeminiSessionId('')).toBe('');
  });
});

describe('protocol/session conversion', () => {
  it('round-trips URL id and protocol conversation id', () => {
    expect(protocolConversationIdToSession('c_a70ce6d4e6eeb15d')).toBe('a70ce6d4e6eeb15d');
    expect(sessionToProtocolConversationId('a70ce6d4e6eeb15d')).toBe('c_a70ce6d4e6eeb15d');
    expect(geminiConversationUrl('c_a70ce6d4e6eeb15d')).toBe('https://gemini.google.com/app/a70ce6d4e6eeb15d');
  });
});

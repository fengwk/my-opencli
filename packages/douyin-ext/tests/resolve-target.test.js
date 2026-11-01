import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  extractVideoId,
  resolveTargetToId,
  validateTrustedUrl,
} from '../src/resolve-target.js';

describe('douyin-ext resolve-target (URL security and ID resolution)', () => {
  it('accepts raw numeric video IDs directly', async () => {
    const rawId = '7701962254330128228';
    const result = await resolveTargetToId(rawId);
    expect(result.id).toBe(rawId);
  });

  // Verify full anchoring: 21 digits must not be truncated to 20 digits
  it('rejects numbers that are 21 digits long with ArgumentError', async () => {
    const longId = '123456789012345678901';
    await expect(resolveTargetToId(longId)).rejects.toThrow(ArgumentError);
    expect(extractVideoId(`https://www.douyin.com/video/${longId}`)).toBe('');
  });

  it('extracts ID from official www.douyin.com/video/<id> and iesdouyin URLs', () => {
    const id = '7701962254330128228';
    expect(extractVideoId(`https://www.douyin.com/video/${id}`)).toBe(id);
    expect(extractVideoId(`https://douyin.com/video/${id}/`)).toBe(id);
    expect(extractVideoId(`https://www.iesdouyin.com/share/video/${id}/`)).toBe(id);
    expect(extractVideoId(`https://www.douyin.com/discover?modal_id=${id}`)).toBe(id);
  });

  it('rejects non-HTTPS URLs with ArgumentError', () => {
    expect(() => validateTrustedUrl('http://www.douyin.com/video/7701962254330128228')).toThrow(
      ArgumentError
    );
  });

  it('rejects URLs with custom ports with ArgumentError', () => {
    expect(() =>
      validateTrustedUrl('https://www.douyin.com:8443/video/7701962254330128228')
    ).toThrow(ArgumentError);
  });

  it('rejects URLs with user credentials with ArgumentError', () => {
    expect(() =>
      validateTrustedUrl('https://user:pass@www.douyin.com/video/7701962254330128228')
    ).toThrow(ArgumentError);
  });

  it('rejects untrusted domains with ArgumentError before navigation', async () => {
    await expect(
      resolveTargetToId('https://evil-douyin.com/video/7701962254330128228')
    ).rejects.toThrow(ArgumentError);
  });

  it('follows v.douyin.com redirect hops to resolve the video ID', async () => {
    const targetId = '7701962254330128228';
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: `https://www.douyin.com/video/${targetId}`,
      }),
      body: { cancel: vi.fn(async () => {}) },
    });

    const result = await resolveTargetToId('https://v.douyin.com/xyz123/', {
      fetchFn: mockFetch,
    });
    expect(result.id).toBe(targetId);
  });

  it('rejects redirect to an untrusted domain with ArgumentError', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: 'https://attacker.example.com/exploit',
      }),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      resolveTargetToId('https://v.douyin.com/malicious/', {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(ArgumentError);
  });

  it('detects redirect loops and throws CommandExecutionError', async () => {
    const loopUrl = 'https://v.douyin.com/loop/';
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: loopUrl }),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      resolveTargetToId(loopUrl, { fetchFn: mockFetch })
    ).rejects.toThrow(CommandExecutionError);
  });

  it('enforces maximum redirect hop limit', async () => {
    let hop = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      hop += 1;
      return {
        status: 302,
        headers: new Headers({ location: `https://v.douyin.com/hop${hop}/` }),
        body: { cancel: vi.fn(async () => {}) },
      };
    });

    await expect(
      resolveTargetToId('https://v.douyin.com/hop0/', {
        fetchFn: mockFetch,
        maxHops: 3,
      })
    ).rejects.toThrow(CommandExecutionError);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

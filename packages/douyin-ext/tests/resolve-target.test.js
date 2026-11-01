import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  extractVideoId,
  resolveTargetToId,
  validateTrustedUrl,
} from '../src/resolve-target.js';

describe('douyin-ext resolve-target (URL security and ID resolution)', () => {
  // Test intent: Validate that official 16-20 digit numeric IDs are recognized immediately
  // without unnecessary network or URL roundtrips.
  it('accepts raw numeric video IDs directly', async () => {
    const rawId = '7701962254330128228';
    const result = await resolveTargetToId(rawId);
    expect(result.id).toBe(rawId);
  });

  // Test intent: Verify that valid official Douyin video URLs with path IDs are extracted.
  it('extracts ID from official www.douyin.com/video/<id> and iesdouyin URLs', async () => {
    const id = '7701962254330128228';
    expect(extractVideoId(`https://www.douyin.com/video/${id}`)).toBe(id);
    expect(extractVideoId(`https://douyin.com/video/${id}/`)).toBe(id);
    expect(extractVideoId(`https://www.iesdouyin.com/share/video/${id}/`)).toBe(id);
    expect(extractVideoId(`https://www.douyin.com/discover?modal_id=${id}`)).toBe(id);
  });

  // Test intent: Reject non-HTTPS protocols to prevent unencrypted requests or protocol smuggling.
  it('rejects non-HTTPS URLs with ArgumentError', () => {
    expect(() => validateTrustedUrl('http://www.douyin.com/video/7701962254330128228')).toThrow(
      ArgumentError
    );
    expect(() => validateTrustedUrl('ftp://www.douyin.com/video/7701962254330128228')).toThrow(
      ArgumentError
    );
  });

  // Test intent: Reject custom ports to avoid port-scanning and intranet pivoting.
  it('rejects URLs with custom ports with ArgumentError', () => {
    expect(() =>
      validateTrustedUrl('https://www.douyin.com:8443/video/7701962254330128228')
    ).toThrow(ArgumentError);
  });

  // Test intent: Reject user credentials embedded in URLs to prevent credential leakage.
  it('rejects URLs with user credentials with ArgumentError', () => {
    expect(() =>
      validateTrustedUrl('https://user:pass@www.douyin.com/video/7701962254330128228')
    ).toThrow(ArgumentError);
  });

  // Test intent: Reject untrusted external domains prior to any network navigation.
  it('rejects untrusted domains with ArgumentError before navigation', async () => {
    await expect(
      resolveTargetToId('https://evil-douyin.com/video/7701962254330128228')
    ).rejects.toThrow(ArgumentError);
  });

  // Test intent: Verify that valid short share links on v.douyin.com are followed step-by-step
  // and resolve to the target video ID.
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
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Test intent: Verify that redirecting to an untrusted domain throws ArgumentError
  // before navigation occurs.
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

  // Test intent: Verify redirect loop detection throws CommandExecutionError.
  it('detects redirect loops and throws CommandExecutionError', async () => {
    const loopUrl = 'https://v.douyin.com/loop/';
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: loopUrl,
      }),
      body: { cancel: vi.fn(async () => {}) },
    });

    await expect(
      resolveTargetToId(loopUrl, {
        fetchFn: mockFetch,
      })
    ).rejects.toThrow(CommandExecutionError);
  });

  // Test intent: Ensure hop limit guards against endless redirect chains.
  it('enforces maximum redirect hop limit', async () => {
    let hop = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      hop += 1;
      return {
        status: 302,
        headers: new Headers({
          location: `https://v.douyin.com/hop${hop}/`,
        }),
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

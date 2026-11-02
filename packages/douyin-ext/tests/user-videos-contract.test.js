import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  normalizeUserVideosArgs,
  validateCursor,
  validateUserVideosTarget,
} from '../src/user-videos-contract.js';

describe('douyin-ext user-videos contract & argument validation', () => {
  const validSecUid = 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU';

  // Test intent: Verify valid direct sec_uid is accepted as-is without mutation.
  it('accepts valid direct sec_uid matching prefix pattern', () => {
    const result = validateUserVideosTarget(validSecUid);
    expect(result).toBe(validSecUid);
  });

  // Test intent: Verify valid official Douyin user HTTPS URLs extract the sec_uid correctly.
  it('extracts sec_uid from official douyin.com and www.douyin.com user URLs', () => {
    const url1 = `https://www.douyin.com/user/${validSecUid}`;
    const url2 = `https://douyin.com/user/${validSecUid}/`;
    expect(validateUserVideosTarget(url1)).toBe(validSecUid);
    expect(validateUserVideosTarget(url2)).toBe(validSecUid);
  });

  // Test intent: Reject non-HTTPS protocols to prevent insecure cleartext credential leaks.
  it('rejects non-HTTPS user URLs', () => {
    const httpUrl = `http://www.douyin.com/user/${validSecUid}`;
    expect(() => validateUserVideosTarget(httpUrl)).toThrow(ArgumentError);
  });

  // Test intent: Reject custom ports to avoid unexpected SSRF or port-scan targets.
  it('rejects URLs with non-standard ports', () => {
    const portUrl = `https://www.douyin.com:8443/user/${validSecUid}`;
    expect(() => validateUserVideosTarget(portUrl)).toThrow(ArgumentError);
  });

  // Test intent: Reject URLs containing embedded userinfo credentials.
  it('rejects URLs with username or password credentials', () => {
    const authUrl = `https://admin:secret@www.douyin.com/user/${validSecUid}`;
    expect(() => validateUserVideosTarget(authUrl)).toThrow(ArgumentError);
  });

  // Test intent: Reject untrusted third-party hosts claiming to be Douyin.
  it('rejects untrusted domains outside douyin.com / www.douyin.com', () => {
    const untrustedUrl = `https://evil.com/user/${validSecUid}`;
    expect(() => validateUserVideosTarget(untrustedUrl)).toThrow(ArgumentError);
  });

  // Test intent: Reject malformed user URL paths not pointing to /user/<sec_uid>.
  it('rejects invalid URL paths', () => {
    const badPathUrl = `https://www.douyin.com/video/${validSecUid}`;
    expect(() => validateUserVideosTarget(badPathUrl)).toThrow(ArgumentError);
  });

  // Test intent: Reject invalid sec_uid format that does not match prefix requirement.
  it('rejects arbitrary strings not matching sec_uid prefix requirement', () => {
    expect(() => validateUserVideosTarget('ordinaryNickname')).toThrow(ArgumentError);
    expect(() => validateUserVideosTarget('123456789012345')).toThrow(ArgumentError);
  });

  // Test intent: Ensure cursor is preserved as an exact digits-string without rounding or truncation.
  it('accepts and preserves arbitrary-length digit string cursors without numeric truncation', () => {
    const cursor = '1789453816000';
    expect(validateCursor(cursor)).toBe(cursor);
    expect(validateCursor(null)).toBe('0');
    expect(validateCursor(undefined)).toBe('0');
  });

  // Test intent: Reject non-numeric characters, negative numbers, or decimal fractions in cursor.
  it('rejects non-numeric characters, negative numbers, or decimals in cursor', () => {
    expect(() => validateCursor('1234a')).toThrow(ArgumentError);
    expect(() => validateCursor('-1')).toThrow(ArgumentError);
    expect(() => validateCursor('12.34')).toThrow(ArgumentError);
  });

  // Test intent: Validate count boundaries (1..20) and defaults.
  it('validates count within 1..20 and defaults to 20', () => {
    const defaultArgs = normalizeUserVideosArgs({ target: validSecUid });
    expect(defaultArgs.count).toBe(20);

    const minArgs = normalizeUserVideosArgs({ target: validSecUid, count: 1 });
    expect(minArgs.count).toBe(1);

    const maxArgs = normalizeUserVideosArgs({ target: validSecUid, count: 20 });
    expect(maxArgs.count).toBe(20);

    expect(() => normalizeUserVideosArgs({ target: validSecUid, count: 0 })).toThrow(
      ArgumentError
    );
    expect(() => normalizeUserVideosArgs({ target: validSecUid, count: 21 })).toThrow(
      ArgumentError
    );
    expect(() => normalizeUserVideosArgs({ target: validSecUid, count: 'invalid' })).toThrow(
      ArgumentError
    );
  });

  // Test intent: Validate comment-limit boundaries (0..10) and default 0.
  it('validates comment-limit within 0..10 and defaults to 0', () => {
    const defaultArgs = normalizeUserVideosArgs({ target: validSecUid });
    expect(defaultArgs.commentLimit).toBe(0);

    const activeArgs = normalizeUserVideosArgs({
      target: validSecUid,
      'comment-limit': 5,
    });
    expect(activeArgs.commentLimit).toBe(5);

    const camelArgs = normalizeUserVideosArgs({
      target: validSecUid,
      commentLimit: 10,
    });
    expect(camelArgs.commentLimit).toBe(10);

    expect(() =>
      normalizeUserVideosArgs({ target: validSecUid, 'comment-limit': -1 })
    ).toThrow(ArgumentError);
    expect(() =>
      normalizeUserVideosArgs({ target: validSecUid, 'comment-limit': 11 })
    ).toThrow(ArgumentError);
  });

  // Test intent: Validate timeout boundaries (1..600) and default 60.
  it('validates timeout within 1..600 and defaults to 60 seconds', () => {
    const defaultArgs = normalizeUserVideosArgs({ target: validSecUid });
    expect(defaultArgs.timeoutSeconds).toBe(60);
    expect(defaultArgs.timeoutMs).toBe(60000);

    const customArgs = normalizeUserVideosArgs({ target: validSecUid, timeout: 120 });
    expect(customArgs.timeoutSeconds).toBe(120);

    expect(() => normalizeUserVideosArgs({ target: validSecUid, timeout: 0 })).toThrow(
      ArgumentError
    );
    expect(() => normalizeUserVideosArgs({ target: validSecUid, timeout: 601 })).toThrow(
      ArgumentError
    );
  });
});

import { describe, expect, it } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  compareVariants,
  extractVideoVariants,
  isAudioOnlyStream,
  isDashStream,
  isTrustedCdnUrl,
  orderUrls,
  selectVideoVariant,
} from '../src/video-selector.js';

describe('douyin-ext video-selector (MP4 vs DASH, qualities, CDN ordering)', () => {
  const validCdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/test1.mp4';
  const playRedirectUrl = 'https://www.douyin.com/aweme/v1/play/?video_id=test1';

  // Test intent: Validate trusted CDN detection and reject untrusted or malformed URLs.
  it('correctly classifies trusted Douyin CDN URLs', () => {
    expect(isTrustedCdnUrl(validCdnUrl)).toBe(true);
    expect(isTrustedCdnUrl(playRedirectUrl)).toBe(true);
    expect(isTrustedCdnUrl('https://v1-dy.douyinvod.com/video/test.mp4')).toBe(true);
    expect(isTrustedCdnUrl('http://v26-web.douyinvod.com/video/test.mp4')).toBe(false); // HTTP rejected
    expect(isTrustedCdnUrl('https://evil-site.com/video.mp4')).toBe(false); // Untrusted host rejected
    expect(isTrustedCdnUrl('https://v26-web.douyinvod.com:8080/video.mp4')).toBe(false); // Custom port rejected
  });

  // Test intent: Verify URL ordering keeps original order for CDN endpoints but places /aweme/v1/play at the end.
  it('preserves direct CDN order and moves /aweme/v1/play redirects to fallback positions', () => {
    const mixed = [
      playRedirectUrl,
      'https://v1-dy.douyinvod.com/video/first.mp4',
      'https://v26-web.douyinvod.com/video/second.mp4',
    ];
    const ordered = orderUrls(mixed);
    expect(ordered).toEqual([
      'https://v1-dy.douyinvod.com/video/first.mp4',
      'https://v26-web.douyinvod.com/video/second.mp4',
      playRedirectUrl,
    ]);
  });

  // Test intent: Verify accurate detection and rejection of DASH stream variants.
  it('identifies and excludes DASH streams from bit_rate list', () => {
    expect(isDashStream({ format: 'dash' })).toBe(true);
    expect(isDashStream({ video_extra: JSON.stringify({ format: 'dash' }) })).toBe(true);
    expect(isDashStream({ gear_name: 'normal_1080_dash' })).toBe(true);
    expect(
      isDashStream({
        play_addr: { url_list: ['https://v26-web.douyinvod.com/dash/stream.mpd'] },
      })
    ).toBe(true);

    expect(isDashStream({ format: 'mp4', gear_name: 'normal_1080_0' })).toBe(false);
  });

  // Test intent: Identify and exclude audio-only streams lacking video frames.
  it('identifies and excludes audio-only streams', () => {
    expect(
      isAudioOnlyStream({
        width: 0,
        height: 0,
        audio_quality: 1,
      })
    ).toBe(true);

    expect(
      isAudioOnlyStream({
        width: 1080,
        height: 1920,
      })
    ).toBe(false);
  });

  // Test intent: Ensure compareVariants sorts by resolution desc, bitrate desc,
  // and uses H264 preference as tie-breaker without fabricating metadata.
  it('sorts variants by resolution, bitrate, and H264 compatibility tie-breaker', () => {
    const v720 = { resolution: 720, bitrate: 2000000, codec: 'h264' };
    const v1080_low = { resolution: 1080, bitrate: 1500000, codec: 'h264' };
    const v1080_high = { resolution: 1080, bitrate: 3000000, codec: 'h264' };
    const v1080_h265 = { resolution: 1080, bitrate: 3000000, codec: 'h265' };

    // 1080p beats 720p
    expect(compareVariants(v1080_low, v720)).toBeLessThan(0);
    // Higher bitrate beats lower bitrate at same resolution
    expect(compareVariants(v1080_high, v1080_low)).toBeLessThan(0);
    // H264 preferred over H265 at identical resolution and bitrate
    expect(compareVariants(v1080_high, v1080_h265)).toBeLessThan(0);
  });

  // Test intent: Verify selection of 'best' quality correctly picks highest resolution/bitrate
  // from an unsorted bit_rate array.
  it('selects the best MP4 variant from an unsorted bit_rate array', () => {
    const video = {
      bit_rate: [
        {
          width: 540,
          height: 960,
          bit_rate: 800000,
          gear_name: 'normal_540_0',
          play_addr: { url_list: [validCdnUrl] },
        },
        {
          width: 1080,
          height: 1920,
          bit_rate: 3500000,
          gear_name: 'normal_1080_0',
          is_h265: 0,
          play_addr: { url_list: [validCdnUrl] },
        },
        {
          width: 720,
          height: 1280,
          bit_rate: 1800000,
          gear_name: 'normal_720_0',
          play_addr: { url_list: [validCdnUrl] },
        },
        {
          // DASH stream to be ignored
          width: 1080,
          height: 1920,
          bit_rate: 9999999,
          format: 'dash',
          play_addr: { url_list: [validCdnUrl] },
        },
      ],
    };

    const best = selectVideoVariant(video, 'best');
    expect(best.quality).toBe('1080p');
    expect(best.bitrate).toBe(3500000);
    expect(best.codec).toBe('h264');
  });

  // Test intent: Verify explicit quality selection returns exact matching quality.
  it('selects explicitly requested quality when available', () => {
    const video = {
      bit_rate: [
        {
          width: 1080,
          height: 1920,
          bit_rate: 3500000,
          gear_name: 'normal_1080_0',
          play_addr: { url_list: [validCdnUrl] },
        },
        {
          width: 720,
          height: 1280,
          bit_rate: 1800000,
          gear_name: 'normal_720_0',
          play_addr: { url_list: [validCdnUrl] },
        },
      ],
    };

    const selected = selectVideoVariant(video, '720p');
    expect(selected.quality).toBe('720p');
    expect(selected.bitrate).toBe(1800000);
  });

  // Test intent: Verify requested quality that is missing throws ArgumentError
  // and lists available qualities instead of silently degrading.
  it('throws ArgumentError without silent degradation when requested quality is missing', () => {
    const video = {
      bit_rate: [
        {
          width: 720,
          height: 1280,
          bit_rate: 1800000,
          gear_name: 'normal_720_0',
          play_addr: { url_list: [validCdnUrl] },
        },
      ],
    };

    expect(() => selectVideoVariant(video, '1080p')).toThrow(ArgumentError);
    expect(() => selectVideoVariant(video, '1080p')).toThrow(/Available qualities: 720p/);
  });

  // Test intent: Throw CommandExecutionError when no valid MP4 streams exist.
  it('throws CommandExecutionError when no suitable MP4 variants exist', () => {
    const video = {
      bit_rate: [
        {
          format: 'dash',
          play_addr: { url_list: ['https://v26-web.douyinvod.com/dash/1.mpd'] },
        },
      ],
    };

    expect(() => selectVideoVariant(video, 'best')).toThrow(CommandExecutionError);
  });
});

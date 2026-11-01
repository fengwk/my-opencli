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

describe('douyin-ext video-selector (nested dims, 2160p, codec, direct dash, allowlist)', () => {
  const validCdnUrl = 'https://v26-web.douyinvod.com/video/tos-cn-v/test1.mp4';
  const playRedirectUrl = 'https://www.douyin.com/aweme/v1/play/?video_id=test1';

  it('strictly validates CDN allowlist (*.douyinvod.com and www.douyin.com/aweme/v1/play/ only)', () => {
    expect(isTrustedCdnUrl(validCdnUrl)).toBe(true);
    expect(isTrustedCdnUrl(playRedirectUrl)).toBe(true);
    expect(isTrustedCdnUrl('https://v1-dy.douyinvod.com/video/test.mp4')).toBe(true);

    // Reject arbitrary paths on douyin.com
    expect(isTrustedCdnUrl('https://www.douyin.com/video/arbitrary_path.mp4')).toBe(false);
    expect(isTrustedCdnUrl('https://other.douyin.com/video/test.mp4')).toBe(false);

    // Reject unverified external CDN domains
    expect(isTrustedCdnUrl('https://aweme.amemv.com/video/test.mp4')).toBe(false);
    expect(isTrustedCdnUrl('https://v3-xigua.ixigua.com/video/test.mp4')).toBe(false);
    expect(isTrustedCdnUrl('https://evil-site.com/video.mp4')).toBe(false);
  });

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

  // Defect check: nested dims must come from item.play_addr.width/height, NOT video.width/height
  it('correctly uses item.play_addr dimensions instead of fallback video dimensions', () => {
    const video = {
      width: 1080,
      height: 1920,
      bit_rate: [
        {
          bit_rate: 800000,
          gear_name: 'normal_540_0',
          play_addr: {
            width: 540,
            height: 960,
            url_list: [validCdnUrl],
          },
        },
      ],
    };

    const variants = extractVideoVariants(video);
    expect(variants).toHaveLength(1);
    expect(variants[0].quality).toBe('540p');
    expect(variants[0].resolution).toBe(540);
  });

  // Defect check: support 2160p (4K) and ensure best prioritizes higher resolution
  it('supports 2160p and prioritizes it over 1080p when selecting best quality', () => {
    const video = {
      bit_rate: [
        {
          bit_rate: 4000000,
          gear_name: 'normal_1080_0',
          play_addr: { width: 1080, height: 1920, url_list: [validCdnUrl] },
        },
        {
          bit_rate: 10000000,
          gear_name: 'normal_2160_0',
          definition: '4k',
          play_addr: { width: 2160, height: 3840, url_list: [validCdnUrl] },
        },
      ],
    };

    const best = selectVideoVariant(video, 'best');
    expect(best.quality).toBe('2160p');
    expect(best.resolution).toBe(2160);
  });

  // Defect check: deriveCodec must mark unknown instead of fabricating h264
  it('marks codec as unknown when no evidence for h264 or h265 exists', () => {
    const video = {
      bit_rate: [
        {
          bit_rate: 1500000,
          gear_name: 'video_stream_default',
          play_addr: { width: 720, height: 1280, url_list: [validCdnUrl] },
        },
      ],
    };

    const variants = extractVideoVariants(video);
    expect(variants).toHaveLength(1);
    expect(variants[0].codec).toBe('unknown');
  });

  // Defect check: direct play_addr must filter DASH streams and not reintroduce known DASH URLs
  it('filters direct DASH play_addr and does not re-add DASH streams', () => {
    const dashUrl = 'https://v26-web.douyinvod.com/dash/video.mpd';
    const video = {
      bit_rate: [
        {
          format: 'dash',
          play_addr: { url_list: [dashUrl] },
        },
      ],
      play_addr: {
        format: 'dash',
        url_list: [dashUrl],
      },
    };

    expect(() => selectVideoVariant(video, 'best')).toThrow(CommandExecutionError);
  });

  it('throws ArgumentError without silent degradation when requested quality is missing', () => {
    const video = {
      bit_rate: [
        {
          gear_name: 'normal_720_0',
          play_addr: { width: 720, height: 1280, url_list: [validCdnUrl] },
        },
      ],
    };

    expect(() => selectVideoVariant(video, '1080p')).toThrow(ArgumentError);
    expect(() => selectVideoVariant(video, '1080p')).toThrow(/Available qualities: 720p/);
  });
});

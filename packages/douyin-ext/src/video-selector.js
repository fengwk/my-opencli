import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

export const TRUSTED_CDN_SUFFIXES = [
  'douyinvod.com',
  'douyin.com',
  'amemv.com',
  'bytevcloud.com',
  'ibytedtos.com',
  'ixigua.com',
];

/**
 * Check whether a URL points to an authorized Douyin CDN or playback endpoint.
 * Strict HTTPS, standard port, no userinfo credentials.
 */
export function isTrustedCdnUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.port) return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  return TRUSTED_CDN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

/**
 * Check whether a URL is a www.douyin.com/aweme/v1/play/ redirect endpoint.
 */
export function isPlayRedirectUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.includes('douyin.com') && url.pathname.includes('/aweme/v1/play');
  } catch {
    return false;
  }
}

/**
 * Preserve the original order of URLs in url_list, but place /aweme/v1/play redirect
 * endpoints after direct CDN endpoints.
 */
export function orderUrls(urlList) {
  if (!Array.isArray(urlList)) return [];
  const trusted = urlList.filter(isTrustedCdnUrl);
  const direct = trusted.filter((u) => !isPlayRedirectUrl(u));
  const playRedirects = trusted.filter((u) => isPlayRedirectUrl(u));
  return [...direct, ...playRedirects];
}

/**
 * Parse video_extra JSON string safely.
 */
function parseVideoExtra(extra) {
  if (!extra) return {};
  if (typeof extra === 'object') return extra;
  try {
    return JSON.parse(extra);
  } catch {
    return {};
  }
}

/**
 * Check if a candidate item is a DASH stream.
 */
export function isDashStream(item) {
  if (!item || typeof item !== 'object') return false;

  if (item.format === 'dash') return true;
  if (item.is_dash === true || item.is_dash === 1) return true;

  const extra = parseVideoExtra(item.video_extra);
  if (extra.format && String(extra.format).toLowerCase() === 'dash') return true;
  if (extra.is_dash === true || extra.is_dash === 1) return true;

  const gear = String(item.gear_name ?? '').toLowerCase();
  if (gear.includes('dash')) return true;

  // Check URL signatures
  const urls = item.play_addr?.url_list ?? [];
  if (urls.some((u) => typeof u === 'string' && (u.includes('.mpd') || u.includes('/dash/')))) {
    return true;
  }

  return false;
}

/**
 * Check if an item is audio-only (no video picture track).
 */
export function isAudioOnlyStream(item) {
  if (!item || typeof item !== 'object') return false;
  const width = Number(item.width ?? 0);
  const height = Number(item.height ?? 0);
  if (width === 0 && height === 0 && (item.audio_quality != null || item.audio_type != null)) {
    return true;
  }
  return false;
}

/**
 * Normalize resolution label and numeric short dimension.
 */
function deriveQualityLabel(minDim, gearName) {
  const gear = String(gearName ?? '').toLowerCase();
  if (gear.includes('1080') || minDim >= 1080) return '1080p';
  if (gear.includes('720') || minDim >= 720) return '720p';
  if (gear.includes('540') || minDim >= 540) return '540p';
  if (gear.includes('480') || minDim >= 480) return '480p';
  if (gear.includes('360') || minDim >= 360) return '360p';
  return minDim > 0 ? `${minDim}p` : 'default';
}

/**
 * Extract codec information without fabricating metadata.
 */
function deriveCodec(item, fallbackName) {
  if (item?.is_h265 === 1 || item?.is_h265 === true) return 'h265';
  const gear = String(item?.gear_name || fallbackName || '').toLowerCase();
  if (gear.includes('265') || gear.includes('hevc')) return 'h265';
  if (gear.includes('264') || gear.includes('avc')) return 'h264';
  if (item?.is_h265 === 0) return 'h264';
  return 'h264'; // Default conventional MP4 video codec
}

/**
 * Build a structured variant descriptor.
 */
function createVariant({ item, urls, width, height, fallbackName = '' }) {
  const w = Number(width ?? item?.width ?? 0);
  const h = Number(height ?? item?.height ?? 0);
  const minDim = Math.min(w, h);
  const quality = deriveQualityLabel(minDim, item?.gear_name || fallbackName);
  const bitrate = Number(item?.bit_rate ?? item?.bitrate ?? 0);
  const codec = deriveCodec(item, fallbackName);

  return {
    quality,
    resolution: minDim,
    bitrate,
    codec,
    urls,
    gear_name: item?.gear_name || fallbackName || quality,
  };
}

/**
 * Comparator for video variants:
 * 1. Higher resolution first
 * 2. Higher bitrate first
 * 3. H264 preference as tie-breaker for identical resolution/bitrate
 */
export function compareVariants(a, b) {
  if (b.resolution !== a.resolution) {
    return b.resolution - a.resolution;
  }
  if (b.bitrate !== a.bitrate) {
    return b.bitrate - a.bitrate;
  }
  if (a.codec !== b.codec) {
    if (a.codec === 'h264') return -1;
    if (b.codec === 'h264') return 1;
  }
  return 0;
}

/**
 * Extract all valid, non-dash, merged MP4 video variants from the video object.
 */
export function extractVideoVariants(video) {
  if (!video || typeof video !== 'object') return [];

  const variants = [];

  // Source A: video.bit_rate array
  if (Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
    for (const item of video.bit_rate) {
      if (!item || typeof item !== 'object') continue;
      if (isDashStream(item)) continue;
      if (isAudioOnlyStream(item)) continue;

      const rawUrls =
        item.play_addr?.url_list ??
        item.play_addr_h264?.url_list ??
        item.play_addr_265?.url_list ??
        [];
      const urls = orderUrls(rawUrls);
      if (urls.length === 0) continue;

      variants.push(
        createVariant({
          item,
          urls,
          width: item.width || video.width,
          height: item.height || video.height,
        })
      );
    }
  }

  // Source B: Direct play_addr entries as fallback or supplement
  const directEntries = [
    { key: 'play_addr_h264', obj: video.play_addr_h264, defaultCodec: 'h264' },
    { key: 'play_addr_265', obj: video.play_addr_265, defaultCodec: 'h265' },
    { key: 'play_addr', obj: video.play_addr, defaultCodec: 'h264' },
  ];

  for (const { key, obj, defaultCodec } of directEntries) {
    if (!obj || typeof obj !== 'object') continue;
    const urls = orderUrls(obj.url_list);
    if (urls.length === 0) continue;

    // Check if this URL list is already captured in variants
    const alreadyCaptured = variants.some((v) =>
      v.urls.some((u) => urls.includes(u))
    );
    if (!alreadyCaptured) {
      variants.push(
        createVariant({
          item: {
            ...obj,
            is_h265: defaultCodec === 'h265' ? 1 : 0,
            gear_name: obj.gear_name || key,
          },
          urls,
          width: obj.width || video.width,
          height: obj.height || video.height,
          fallbackName: key,
        })
      );
    }
  }

  return variants;
}

/**
 * Select the best matching video variant according to the requested quality.
 *
 * If requested quality is not 'best' and not available, explicitly throws ArgumentError.
 * Never silently downgrades quality.
 */
export function selectVideoVariant(video, requestedQuality = 'best') {
  const variants = extractVideoVariants(video);
  if (variants.length === 0) {
    throw new CommandExecutionError('No suitable MP4 video streams found in Douyin detail');
  }

  const quality = String(requestedQuality || 'best').trim().toLowerCase();

  if (quality === 'best') {
    // Sort all variants by resolution desc, bitrate desc, h264 preference
    const sorted = [...variants].sort(compareVariants);
    return sorted[0];
  }

  // Exact quality filter (e.g. '1080p', '720p')
  const matching = variants.filter((v) => v.quality.toLowerCase() === quality);
  if (matching.length === 0) {
    const availableQualities = Array.from(new Set(variants.map((v) => v.quality)));
    throw new ArgumentError(
      `Requested quality "${requestedQuality}" is not available. Available qualities: ${availableQualities.join(', ') || 'none'}`
    );
  }

  const sortedMatching = [...matching].sort(compareVariants);
  return sortedMatching[0];
}

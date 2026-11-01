import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const PLAY_REDIRECT_PATH_RE = /^\/aweme\/v1\/play(?:\/|$)/;

/**
 * Check whether a URL points to verified Douyin video CDNs:
 * 1. *.douyinvod.com
 * 2. www.douyin.com strictly under ^/aweme/v1/play/
 */
export function isTrustedCdnUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // Rule 1: Verified douyinvod CDN
  if (hostname === 'douyinvod.com' || hostname.endsWith('.douyinvod.com')) {
    return true;
  }

  // Rule 2: www.douyin.com strictly on the play endpoint
  if (hostname === 'www.douyin.com' && PLAY_REDIRECT_PATH_RE.test(url.pathname)) {
    return true;
  }

  return false;
}

export function isPlayRedirectUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname === 'www.douyin.com' && PLAY_REDIRECT_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Preserve the original order of CDN URLs but place /aweme/v1/play redirects after direct CDNs.
 */
export function orderUrls(urlList) {
  if (!Array.isArray(urlList)) return [];
  const trusted = urlList.filter(isTrustedCdnUrl);
  const direct = trusted.filter((u) => !isPlayRedirectUrl(u));
  const playRedirects = trusted.filter((u) => isPlayRedirectUrl(u));
  return [...direct, ...playRedirects];
}

function parseVideoExtra(extra) {
  if (!extra) return {};
  if (typeof extra === 'object') return extra;
  try {
    return JSON.parse(extra);
  } catch {
    return {};
  }
}

export function isDashStream(item) {
  if (!item || typeof item !== 'object') return false;

  if (item.format === 'dash' || item.is_dash === true || item.is_dash === 1) return true;

  const extra = parseVideoExtra(item.video_extra);
  if (extra.format && String(extra.format).toLowerCase() === 'dash') return true;
  if (extra.is_dash === true || extra.is_dash === 1) return true;

  const gear = String(item.gear_name ?? '').toLowerCase();
  if (gear.includes('dash')) return true;

  const urls = [
    ...(item.play_addr?.url_list ?? []),
    ...(item.url_list ?? []),
  ];
  if (urls.some((u) => typeof u === 'string' && (u.includes('.mpd') || u.includes('/dash/')))) {
    return true;
  }

  return false;
}

export function isAudioOnlyStream(item) {
  if (!item || typeof item !== 'object') return false;
  const w = Number(item.play_addr?.width ?? item.width ?? 0);
  const h = Number(item.play_addr?.height ?? item.height ?? 0);
  if (w === 0 && h === 0 && (item.audio_quality != null || item.audio_type != null)) {
    return true;
  }
  return false;
}

/**
 * Determine resolution label and numeric dimension value.
 * Strictly prioritizes explicit definition / gear tags before falling back to physical dimensions.
 */
function deriveResolution(minDim, gearName, definition, extraDefinition) {
  const text = `${definition || ''} ${extraDefinition || ''} ${gearName || ''}`.toLowerCase();

  // Priority 1: Explicit definition / gear tag
  if (text.includes('2160') || text.includes('4k')) {
    return { quality: '2160p', resolution: 2160 };
  }
  if (text.includes('1440') || text.includes('2k')) {
    return { quality: '1440p', resolution: 1440 };
  }
  if (text.includes('1080')) {
    return { quality: '1080p', resolution: 1080 };
  }
  if (text.includes('720')) {
    return { quality: '720p', resolution: 720 };
  }
  if (text.includes('540')) {
    return { quality: '540p', resolution: 540 };
  }
  if (text.includes('480')) {
    return { quality: '480p', resolution: 480 };
  }
  if (text.includes('360')) {
    return { quality: '360p', resolution: 360 };
  }

  // Priority 2: Fallback to physical dimensions
  if (minDim >= 2160) return { quality: '2160p', resolution: 2160 };
  if (minDim >= 1440) return { quality: '1440p', resolution: 1440 };
  if (minDim >= 1080) return { quality: '1080p', resolution: 1080 };
  if (minDim >= 720) return { quality: '720p', resolution: 720 };
  if (minDim >= 540) return { quality: '540p', resolution: 540 };
  if (minDim >= 480) return { quality: '480p', resolution: 480 };
  if (minDim >= 360) return { quality: '360p', resolution: 360 };

  return {
    quality: minDim > 0 ? `${minDim}p` : 'unknown',
    resolution: minDim > 0 ? minDim : 0,
  };
}

/**
 * Derive codec strictly from evidence without fabricating h264.
 */
function deriveCodec(item, fallbackName, extra) {
  const extraCodec = String(
    extra?.codec || extra?.video_codec || extra?.codec_type || item?.codec_type || ''
  ).toLowerCase();
  const gear = String(item?.gear_name || fallbackName || '').toLowerCase();

  if (
    item?.is_h265 === 1 ||
    item?.is_h265 === true ||
    gear.includes('265') ||
    gear.includes('hevc') ||
    extraCodec.includes('265') ||
    extraCodec.includes('hevc')
  ) {
    return 'h265';
  }

  if (
    fallbackName === 'play_addr_h264' ||
    item?.is_h265 === 0 ||
    gear.includes('264') ||
    gear.includes('avc') ||
    extraCodec.includes('264') ||
    extraCodec.includes('avc')
  ) {
    return 'h264';
  }

  return 'unknown';
}

function createVariant({ item, urls, width, height, fallbackName = '' }) {
  const extra = parseVideoExtra(item?.video_extra);
  const minDim = Math.min(Number(width || 0), Number(height || 0));
  const { quality, resolution } = deriveResolution(
    minDim,
    item?.gear_name || fallbackName,
    item?.definition,
    extra?.definition
  );
  const bitrate = Number(item?.bit_rate ?? item?.bitrate ?? 0);
  const codec = deriveCodec(item, fallbackName, extra);

  return {
    quality,
    resolution,
    bitrate,
    codec,
    urls,
    gear_name: item?.gear_name || fallbackName || quality,
  };
}

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
    if (a.codec === 'h265' && b.codec === 'unknown') return -1;
    if (b.codec === 'h265' && a.codec === 'unknown') return 1;
  }
  return 0;
}

export function extractVideoVariants(video) {
  if (!video || typeof video !== 'object') return [];

  const variants = [];
  const knownDashUrls = new Set();

  // Pass 1: Collect DASH URLs to prevent them from being reintroduced via direct keys
  const collectDashUrls = (list) => {
    if (Array.isArray(list)) {
      for (const u of list) {
        if (typeof u === 'string') knownDashUrls.add(u);
      }
    }
  };

  if (Array.isArray(video.bit_rate)) {
    for (const item of video.bit_rate) {
      if (isDashStream(item)) {
        collectDashUrls(item.play_addr?.url_list);
        collectDashUrls(item.play_addr_h264?.url_list);
        collectDashUrls(item.play_addr_265?.url_list);
      }
    }
  }

  // Pass 2: Extract from video.bit_rate
  if (Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
    for (const item of video.bit_rate) {
      if (!item || typeof item !== 'object') continue;
      if (isDashStream(item) || isAudioOnlyStream(item)) continue;

      const rawUrls =
        item.play_addr?.url_list ??
        item.play_addr_h264?.url_list ??
        item.play_addr_265?.url_list ??
        [];
      const urls = orderUrls(rawUrls);
      if (urls.length === 0) continue;

      // Crucial: dimensions must come from item.play_addr width/height, not video.width/height
      const itemW =
        item.play_addr?.width ??
        item.play_addr_h264?.width ??
        item.play_addr_265?.width ??
        item.width ??
        0;
      const itemH =
        item.play_addr?.height ??
        item.play_addr_h264?.height ??
        item.play_addr_265?.height ??
        item.height ??
        0;

      variants.push(
        createVariant({
          item,
          urls,
          width: itemW,
          height: itemH,
        })
      );
    }
  }

  // Pass 3: Direct play_addr entries (only if not DASH, not audio, and URLs not known DASH)
  const directEntries = [
    { key: 'play_addr_h264', obj: video.play_addr_h264 },
    { key: 'play_addr_265', obj: video.play_addr_265 },
    { key: 'play_addr', obj: video.play_addr },
  ];

  for (const { key, obj } of directEntries) {
    if (!obj || typeof obj !== 'object') continue;
    if (isDashStream(obj) || isAudioOnlyStream(obj)) continue;

    const rawUrls = obj.url_list ?? [];
    if (rawUrls.some((u) => knownDashUrls.has(u))) continue;

    const urls = orderUrls(rawUrls);
    if (urls.length === 0) continue;

    const alreadyCaptured = variants.some((v) =>
      v.urls.some((u) => urls.includes(u))
    );
    if (!alreadyCaptured) {
      variants.push(
        createVariant({
          item: obj,
          urls,
          width: obj.width || video.width || 0,
          height: obj.height || video.height || 0,
          fallbackName: key,
        })
      );
    }
  }

  return variants;
}

export function selectVideoVariant(video, requestedQuality = 'best') {
  const variants = extractVideoVariants(video);
  if (variants.length === 0) {
    throw new CommandExecutionError('No suitable MP4 video streams found in Douyin detail');
  }

  const quality = String(requestedQuality || 'best').trim().toLowerCase();

  if (quality === 'best') {
    const sorted = [...variants].sort(compareVariants);
    return sorted[0];
  }

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

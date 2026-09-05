/**
 * Google Gemini StreamGenerate / batchexecute parser.
 *
 * Observed 2026-09-05 on gemini.google.com/app:
 *   POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   body:
 *     )]}'\n
 *     <byteCount>\n
 *     [["wrb.fr",null,"<json payload>"]]\n
 *     ...
 *     [["e", ...]]
 *
 * Text lives at payload[4][i][1][0] (longest non-URL string wins).
 * Conversation id lives at payload[1][0] as `c_<urlId>`.
 * Generated image URLs are nested strings (googleusercontent / image_generation_content).
 */

export const STREAM_GENERATE_PATH = 'assistant.lamda.BardFrontendService/StreamGenerate';

const PROTOCOL_CID_RE = /^c_[A-Za-z0-9_-]{8,}$/;

export function isStreamGenerateUrl(url) {
  const value = String(url || '');
  return value.includes('StreamGenerate') && (
    value.includes('BardFrontendService')
    || value.includes('BardChatUi')
    || value.includes('gemini.google.com')
  );
}

export function decodeCaptureBody(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.responsePreview ?? entry.body ?? entry.responseBody ?? '';
  if (raw == null) return '';
  const text = String(raw);
  if (text.startsWith('base64:')) {
    try {
      return Buffer.from(text.slice(7), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return text;
}

export function parseBatchexecuteBody(body) {
  const cleaned = String(body || '').replace(/^\)\]\}'\s*/, '');
  if (!cleaned.trim()) return [];
  const lines = cleaned.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || !parsed[0] || !Array.isArray(parsed[0])) continue;
    const inner = parsed[0];
    if (inner[0] !== 'wrb.fr') continue;
    let payload = inner[2];
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(payload)) continue;
    out.push({
      rpc: inner[1] ?? null,
      payload,
      finished: isFinishedPayload(payload),
    });
  }
  return out;
}

export function isFinishedPayload(payload) {
  try {
    const candidates = payload?.[4];
    if (!Array.isArray(candidates)) return false;
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const flag = candidate[8];
      if (Array.isArray(flag) && flag[0] === 2) return true;
      if (candidate[5] === true) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function longestPlainText(node, depth, best) {
  if (depth > 6 || node == null) return best;
  if (typeof node === 'string') {
    const value = node.trim();
    if (
      value.length > best.length
      && value.length > 1
      && !isLikelyGeneratedImageUrl(value)
      && !isHttpUrl(value)
    ) {
      return value;
    }
    return best;
  }
  if (Array.isArray(node)) {
    for (const item of node) best = longestPlainText(item, depth + 1, best);
  }
  return best;
}

export function extractTextFromPayload(payload) {
  let best = '';
  try {
    const candidates = payload?.[4];
    if (!Array.isArray(candidates)) return '';
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      if (Array.isArray(candidate[1]) && typeof candidate[1][0] === 'string') {
        const value = candidate[1][0];
        if (!isLikelyGeneratedImageUrl(value) && !isHttpUrl(value) && value.length > best.length) {
          best = value;
        }
      } else {
        best = longestPlainText(candidate[1], 0, best);
      }
    }
  } catch {
    // ignore
  }
  return best;
}

export function extractConversationIdFromPayload(payload) {
  try {
    const cid = payload?.[1]?.[0];
    if (typeof cid === 'string' && PROTOCOL_CID_RE.test(cid)) return cid;
  } catch {
    // ignore
  }
  return '';
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

export function isLikelyGeneratedImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return false;
  if (/^blob:/i.test(url) && /gemini\.google\.com/i.test(url)) return true;
  if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('fonts.gstatic.com')) return false;
  if (lower.includes('/lamda/images/gemini_sparkle')) return false;
  if (/googleusercontent\.com\/a\//i.test(url)) return false;
  if (/[?&=]s(?:64|32|96)\b/i.test(url) && /googleusercontent\.com/i.test(url)) return false;
  if (lower.includes('image_generation_content')) return true;
  if (/\.(?:png|jpe?g|webp|gif)(?:$|\?)/i.test(url) && /googleusercontent\.com|ggpht\.com|google\.com/i.test(url)) {
    return true;
  }
  if (/lh\d+\.googleusercontent\.com\//i.test(url) && !/\/a\//.test(url)) {
    return !/w96-h96|s64-c|s32-c|s96-c/i.test(url);
  }
  return false;
}

export function normalizeGeneratedImageUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (/^http:\/\/(?:[^/]+\.)?googleusercontent\.com\//i.test(url)) {
    url = `https://${url.slice('http://'.length)}`;
  }
  return url;
}

export function isImageGenerationPlaceholderUrl(value) {
  const url = normalizeGeneratedImageUrl(value);
  return /^https:\/\/googleusercontent\.com\/image_generation_content(?:\/|$)/i.test(url);
}

export function extractImagesFromPayload(payload) {
  const urls = [];
  const seen = new Set();
  function walk(node, depth) {
    if (depth > 10 || node == null) return;
    if (typeof node === 'string') {
      const url = normalizeGeneratedImageUrl(node);
      if (isLikelyGeneratedImageUrl(url) && !seen.has(url)) {
        seen.add(url);
        urls.push({ url });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  }
  walk(payload, 0);
  const concrete = urls.filter((item) => !isImageGenerationPlaceholderUrl(item.url));
  return concrete.length > 0 ? concrete : urls;
}

export function extractSourcesFromPayload(payload) {
  const sources = [];
  const seen = new Set();
  function walk(node, depth) {
    if (depth > 10 || node == null) return;
    if (typeof node === 'string') {
      if (!/^https?:\/\//i.test(node)) return;
      if (isLikelyGeneratedImageUrl(node)) return;
      if (/googleusercontent\.com|gstatic\.com|google-analytics\.com|gemini\.google\.com|accounts\.google\.com/i.test(node)) {
        return;
      }
      if (seen.has(node)) return;
      seen.add(node);
      sources.push({ title: '', url: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  }
  walk(payload, 0);
  return sources;
}

export function extractToolFlagsFromBody(body) {
  const text = String(body || '');
  const flags = [];
  if (/"image_gen"|image_generation_content|IMAGE_GENERATION/i.test(text)) flags.push('image_gen');
  if (/"google_search"|"web_search"/i.test(text)) flags.push('search');
  return flags;
}

export function summarizeStreamBody(body) {
  const chunks = parseBatchexecuteBody(body);
  let text = '';
  let conversationId = '';
  const images = [];
  const sources = [];
  let finished = false;
  const seenImages = new Set();
  const seenSources = new Set();
  for (const chunk of chunks) {
    const chunkText = extractTextFromPayload(chunk.payload);
    if (chunkText.length > text.length) text = chunkText;
    if (!conversationId) conversationId = extractConversationIdFromPayload(chunk.payload);
    if (chunk.finished) finished = true;
    for (const image of extractImagesFromPayload(chunk.payload)) {
      if (seenImages.has(image.url)) continue;
      seenImages.add(image.url);
      images.push(image);
    }
    for (const source of extractSourcesFromPayload(chunk.payload)) {
      if (seenSources.has(source.url)) continue;
      seenSources.add(source.url);
      sources.push(source);
    }
  }
  return {
    text,
    conversationId,
    images,
    sources,
    finished,
    chunkCount: chunks.length,
    toolFlags: extractToolFlagsFromBody(body),
  };
}

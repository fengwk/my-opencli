import { isBlank, isNotBlank } from './strings.js';

const MEDIA_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.tif', '.tiff', '.ico',
  '.mp4', '.mov', '.mkv', '.webm',
  '.mp3', '.wav', '.flac', '.m4a',
  '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.csv', '.txt', '.json', '.xml',
  '.zip', '.gz', '.tar', '.tgz', '.rar', '.7z',
];
const MEDIA_EXTENSIONS_BY_LENGTH = [...MEDIA_EXTENSIONS].sort((left, right) => right.length - left.length);
const EXTENSION_BY_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['image/bmp', '.bmp'],
  ['image/avif', '.avif'],
  ['image/tiff', '.tiff'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/x-matroska', '.mkv'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/flac', '.flac'],
  ['audio/mp4', '.m4a'],
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['text/csv', '.csv'],
  ['text/plain', '.txt'],
  ['application/json', '.json'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['application/gzip', '.gz'],
  ['application/x-gzip', '.gz'],
  ['application/x-tar', '.tar'],
  ['application/x-compressed-tar', '.tgz'],
  ['application/x-7z-compressed', '.7z'],
  ['application/vnd.rar', '.rar'],
  ['application/x-rar-compressed', '.rar'],
]);

export function resolveMime(headers) {
  const contentType = findHeader(headers, 'content-type');
  if (isBlank(contentType)) return 'application/octet-stream';
  const normalized = contentType.trim().toLowerCase();
  const semicolonIndex = normalized.indexOf(';');
  const mime = semicolonIndex >= 0 ? normalized.slice(0, semicolonIndex).trim() : normalized;
  return isBlank(mime) ? 'application/octet-stream' : mime;
}

export function findHeader(headers, name) {
  if (!headers || isBlank(name)) return '';
  if (headers instanceof Map) {
    for (const [key, value] of headers.entries()) {
      if (name.toLowerCase() === String(key).toLowerCase()) return value == null ? '' : String(value);
    }
    return '';
  }
  for (const [key, value] of Object.entries(headers)) {
    if (name.toLowerCase() === key.toLowerCase()) return value == null ? '' : String(value);
  }
  return '';
}

export function isDirectMediaResponse(mime, contentDisposition, url) {
  const resolvedMime = isBlank(mime)
    ? 'application/octet-stream'
    : String(mime).split(';')[0].trim().toLowerCase();
  if (resolvedMime === 'text/html' || resolvedMime === 'application/xhtml+xml') {
    return false;
  }
  if (isNotBlank(contentDisposition) && contentDisposition.toLowerCase().includes('attachment')) {
    return true;
  }
  if (
    resolvedMime.startsWith('image/')
    || resolvedMime.startsWith('video/')
    || resolvedMime.startsWith('audio/')
  ) {
    return true;
  }
  if (isTextualDocumentMime(resolvedMime)) {
    return false;
  }
  if (
    hasMediaLikeFileExtension(url)
    || hasMediaLikeFileName(resolveFileNameFromContentDisposition(contentDisposition))
  ) {
    return true;
  }
  if (resolvedMime === 'application/octet-stream') {
    return false;
  }
  return resolvedMime === 'application/pdf'
    || isKnownBinaryDocumentMime(resolvedMime);
}

export function hasMediaLikeFileExtension(url) {
  return hasMediaLikeFileName(extractFileName(url));
}

export function hasMediaLikeFileName(fileName) {
  const lowerFileName = extractFileName(fileName).toLowerCase();
  if (isBlank(lowerFileName)) return false;
  return MEDIA_EXTENSIONS.some((ext) => lowerFileName.endsWith(ext));
}

export function resolveSuggestedFileName(contentDisposition, url) {
  const fileName = resolveFileNameFromContentDisposition(contentDisposition);
  if (isNotBlank(fileName)) return fileName;
  return extractFileName(url);
}

export function resolveFileNameFromContentDisposition(contentDisposition) {
  if (isBlank(contentDisposition)) return '';
  const segments = contentDisposition.split(';');
  for (const segment of segments) {
    const trimmed = segment == null ? '' : segment.trim();
    if (trimmed.toLowerCase().startsWith('filename*=')) {
      const decoded = decodeExtendedFileName(unquote(trimmed.slice(10).trim()));
      if (isNotBlank(decoded)) return extractFileName(decoded);
    }
  }
  for (const segment of segments) {
    const trimmed = segment == null ? '' : segment.trim();
    if (trimmed.toLowerCase().startsWith('filename=')) {
      return extractFileName(unquote(trimmed.slice(9).trim()));
    }
  }
  return '';
}

export function extractFileName(value) {
  if (isBlank(value)) return '';
  let normalizedValue = value.trim();
  const fragmentIndex = normalizedValue.indexOf('#');
  if (fragmentIndex >= 0) normalizedValue = normalizedValue.slice(0, fragmentIndex);
  const queryIndex = normalizedValue.indexOf('?');
  if (queryIndex >= 0) normalizedValue = normalizedValue.slice(0, queryIndex);
  normalizedValue = normalizedValue.replace(/\\/g, '/');
  const slashIndex = normalizedValue.lastIndexOf('/');
  if (slashIndex >= 0) normalizedValue = normalizedValue.slice(slashIndex + 1);
  return normalizedValue.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function isHtmlDocumentBytes(body) {
  if (!body || body.length === 0) return false;
  const preview = Buffer.from(body.subarray(0, Math.min(body.length, 512))).toString('utf8').trim().toLowerCase();
  return preview.startsWith('<!doctype html')
    || preview.startsWith('<html')
    || preview.includes('<html')
    || preview.includes('<head')
    || preview.includes('<body');
}

export function guessExtension(mime, fileName) {
  const lower = extractFileName(fileName).toLowerCase();
  const knownExtension = MEDIA_EXTENSIONS_BY_LENGTH.find((extension) => lower.endsWith(extension));
  if (knownExtension) return knownExtension;
  const resolvedMime = String(mime || '').split(';')[0].trim().toLowerCase();
  const exactExtension = EXTENSION_BY_MIME.get(resolvedMime);
  if (exactExtension) return exactExtension;
  if (resolvedMime.includes('png')) return '.png';
  if (resolvedMime.includes('jpeg') || resolvedMime.includes('jpg')) return '.jpg';
  if (resolvedMime.includes('gif')) return '.gif';
  if (resolvedMime.includes('webp')) return '.webp';
  if (resolvedMime.includes('svg')) return '.svg';
  if (resolvedMime.includes('pdf')) return '.pdf';
  if (resolvedMime.includes('mp4')) return '.mp4';
  if (resolvedMime.includes('mp3')) return '.mp3';
  if (resolvedMime.includes('zip')) return '.zip';
  if (resolvedMime.includes('gzip')) return '.gz';
  if (resolvedMime.includes('tar')) return '.tar';
  if (resolvedMime.includes('csv')) return '.csv';
  if (resolvedMime.includes('json')) return '.json';
  if (resolvedMime.includes('xml')) return '.xml';
  return '.bin';
}

function isTextualDocumentMime(mime) {
  return mime.startsWith('text/')
    || mime === 'application/json'
    || mime.endsWith('+json')
    || mime === 'application/xml'
    || mime.endsWith('+xml')
    || mime === 'application/javascript'
    || mime === 'application/ecmascript'
    || mime === 'application/x-www-form-urlencoded';
}

function isKnownBinaryDocumentMime(mime) {
  return mime === 'application/zip'
    || mime === 'application/x-zip-compressed'
    || mime === 'application/gzip'
    || mime === 'application/x-gzip'
    || mime === 'application/x-tar'
    || mime === 'application/x-7z-compressed'
    || mime === 'application/vnd.rar'
    || mime === 'application/x-rar-compressed'
    || mime === 'application/msword'
    || mime.startsWith('application/vnd.ms-')
    || mime.startsWith('application/vnd.openxmlformats-officedocument.');
}

function decodeExtendedFileName(value) {
  if (isBlank(value)) return '';
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote < 0 ? -1 : value.indexOf("'", firstQuote + 1);
  if (firstQuote <= 0 || secondQuote < 0) {
    return decodePercentEncoded(value, 'utf-8');
  }
  const charset = value.slice(0, firstQuote).trim() || 'utf-8';
  const encodedFileName = value.slice(secondQuote + 1);
  return decodePercentEncoded(encodedFileName, charset);
}

function decodePercentEncoded(value, charset) {
  try {
    const bytes = [];
    for (let index = 0; index < value.length;) {
      const encodedByte = value.slice(index).match(/^%([0-9a-f]{2})/i);
      if (encodedByte) {
        bytes.push(Number.parseInt(encodedByte[1], 16));
        index += 3;
        continue;
      }
      const codePoint = value.codePointAt(index);
      const character = String.fromCodePoint(codePoint);
      bytes.push(...new TextEncoder().encode(character));
      index += character.length;
    }
    return new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(bytes));
  } catch {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
}

function unquote(value) {
  if (isBlank(value)) return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

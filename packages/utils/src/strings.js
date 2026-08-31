export function isBlank(value) {
  return value == null || String(value).trim() === '';
}

export function isNotBlank(value) {
  return !isBlank(value);
}

export function normalizedTextLength(value) {
  if (isBlank(value)) return 0;
  return String(value).replace(/\s+/g, ' ').trim().length;
}

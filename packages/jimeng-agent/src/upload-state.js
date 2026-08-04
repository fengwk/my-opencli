/**
 * Pure upload-state helpers for jimeng-agent.
 *
 * The browser probe (agent-dom.js) returns raw DOM facts as plain data
 * (class-name arrays, style attributes, element flags) and these helpers
 * derive the stable signals:
 *
 * - reference strip presence / card count
 * - per-card identity and processing state
 * - busy-text detection
 *
 * Keeping this logic pure makes the upload-wait and cleanup decisions
 * unit-testable without a browser.
 */

/**
 * True when a class list marks the reference strip container of the composer
 * dock (Jimeng renders it as `references-<hash>`; the hash changes per build
 * but the `references-` prefix is stable).
 */
export function isReferenceStripClasses(classList) {
  return Array.from(classList || []).some((name) => /^references-[A-Za-z0-9_-]+$/.test(name));
}

/**
 * Classify one reference element class token:
 * - 'card'    → an actual reference card item (`reference-item-<hash>`)
 * - 'content' → the card's content wrapper (`reference-item-content-<hash>`)
 * - null      → unrelated
 */
export function classifyReferenceItemClass(name) {
  if (!name || typeof name !== 'string') return null;
  if (/^reference-item-content-[A-Za-z0-9_-]+$/.test(name)) return 'content';
  if (/^reference-item-[A-Za-z0-9_-]+$/.test(name)) return 'card';
  return null;
}

/**
 * Count cards from a plain list of strip-descendant summaries. Each summary
 * is `{ classes: string[], ... }`. Only elements that carry a 'card' token
 * count; 'content' wrappers are ignored so each card counts exactly once.
 * History-message chips are excluded because callers only pass descendants
 * of the dock strip.
 */
export function countStripCards(descendants) {
  if (!Array.isArray(descendants)) return 0;
  let count = 0;
  for (const entry of descendants) {
    const classes = entry?.classes || [];
    let isCard = false;
    for (const name of classes) {
      const kind = classifyReferenceItemClass(name);
      if (kind === 'card') {
        isCard = true;
        break;
      }
      if (kind === 'content') {
        isCard = false;
        break;
      }
    }
    if (isCard) count += 1;
  }
  return count;
}

/**
 * Parse `--reference-count: N` from a reference group style attribute.
 * Returns null when the variable is absent or malformed.
 */
export function parseReferenceCountStyle(styleAttr) {
  if (!styleAttr || typeof styleAttr !== 'string') return null;
  const match = styleAttr.match(/--reference-count\s*:\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * True when a card summary is still processing an upload / re-index (Jimeng
 * overlays a loading mask + spinner on cards that are not ready yet).
 */
export function isProcessingCard(entry) {
  return !!(entry && (entry.hasSpin === true || entry.hasMask === true));
}

/**
 * Stable per-card identity. Prefer the blob media source (stable per upload);
 * fall back to the data-index, then to a structural class signature.
 */
export function cardIdentity(entry) {
  if (!entry) return null;
  const mediaSrc = entry.mediaSrc || null;
  if (mediaSrc && /^blob:/i.test(mediaSrc)) return mediaSrc;
  const index = entry.dataIndex != null ? String(entry.dataIndex) : null;
  if (index !== null && index !== '') return `index:${index}`;
  const cls = Array.from(entry.classes || []).find((name) => /^reference-item-[A-Za-z0-9_-]+$/.test(name));
  return cls ? `cls:${cls}` : null;
}

/**
 * True when a card summary is an empty upload slot (`reference-upload-*` with
 * its own file input) instead of a real media card. Jimeng renders such slots
 * for draft references whose media is unavailable; they have no remove button
 * and cannot be cleared, but they also expose no asset to the mention picker.
 */
export function isUploadSlotEntry(entry) {
  return !!(entry && entry.hasUploadSlot === true);
}

/**
 * Decide whether a card observed after an upload is a NEW upload result.
 *
 * A card counts as new when:
 * - it is not an empty upload slot, and
 * - its identity is absent from the pre-upload baseline, or
 * - its identity was a baseline slot that got filled in place.
 *
 * The in-place case matters for audio: audio cards carry no blob media source,
 * so filling a slot keeps the card identity (`index:N`) unchanged.
 */
export function isNewUploadCard(card, baselineIdentities, baselineSlotIdentities) {
  if (!card || !card.identity || isUploadSlotEntry(card)) return false;
  if (!baselineIdentities.has(card.identity)) return true;
  return baselineSlotIdentities.has(card.identity);
}

/**
 * True when the body text shows an active upload/processing state.
 */
export function hasUploadBusyText(bodyText) {
  return /上传中|处理中|识别中|分析中|解析中|准备中|uploading|processing|analy[sz]ing/i.test(
    String(bodyText || ''),
  );
}

/**
 * True when the text shows a hard upload failure (alert/error).
 */
export function hasUploadFailureText(bodyText) {
  return /上传失败|素材.*失败|解析失败|上传出错|upload.*fail|failed to upload/i.test(
    String(bodyText || ''),
  );
}

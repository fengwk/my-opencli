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
 * Jimeng collapses a long reference strip to the first and last visible
 * references and renders the last one through a "more" entry. The hidden
 * references still exist and remain available to the mention picker.
 */
export function hasCollapsedReferenceMore(cards) {
  return Array.isArray(cards) && cards.some((card) => card?.hasMoreEntry === true);
}

/**
 * Count media cards that are actually visible in the dock. A collapsed "more"
 * entry is intentionally included here; callers that need the logical total
 * can combine this count with hasCollapsedReferenceMore().
 */
export function countVisibleMediaReferences(cards) {
  if (!Array.isArray(cards)) return 0;
  return cards.filter((card) => !isUploadSlotEntry(card)).length;
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
 * Normalized visible text of a card summary (or of a raw text string).
 * Whitespace is collapsed because the same label can be re-rendered with
 * different line breaks while the card is updated in place.
 */
export function normalizeCardText(value) {
  const raw = typeof value === 'string' ? value : value?.text;
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * True when the visible card text carries the exact asset label.
 *
 * The upload alias keeps the label as the filename stem (e.g. `音频2.mp3`),
 * so the label may be followed by a file extension, but never by a digit:
 * `音频2` must not match the different label `音频20`.
 */
function cardTextShowsLabel(text, label) {
  const name = String(label || '').trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?:\\.[A-Za-z0-9]{1,8})?(?!\\d)`).test(String(text || ''));
}

/**
 * Fallback upload acknowledgement for a collapsed reference strip.
 *
 * A long strip is collapsed to a fixed set of visible cards and the visible
 * tail card is reused for the newly uploaded resource: its `data-index`
 * stays the same, and because audio cards carry no blob media source, its
 * whole identity stays the same while its visible text switches to the new
 * asset. Such an in-place update is only accepted when
 * - the strip is (or was) collapsed, and
 * - the identity already existed in the pre-upload baseline, and
 * - the visible text changed away from every pre-upload text of that
 *   identity, so an unchanged stale card is never accepted, and
 * - the new text carries the exact expected asset label.
 */
export function isCollapsedTailUploadCard(card, {
  baselineCards = [],
  collapsed = false,
  expectedLabel = '',
} = {}) {
  if (!collapsed) return false;
  if (!card || !card.identity || isUploadSlotEntry(card)) return false;
  const text = normalizeCardText(card);
  if (!text) return false;
  const baselineTexts = (baselineCards || [])
    .filter((entry) => entry?.identity === card.identity)
    .map((entry) => normalizeCardText(entry));
  if (baselineTexts.length === 0) return false;
  if (baselineTexts.includes(text)) return false;
  return cardTextShowsLabel(text, expectedLabel);
}

/**
 * Decide whether one polling snapshot of the reference strip acknowledges the
 * upload that was just fired.
 *
 * A candidate is a card accepted by {@link isNewUploadCard} (new identity, or
 * a baseline upload slot filled in place) or by the collapsed-strip fallback
 * {@link isCollapsedTailUploadCard}.
 *
 * `confirmed` is the fail-closed contract the upload wait relies on:
 * - exactly one candidate exists (a duplicate would shift @图片N numbering);
 * - the candidate is neither processing (spinner/mask) nor showing busy text;
 * - the same candidate fingerprints were already observed in the previous
 *   poll. The fingerprint includes the visible text for a collapsed tail
 *   update, which keeps its identity while its text changes.
 */
export function evaluateUploadPoll(cards, {
  baselineCards = [],
  collapsed = false,
  expectedLabel = '',
  previousKeys = null,
} = {}) {
  const baselineIdentities = new Set(
    (baselineCards || []).filter((card) => card?.identity).map((card) => card.identity),
  );
  const baselineSlotIdentities = new Set(
    (baselineCards || [])
      .filter((card) => isUploadSlotEntry(card) && card.identity)
      .map((card) => card.identity),
  );
  const candidates = [];
  const keys = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const fresh = isNewUploadCard(card, baselineIdentities, baselineSlotIdentities);
    const tailUpdate = !fresh && isCollapsedTailUploadCard(card, {
      baselineCards,
      collapsed,
      expectedLabel,
    });
    if (!fresh && !tailUpdate) continue;
    candidates.push(card);
    keys.add(tailUpdate ? `${card.identity}|${normalizeCardText(card)}` : card.identity);
  }
  const ready = candidates.length > 0
    && !candidates.some((card) => isProcessingCard(card))
    && !hasUploadBusyText(candidates.map((card) => normalizeCardText(card)).join(' '));
  const single = candidates.length === 1;
  const sameSet = previousKeys !== null
    && previousKeys.size === keys.size
    && [...keys].every((key) => previousKeys.has(key));
  return {
    candidates,
    keys,
    ready,
    single,
    confirmed: ready && single && sameSet,
  };
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
 * True when the text shows a hard upload failure (alert/error), including
 * content-moderation rejections. Jimeng renders the rejected card with a
 * plain "未通过" badge and a toast such as "可能涉及与公众人物相似的肖像"
 * — the word "审核" is often absent, so 未通过/不通过 alone counts as a
 * failure (the normal page never shows those words).
 */
export function hasUploadFailureText(bodyText) {
  return /上传失败|素材.*失败|解析失败|上传出错|未通过|不通过|违规|敏感|拒绝.*(?:上传|素材)|upload.*fail|failed to upload|content.*review/i.test(
    String(bodyText || ''),
  );
}

/**
 * Observe failures attributable to the current upload.
 *
 * A pre-upload alert stays exempt only while the same marked DOM node remains
 * visible with unchanged text. Once absent, its id is retired permanently, so
 * a later same-text alert is treated as new.
 */
export function observeCurrentUploadFailure({
  cards = [],
  alerts = [],
  baselineAlerts = [],
  activeBaselineAlertIds = [],
} = {}) {
  const baselineTextById = new Map(
    baselineAlerts
      .map((alert) => [
        String(alert?.id || ''),
        String(alert?.text || '').replace(/\s+/g, ' ').trim(),
      ])
      .filter(([id]) => id),
  );
  const currentBaselineTextById = new Map(
    alerts
      .map((alert) => [
        String(alert?.baselineId || ''),
        String(alert?.text || '').replace(/\s+/g, ' ').trim(),
      ])
      .filter(([id]) => id),
  );
  const nextActiveBaselineAlertIds = Array.from(activeBaselineAlertIds || [])
    .map(String)
    .filter((id) => (
      currentBaselineTextById.has(id)
      && currentBaselineTextById.get(id) === baselineTextById.get(id)
    ));

  for (const card of cards || []) {
    const text = String(card?.text || '').replace(/\s+/g, ' ').trim();
    if (hasUploadFailureText(text)) {
      return { failureText: text, activeBaselineAlertIds: nextActiveBaselineAlertIds };
    }
  }

  const active = new Set(nextActiveBaselineAlertIds);
  for (const alert of alerts || []) {
    const text = String(alert?.text || '').replace(/\s+/g, ' ').trim();
    if (!hasUploadFailureText(text)) continue;
    const baselineId = String(alert?.baselineId || '');
    if (
      baselineId
      && active.has(baselineId)
      && baselineTextById.get(baselineId) === text
    ) {
      continue;
    }
    return { failureText: text, activeBaselineAlertIds: nextActiveBaselineAlertIds };
  }
  return { failureText: '', activeBaselineAlertIds: nextActiveBaselineAlertIds };
}

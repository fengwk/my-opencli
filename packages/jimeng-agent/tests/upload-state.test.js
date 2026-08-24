/**
 * Pure upload-state helper tests. No browser, no network.
 */
import { describe, expect, it } from 'vitest';

import {
  cardIdentity,
  classifyReferenceItemClass,
  countVisibleMediaReferences,
  countStripCards,
  hasCollapsedReferenceMore,
  hasUploadBusyText,
  hasUploadFailureText,
  isNewUploadCard,
  isProcessingCard,
  isReferenceStripClasses,
  isUploadSlotEntry,
  observeCurrentUploadFailure,
  parseReferenceCountStyle,
} from '../src/upload-state.js';

function descendant(classes, extra = {}) {
  return { classes, dataIndex: null, hasSpin: false, hasMask: false, mediaSrc: null, ...extra };
}

describe('jimeng-agent/upload-state — strip detection', () => {
  it('recognizes the hashed references-* strip class and rejects lookalikes', () => {
    expect(isReferenceStripClasses(['references-i0MvtH', 'references-ZgQwBU'])).toBe(true);
    expect(isReferenceStripClasses(['references-123'])).toBe(true);
    expect(isReferenceStripClasses(['reference-item-V8Tkbi'])).toBe(false);
    expect(isReferenceStripClasses([])).toBe(false);
    expect(isReferenceStripClasses(null)).toBe(false);
  });

  it('classifies reference item tokens without confusing content wrappers', () => {
    expect(classifyReferenceItemClass('reference-item-V8Tkbi')).toBe('card');
    expect(classifyReferenceItemClass('reference-item-content-I4Cci8')).toBe('content');
    expect(classifyReferenceItemClass('references-ZgQwBU')).toBe(null);
    expect(classifyReferenceItemClass('')).toBe(null);
    expect(classifyReferenceItemClass(null)).toBe(null);
  });
});

describe('jimeng-agent/upload-state — strip card counting', () => {
  it('counts each card once and ignores its content wrapper and the + add button', () => {
    const descendants = [
      descendant(['reference-group-Z0wA9a']),
      descendant(['reference-item-V8Tkbi'], { dataIndex: '0' }),
      descendant(['reference-item-content-I4Cci8']),
      descendant(['reference-item-V8Tkbi'], { dataIndex: '1' }),
      descendant(['reference-item-content-I4Cci8']),
      descendant(['reference-upload-eWIGta']),
    ];
    expect(countStripCards(descendants)).toBe(2);
  });

  it('counts zero when there are no card tokens', () => {
    expect(countStripCards([descendant(['references-ZgQwBU']), descendant(['reference-upload-eWIGta'])])).toBe(0);
    expect(countStripCards(null)).toBe(0);
    expect(countStripCards([])).toBe(0);
  });

  it('detects empty upload slots (kept as baseline) vs media cards', () => {
    expect(isUploadSlotEntry(descendant(['reference-item-V8Tkbi'], { hasUploadSlot: true }))).toBe(true);
    expect(isUploadSlotEntry(descendant(['reference-item-V8Tkbi'], { hasUploadSlot: false }))).toBe(false);
    expect(isUploadSlotEntry(null)).toBe(false);
  });

  it('recognizes collapsed more entries and counts visible media separately from the upload slot', () => {
    const cards = [
      descendant(['reference-item-V8Tkbi'], { hasMoreEntry: false }),
      descendant(['reference-item-V8Tkbi'], { hasMoreEntry: true }),
      descendant(['reference-item-V8Tkbi'], { hasUploadSlot: true }),
    ];
    expect(hasCollapsedReferenceMore(cards)).toBe(true);
    expect(countVisibleMediaReferences(cards)).toBe(2);
    expect(hasCollapsedReferenceMore(cards.slice(0, 1))).toBe(false);
    expect(countVisibleMediaReferences(null)).toBe(0);
  });

  it('parses the --reference-count style variable', () => {
    expect(parseReferenceCountStyle('--reference-count: 5; --rotate: 8deg')).toBe(5);
    expect(parseReferenceCountStyle('--reference-count:0')).toBe(0);
    expect(parseReferenceCountStyle('color: red')).toBe(null);
    expect(parseReferenceCountStyle(null)).toBe(null);
  });
});

describe('jimeng-agent/upload-state — card signals', () => {
  it('detects processing cards via the loading mask/spinner', () => {
    expect(isProcessingCard(descendant(['reference-item-V8Tkbi'], { hasSpin: true }))).toBe(true);
    expect(isProcessingCard(descendant(['reference-item-V8Tkbi'], { hasMask: true }))).toBe(true);
    expect(isProcessingCard(descendant(['reference-item-V8Tkbi']))).toBe(false);
    expect(isProcessingCard(null)).toBe(false);
  });

  it('uses the blob media source as the stable card identity', () => {
    expect(cardIdentity(descendant(['reference-item-V8Tkbi'], {
      dataIndex: '2',
      mediaSrc: 'blob:https://x/abc',
    }))).toBe('blob:https://x/abc');
  });

  it('falls back to data-index when no blob media source exists', () => {
    expect(cardIdentity(descendant(['reference-item-V8Tkbi'], { dataIndex: '3' }))).toBe('index:3');
  });

  it('falls back to the card class when neither exists, and null for empty input', () => {
    expect(cardIdentity(descendant(['reference-item-V8Tkbi']))).toBe('cls:reference-item-V8Tkbi');
    expect(cardIdentity(null)).toBe(null);
  });
});

describe('jimeng-agent/upload-state — new-card decision', () => {
  const mediaCard = (identity) => descendant(['reference-item-V8Tkbi'], { dataIndex: identity.replace('index:', ''), identity });
  const slotCard = (identity) => descendant(['reference-item-V8Tkbi'], { dataIndex: identity.replace('index:', ''), identity, hasUploadSlot: true });
  const baseline = new Set(['index:0', 'index:1', 'blob:https://x/a']);
  const baselineSlots = new Set(['index:0']);

  it('accepts identities absent from the baseline', () => {
    expect(isNewUploadCard(mediaCard('index:2'), baseline, baselineSlots)).toBe(true);
    expect(isNewUploadCard(mediaCard('blob:https://x/b'), baseline, baselineSlots)).toBe(true);
  });

  it('rejects baseline cards that are unchanged media cards', () => {
    expect(isNewUploadCard(mediaCard('index:1'), baseline, baselineSlots)).toBe(false);
    expect(isNewUploadCard(mediaCard('blob:https://x/a'), baseline, baselineSlots)).toBe(false);
  });

  it('accepts a baseline slot filled in place (audio card, identity unchanged)', () => {
    expect(isNewUploadCard(mediaCard('index:0'), baseline, baselineSlots)).toBe(true);
  });

  it('rejects empty slots, slot→slot and null input', () => {
    expect(isNewUploadCard(slotCard('index:2'), baseline, baselineSlots)).toBe(false);
    expect(isNewUploadCard(slotCard('index:0'), baseline, baselineSlots)).toBe(false);
    expect(isNewUploadCard(null, baseline, baselineSlots)).toBe(false);
    expect(isNewUploadCard(descendant(['reference-item-V8Tkbi']), baseline, baselineSlots)).toBe(false);
  });
});

describe('jimeng-agent/upload-state — busy and failure text', () => {
  it('detects active upload/processing text', () => {
    expect(hasUploadBusyText('正在上传中，请稍候')).toBe(true);
    expect(hasUploadBusyText('图片识别中')).toBe(true);
    expect(hasUploadBusyText('uploading asset')).toBe(true);
    expect(hasUploadBusyText('一切正常')).toBe(false);
  });

  it('detects hard upload failure text', () => {
    expect(hasUploadFailureText('上传失败，请重试')).toBe(true);
    expect(hasUploadFailureText('素材解析失败')).toBe(true);
    expect(hasUploadFailureText('upload failed')).toBe(true);
    expect(hasUploadFailureText('上传中')).toBe(false);
  });

  it('detects content-moderation rejections', () => {
    expect(hasUploadFailureText('图片审核未通过，请更换素材')).toBe(true);
    expect(hasUploadFailureText('素材未通过审核')).toBe(true);
    expect(hasUploadFailureText('内容违规，上传被拒绝')).toBe(true);
    expect(hasUploadFailureText('检测到敏感内容，无法使用')).toBe(true);
    expect(hasUploadFailureText('拒绝上传该素材')).toBe(true);
    // Jimeng's actual rejection UI: card badge "未通过" + toast without the
    // word 审核 ("可能涉及与公众人物相似的肖像").
    expect(hasUploadFailureText('未通过')).toBe(true);
    expect(hasUploadFailureText('该参考图可能涉及与公众人物相似的肖像，未通过审核')).toBe(true);
    // "审核通过" success messages must not count as failures.
    expect(hasUploadFailureText('素材审核通过')).toBe(false);
  });
});

describe('jimeng-agent/upload-state — current upload failure attribution', () => {
  it('accepts a failure badge on the current upload card', () => {
    expect(observeCurrentUploadFailure({
      cards: [{ text: '未通过' }],
    })).toMatchObject({ failureText: '未通过' });
  });

  it('ignores the same marked baseline alert while its text is unchanged', () => {
    expect(observeCurrentUploadFailure({
      alerts: [{ baselineId: 'old-1', text: '上传失败，请重试' }],
      baselineAlerts: [{ id: 'old-1', text: '上传失败，请重试' }],
      activeBaselineAlertIds: ['old-1'],
    })).toEqual({
      failureText: '',
      activeBaselineAlertIds: ['old-1'],
    });
  });

  it('accepts a new node or changed baseline node as a current failure', () => {
    const baselineAlerts = [{ id: 'old-1', text: '上传失败，请重试' }];
    expect(observeCurrentUploadFailure({
      alerts: [{ baselineId: '', text: '上传失败，请重试' }],
      baselineAlerts,
      activeBaselineAlertIds: ['old-1'],
    })).toMatchObject({ failureText: '上传失败，请重试' });
    expect(observeCurrentUploadFailure({
      alerts: [{ baselineId: 'old-1', text: '素材解析失败' }],
      baselineAlerts,
      activeBaselineAlertIds: ['old-1'],
    })).toMatchObject({ failureText: '素材解析失败' });
  });

  it('retires a disappeared baseline node so same-text reappearance is new', () => {
    const baselineAlerts = [{ id: 'old-1', text: '上传失败，请重试' }];
    const disappeared = observeCurrentUploadFailure({
      alerts: [],
      baselineAlerts,
      activeBaselineAlertIds: ['old-1'],
    });
    expect(disappeared).toEqual({
      failureText: '',
      activeBaselineAlertIds: [],
    });
    expect(observeCurrentUploadFailure({
      alerts: [{ baselineId: 'old-1', text: '上传失败，请重试' }],
      baselineAlerts,
      activeBaselineAlertIds: disappeared.activeBaselineAlertIds,
    })).toMatchObject({ failureText: '上传失败，请重试' });
  });

  it('retires a baseline node after any observed text change', () => {
    const baselineAlerts = [{ id: 'old-1', text: '上传失败，请重试' }];
    const changed = observeCurrentUploadFailure({
      alerts: [{ baselineId: 'old-1', text: '上传完成' }],
      baselineAlerts,
      activeBaselineAlertIds: ['old-1'],
    });
    expect(changed).toEqual({
      failureText: '',
      activeBaselineAlertIds: [],
    });
    expect(observeCurrentUploadFailure({
      alerts: [{ baselineId: 'old-1', text: '上传失败，请重试' }],
      baselineAlerts,
      activeBaselineAlertIds: changed.activeBaselineAlertIds,
    })).toMatchObject({ failureText: '上传失败，请重试' });
  });

  it('does not infer a failure from an unrelated ready card', () => {
    expect(observeCurrentUploadFailure({
      cards: [{ text: '图片1 已完成' }],
    })).toMatchObject({ failureText: '' });
  });
});

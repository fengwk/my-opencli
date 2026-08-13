import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import {
  classifyTaskStatus,
  normalizeStatusArgs,
  textMatchesSearchKey,
} from '../src/status-contract.js';
import {
  buildRecordMatch,
  buildRecordScanExpression,
  classifyDownloadLocateResult,
  classifyQuerySettleState,
  classifySearchResolution,
  extractAssetIdFromText,
  findExactDomMatch,
  findTaskRecords,
  isCurrentJimengRecordRootToken,
  isJimengTaskListReady,
  mergeExactSearchApiMetadata,
  parseSearchNetworkEntries,
  recordIdentityKey,
  runJimengStatus,
  scrollTaskList,
  selectExactDomMatch,
  selectReturnedMatches,
  toNodeLocalPath,
  waitForQuerySettled,
} from '../src/status-dom.js';
import { statusCommand } from '../status.js';

const statusDomSource = readFileSync(new URL('../src/status-dom.js', import.meta.url), 'utf8');

function createRecordScanHarness(records) {
  class HTMLElement {}

  const createElement = (record) => {
    const attrs = new Map(Object.entries(record.attributes || {}));
    const card = new HTMLElement();
    card.className = 'video-card-container-YvtXmd';
    card.getBoundingClientRect = () => ({ width: 300, height: 180 });

    const element = new HTMLElement();
    element.className = record.className;
    element.innerText = record.text;
    element.textContent = record.text;
    element.parentElement = null;
    element.matches = () => false;
    element.querySelector = (selector) => (
      selector.includes('video-card') || selector.includes('agentic-video')
        ? card
        : null
    );
    element.getAttribute = (name) => attrs.get(name) ?? null;
    element.setAttribute = (name, value) => attrs.set(name, value);
    element.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
    return element;
  };

  const elements = records.map(createElement);
  const historyRoot = new HTMLElement();
  historyRoot.className = 'record-list-container-PR5UbM';
  historyRoot.getBoundingClientRect = () => ({ width: 900, height: 700 });
  historyRoot.querySelectorAll = (selector) => (
    selector === '[class*="record-"]' ? elements : []
  );
  const input = new HTMLElement();
  input.className = 'lv-input';
  input.getBoundingClientRect = () => ({ width: 200, height: 32 });
  input.closest = () => historyRoot;
  const marker = 'scan-marker';
  const document = {
    querySelectorAll: (selector) => {
      if (selector === `[data-opencli-jimeng-search="${marker}"]`) return [input];
      if (selector === `[data-opencli-jimeng-history="${marker}"]`) return [historyRoot];
      return [];
    },
  };
  const window = {
    __opencliJimengRecordSeq: 0,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  return {
    run() {
      return Function(
        'document',
        'window',
        'HTMLElement',
        `return ${buildRecordScanExpression(marker)}`,
      )(document, window, HTMLElement);
    },
  };
}

function createSettlePage(states) {
  let index = 0;
  return {
    evaluate: async () => states[Math.min(index++, states.length - 1)],
    sleep: async () => {},
  };
}

function createStatusOrchestrationPage({ settleState, networkEntries }) {
  const page = {
    goto: vi.fn(async () => {}),
    sleep: vi.fn(async (seconds) => {
      vi.setSystemTime(Date.now() + seconds * 1000);
    }),
    nativeKeyPress: vi.fn(async () => {}),
    startNetworkCapture: vi.fn(async () => true),
    readNetworkCapture: vi.fn(async () => networkEntries),
    fillText: vi.fn(async (_selector, text) => ({
      verified: true,
      actual: text,
    })),
    cdp: vi.fn(async () => ({})),
    click: vi.fn(async () => ({ matches_n: 1 })),
    evaluate: vi.fn(async (expression) => {
      if (expression.includes('searchInputVisible') && expression.includes('recordListVisible')) {
        return {
          searchInputVisible: true,
          recordListVisible: true,
          skeletonVisible: false,
        };
      }
      if (expression.includes("historyRoot.setAttribute('data-opencli-jimeng-history'")) {
        return { ok: true };
      }
      if (expression.includes('const markedScope')) return settleState;
      if (expression.includes("const labels = ['关闭'")) return false;
      throw new Error(`Unexpected evaluate expression: ${expression.slice(0, 120)}`);
    }),
  };
  return page;
}

describe('jimeng-agent/status-contract', () => {
  it('normalizes search args with download defaulting to false', () => {
    const out = normalizeStatusArgs({
      workspace: '12505736104460',
      search_key: 'b7e4f19a2c0d5e68',
    });
    expect(out.workspace).toBe('12505736104460');
    expect(out.searchKey).toBe('b7e4f19a2c0d5e68');
    expect(out.download).toBe(false);
    expect(out.limit).toBe(1);
    expect(out.type).toBe('auto');
  });

  it('accepts download 1 and rejects invalid flags', () => {
    expect(normalizeStatusArgs({
      workspace: '1',
      search_key: 'abc',
      download: 1,
    }).download).toBe(true);
    expect(() => normalizeStatusArgs({
      workspace: '1',
      search_key: 'abc',
      download: 2,
    })).toThrow(ArgumentError);
  });

  it('classifies generating / cancelled / ready statuses from card text', () => {
    expect(classifyTaskStatus('认真思考中...')).toBe('generating');
    expect(classifyTaskStatus('排队加速中')).toBe('generating');
    expect(classifyTaskStatus('取消生成 积分已返还')).toBe('cancelled');
    expect(classifyTaskStatus('重新生成 下载')).toBe('ready');
  });

  it('matches search keys with punctuation/spacing differences', () => {
    expect(textMatchesSearchKey(
      '甚至来不及问，身体已经先一步照做，往左挪了半步；叶归年',
      '甚至来不及问,身体已经先一步照做,往左挪了半步;叶归年',
    )).toBe(true);
    expect(textMatchesSearchKey('资产编号：b7e4f19a2c0d5e68', 'b7e4f19a2c0d5e68')).toBe(true);
  });

  it('recognizes current hashed record roots without mistaking list/content wrappers', () => {
    expect(isCurrentJimengRecordRootToken('record-5JpNAj')).toBe(true);
    expect(isCurrentJimengRecordRootToken('record-a1B2c3')).toBe(true);
    expect(isCurrentJimengRecordRootToken('record-a_B-C')).toBe(true);
    expect(isCurrentJimengRecordRootToken('record-item')).toBe(false);
    expect(isCurrentJimengRecordRootToken('record-content')).toBe(false);
    expect(isCurrentJimengRecordRootToken('record-virtual-list')).toBe(false);
    expect(isCurrentJimengRecordRootToken('record-list-L6hAeF')).toBe(false);
    expect(isCurrentJimengRecordRootToken('record-list-container-PR5UbM')).toBe(false);
    expect(isCurrentJimengRecordRootToken('agentic-record-content-wYywAq')).toBe(false);
  });

  it('keeps shared CSS record classes separate with per-node locators and asset ids', () => {
    const scanned = createRecordScanHarness([
      {
        className: 'record-5JpNAj agentic-SFmZ8x',
        text: '资产编号：2a755b1ed916172a 已完成',
      },
      {
        className: 'record-5JpNAj agentic-SFmZ8x',
        text: '资产编号：6898f8ccda42a882 已完成',
      },
    ]).run();
    expect(scanned.ok).toBe(true);
    expect(scanned.items).toHaveLength(2);
    const matches = scanned.items.map(buildRecordMatch);
    expect(matches).toEqual([
      { dataId: '2a755b1ed916172a', locatorId: 'jm-1', identityKind: 'asset' },
      { dataId: '6898f8ccda42a882', locatorId: 'jm-2', identityKind: 'asset' },
    ]);
  });

  it('extracts only explicit asset ids instead of unrelated 16-hex text', () => {
    expect(extractAssetIdFromText('资产编号：2a755b1ed916172a')).toBe('2a755b1ed916172a');
    expect(extractAssetIdFromText('2a755b1ed916172a')).toBe('2a755b1ed916172a');
    expect(extractAssetIdFromText('URL token=2a755b1ed916172a')).toBe('');
    expect(buildRecordMatch({ seq: 7, text: 'no asset id' })).toMatchObject({
      dataId: expect.stringMatching(/^jm-synthetic-7-[0-9a-f]{8}$/),
      locatorId: 'jm-7',
    });
  });

  it('waits for the record list to have a search input and no feed skeleton', () => {
    expect(isJimengTaskListReady({
      searchInputVisible: true,
      recordListVisible: true,
      skeletonVisible: false,
    })).toBe(true);
    expect(isJimengTaskListReady({
      searchInputVisible: true,
      recordListVisible: true,
      skeletonVisible: true,
    })).toBe(false);
    expect(isJimengTaskListReady({
      searchInputVisible: true,
      recordListVisible: false,
      skeletonVisible: false,
    })).toBe(false);
  });

  it('classifies query settle states and requires two stable observations', async () => {
    expect(classifyQuerySettleState({
      query: 'abc',
      inputValue: 'abc',
      skeletonVisible: false,
      matchedRootCount: 1,
      emptyStateVisible: false,
    })).toBe('matched');
    expect(classifyQuerySettleState({
      query: 'abc',
      inputValue: 'abc',
      skeletonVisible: false,
      matchedRootCount: 0,
      emptyStateVisible: true,
    })).toBe('empty');
    expect(classifyQuerySettleState({
      query: 'abc',
      inputValue: 'old',
      skeletonVisible: false,
      matchedRootCount: 1,
      emptyStateVisible: false,
    })).toBe('pending');
    expect(classifyQuerySettleState({
      query: 'abc',
      inputValue: 'abc',
      scopeReady: false,
      skeletonVisible: false,
      matchedRootCount: 1,
      emptyStateVisible: false,
    })).toBe('pending');
    expect(classifyQuerySettleState({
      query: 'abc',
      inputValue: 'abc',
      skeletonVisible: false,
      matchedRootCount: 1,
      visibleRootCount: 1,
      emptyStateVisible: true,
    })).toBe('conflict');

    const matched = await waitForQuerySettled(createSettlePage([
      { inputValue: 'abc', skeletonVisible: false, texts: ['abc task'], emptyStateVisible: false },
      { inputValue: 'abc', skeletonVisible: false, texts: ['abc task'], emptyStateVisible: false },
    ]), {
      query: 'abc',
      marker: 'marker',
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(matched.kind).toBe('matched');

    const empty = await waitForQuerySettled(createSettlePage([
      { inputValue: 'abc', skeletonVisible: false, texts: [], emptyStateVisible: true },
      { inputValue: 'abc', skeletonVisible: false, texts: [], emptyStateVisible: true },
    ]), {
      query: 'abc',
      marker: 'marker',
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(empty.kind).toBe('empty');

    const timedOut = await waitForQuerySettled(createSettlePage([
      { inputValue: 'old', skeletonVisible: true, texts: [], emptyStateVisible: false },
    ]), {
      query: 'abc',
      marker: 'marker',
      timeoutMs: 5,
      pollIntervalMs: 1,
    });
    expect(timedOut.kind).toBe('timeout');
  });

  it('fails closed when download locator is missing, ambiguous, or no longer matches', () => {
    expect(classifyDownloadLocateResult({
      nodeCount: 0,
      text: '',
      searchKey: 'abc',
    })).toEqual({ ok: false, error: 'card-not-found' });
    expect(classifyDownloadLocateResult({
      nodeCount: 2,
      text: 'abc',
      searchKey: 'abc',
    })).toEqual({ ok: false, error: 'card-locator-ambiguous' });
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: 'other',
      searchKey: 'abc',
    })).toEqual({ ok: false, error: 'card-text-mismatch' });
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: '资产编号：2a755b1ed916172a',
      searchKey: '2a755b1ed916172a',
      dataId: '2a755b1ed916172a',
      identityKind: 'asset',
      expectedText: '资产编号：2a755b1ed916172a 已完成',
    })).toEqual({ ok: true });
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: '资产编号：6898f8ccda42a882',
      searchKey: '资产编号',
      dataId: '2a755b1ed916172a',
      identityKind: 'asset',
      expectedText: '资产编号：2a755b1ed916172a 已完成',
    })).toEqual({ ok: false, error: 'card-identity-mismatch' });
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: 'complete A extra',
      searchKey: 'complete',
      dataId: 'jm-synthetic-1-deadbeef',
      identityKind: 'synthetic',
      expectedText: 'complete A',
    })).toEqual({ ok: false, error: 'card-identity-mismatch' });
  });

  it('treats DOM query settle as authoritative over captured API rows', () => {
    expect(classifySearchResolution({ settleKind: 'matched', apiMatchCount: 1 }))
      .toEqual({ kind: 'matched' });
    expect(classifySearchResolution({ settleKind: 'timeout', apiMatchCount: 1 }))
      .toEqual({ kind: 'timeout' });
    expect(classifySearchResolution({ settleKind: 'empty', apiMatchCount: 0 }))
      .toEqual({ kind: 'not_found' });
    expect(classifySearchResolution({ settleKind: 'empty', apiMatchCount: 1 }))
      .toEqual({ kind: 'conflict' });
  });

  it('does not let captured API rows override a timed-out DOM query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    try {
      const page = createStatusOrchestrationPage({
        settleState: {
          scopeReady: true,
          inputValue: 'asset-key',
          skeletonVisible: false,
          texts: [],
          emptyStateVisible: false,
        },
        networkEntries: [{
          url: 'https://jimeng.jianying.com/mweb/search/v1/search',
          responseBody: {
            data: {
              item_list: [{ item_id: 'api-row', prompt: 'asset-key' }],
            },
          },
        }],
      });
      const canonical = normalizeStatusArgs({
        workspace: '1',
        search_key: 'asset-key',
      });
      await expect(runJimengStatus(page, canonical))
        .rejects.toThrow('JIMENG_STATUS_QUERY_WAIT_TIMEOUT');
      expect(page.fillText).toHaveBeenCalledOnce();
      expect(page.cdp).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when explicit DOM empty conflicts with captured API matches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    try {
      const page = createStatusOrchestrationPage({
        settleState: {
          scopeReady: true,
          inputValue: 'asset-key',
          skeletonVisible: false,
          texts: [],
          emptyStateVisible: true,
        },
        networkEntries: [{
          url: 'https://jimeng.jianying.com/mweb/search/v1/search',
          responseBody: {
            data: {
              item_list: [{ item_id: 'api-row', prompt: 'asset-key' }],
            },
          },
        }],
      });
      const canonical = normalizeStatusArgs({
        workspace: '1',
        search_key: 'asset-key',
      });
      await expect(runJimengStatus(page, canonical))
        .rejects.toThrow('JIMENG_STATUS_SEARCH_STATE_CONFLICT');
      expect(page.fillText).toHaveBeenCalledOnce();
      expect(page.cdp).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('correlates API rows to one exact DOM match and rejects ambiguity', () => {
    const first = {
      dataId: '2a755b1ed916172a',
      locatorId: 'jm-1',
      identityKind: 'asset',
      text: '资产编号：2a755b1ed916172a complete',
    };
    const second = {
      dataId: '6898f8ccda42a882',
      locatorId: 'jm-2',
      identityKind: 'asset',
      text: '资产编号：6898f8ccda42a882 complete',
    };
    expect(selectExactDomMatch(
      [first, second],
      { dataId: '2a755b1ed916172a', identityKind: 'asset', text: first.text },
      '2a755b1ed916172a',
    )).toBe(first);
    expect(selectExactDomMatch(
      [{ ...first, locatorId: 'jm-3' }, first],
      { dataId: '2a755b1ed916172a', identityKind: 'asset', text: first.text },
      '2a755b1ed916172a',
    )).toBeNull();
    expect(selectExactDomMatch(
      [first, second],
      { dataId: 'api-unrelated' },
      'complete',
    )).toBeNull();
    expect(selectExactDomMatch(
      [{ ...first, dataId: 'dom-only', text: 'complete B' }],
      { dataId: 'api-only', identityKind: 'business', text: 'complete A' },
      'complete',
    )).toBeNull();
    expect(selectExactDomMatch(
      [{
        dataId: 'business-b',
        locatorId: 'jm-b',
        identityKind: 'business',
        text: 'same full text',
      }],
      {
        dataId: 'business-a',
        identityKind: 'business',
        text: 'same full text',
      },
      'same full text',
    )).toBeNull();
  });

  it('merges API media only through an exact business or asset identity', () => {
    const dom = {
      dataId: '2a755b1ed916172a',
      identityKind: 'asset',
      text: '资产编号：2a755b1ed916172a 已完成',
    };
    const merged = mergeExactSearchApiMetadata([dom], [{
      dataId: 'api-task-id',
      text: '资产编号：2a755b1ed916172a',
      mediaUrl: 'https://example.com/exact.mp4',
    }]);
    expect(merged[0].mediaUrl).toBe('https://example.com/exact.mp4');

    const unrelated = mergeExactSearchApiMetadata([dom], [{
      dataId: 'api-other',
      text: 'generic matching prompt',
      mediaUrl: 'https://example.com/wrong.mp4',
    }]);
    expect(unrelated[0].mediaUrl).toBeUndefined();
  });

  it('keeps business and asset identities separate even when their ids are equal', () => {
    const shared = '2a755b1ed916172a';
    expect(recordIdentityKey({ identityKind: 'business', dataId: shared }))
      .not.toBe(recordIdentityKey({ identityKind: 'asset', dataId: shared }));

    const business = {
      dataId: shared,
      identityKind: 'business',
      text: `business ${shared}`,
    };
    const asset = {
      dataId: shared,
      locatorId: 'jm-asset',
      identityKind: 'asset',
      text: `资产编号：${shared}`,
    };
    expect(selectExactDomMatch([asset], business, shared)).toBeNull();
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: asset.text,
      searchKey: shared,
      dataId: shared,
      identityKind: 'business',
      dataIdAttr: '',
      expectedText: business.text,
    })).toEqual({ ok: false, error: 'card-identity-mismatch' });
    expect(classifyDownloadLocateResult({
      nodeCount: 1,
      text: 'same prompt fragment',
      searchKey: 'same prompt fragment',
      dataId: shared,
      identityKind: 'asset',
      dataIdAttr: shared,
      expectedText: `资产编号：${shared} same prompt fragment`,
    })).toEqual({ ok: false, error: 'card-identity-mismatch' });

    const businessDom = { ...business };
    const enriched = mergeExactSearchApiMetadata([businessDom], [{
      dataId: 'api-other',
      assetId: shared,
      text: `资产编号：${shared}`,
      mediaUrl: 'https://example.com/wrong.mp4',
    }]);
    expect(enriched[0].mediaUrl).toBeUndefined();
  });

  it('fails closed when the marked history scope disappears after partial pagination', async () => {
    let scanCount = 0;
    const page = {
      sleep: async () => {},
      evaluate: vi.fn(async (expression) => {
        if (expression.includes("const labels = ['关闭'")) return false;
        if (expression.includes('const prev = container.scrollTop')) return { kind: 'scrolled' };
        scanCount += 1;
        if (scanCount === 1) {
          return {
          ok: true,
          items: [{
            seq: 1,
            text: 'matching task 生成中',
            taskType: 'video',
            dataIdAttr: 'business-a',
            recordIdAttr: '',
            className: 'record-5JpNAj agentic-SFmZ8x',
          }],
          };
        }
        return { ok: false, reason: 'scope-lost', items: [] };
      }),
    };
    await expect(findTaskRecords(page, {
      searchKey: 'matching task',
      limit: 1,
      maxPages: 3,
      readyType: 'video',
      marker: 'marker',
    })).rejects.toThrow('JIMENG_STATUS_HISTORY_SCOPE_LOST');
  });

  it('treats a hidden marked history pair as scope-lost instead of end-of-list', async () => {
    const marker = 'marker';
    const input = {
      closest: () => root,
      getBoundingClientRect: () => ({ width: 200, height: 32 }),
    };
    const root = {
      querySelector: () => null,
      scrollHeight: 0,
      clientHeight: 0,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    const document = {
      querySelectorAll: (selector) => (
        selector.includes('jimeng-search') ? [input] : [root]
      ),
    };
    const window = {
      getComputedStyle: (el) => (
        el === root
          ? { display: 'none', visibility: 'hidden' }
          : { display: 'block', visibility: 'visible' }
      ),
    };
    const page = {
      evaluate: async (expression) => Function(
        'document',
        'window',
        'HTMLElement',
        `return ${expression}`,
      )(document, window, Object),
    };
    await expect(scrollTaskList(page, { marker })).resolves.toEqual({ kind: 'scope-lost' });
  });

  it('continues past same-text wrong business id to the exact later-page primary', async () => {
    const makeScanned = (dataIdAttr, seq) => ({
      ok: true,
      items: [{
        seq,
        text: 'same full text 已完成',
        taskType: 'video',
        dataIdAttr,
        recordIdAttr: '',
        className: 'record-5JpNAj agentic-SFmZ8x completed-oGwihx',
      }],
    });
    let scanCount = 0;
    const page = {
      sleep: async () => {},
      evaluate: vi.fn(async (expression) => {
        if (expression.includes("const labels = ['关闭'")) return false;
        if (expression.includes('const prev = container.scrollTop')) return { kind: 'scrolled' };
        scanCount += 1;
        return scanCount === 1
          ? makeScanned('business-b', 1)
          : makeScanned('business-a', 2);
      }),
    };
    const exact = await findExactDomMatch(page, {
      dataId: 'business-a',
      identityKind: 'business',
      text: 'same full text 已完成',
    }, 'same full text', 2, 'marker');
    expect(exact).toMatchObject({
      dataId: 'business-a',
      locatorId: 'jm-2',
      identityKind: 'business',
    });
  });

  it('returns the actual download primary even when limit is one', () => {
    const generating = { dataId: 'newest', status: 'generating' };
    const ready = { dataId: 'ready', status: 'ready' };
    expect(selectReturnedMatches([generating, ready], ready, 1, true)).toEqual([ready]);
    expect(selectReturnedMatches([generating, ready], ready, 1, false)).toEqual([generating]);
  });

  it('parses captured search API entries into status rows', () => {
    const rows = parseSearchNetworkEntries([{
      url: 'https://jimeng.jianying.com/mweb/search/v1/search?aid=1',
      responseBody: JSON.stringify({
        ret: '0',
        data: {
          item_list: [{
            item_id: 'abc123',
            prompt: '甚至来不及问,身体已经先一步照做,往左挪了半步;叶归年',
            status: 'finish',
            video_url: 'https://v3-artist.vlabvod.com/demo/video.mp4?mime_type=video_mp4',
          }],
        },
      }),
    }], '甚至来不及问');
    expect(rows).toHaveLength(1);
    expect(rows[0].dataId).toBe('abc123');
    expect(rows[0].taskType).toBe('video');
    expect(rows[0].mediaUrl).toContain('vlabvod');
  });

  it('drops unrelated items from a captured search response', () => {
    const rows = parseSearchNetworkEntries([{
      url: 'https://jimeng.jianying.com/mweb/search/v1/search',
      responseBody: {
        data: {
          item_list: [
            { item_id: 'wanted', prompt: 'asset-key wanted' },
            { item_id: 'other', prompt: 'unrelated task' },
          ],
        },
      },
    }], 'asset-key');
    expect(rows.map((row) => row.dataId)).toEqual(['wanted']);
  });

  it('registers status as an isolated ephemeral cookie-backed command', () => {
    expect(statusCommand.site).toBe('jimeng-agent');
    expect(statusCommand.name).toBe('status');
    expect(statusCommand.strategy).toBe(Strategy.COOKIE);
    expect(statusCommand.browser).toBe(true);
    expect(statusCommand.siteSession).toBe('ephemeral');
    expect(statusCommand.defaultWindowMode).toBe('foreground');
    expect(statusCommand.navigateBefore).toBe(false);
  });

  it('contains no arbitrary first-video or document-wide download fallback', () => {
    expect(statusDomSource).not.toContain('findBestVideoRecord');
    expect(statusDomSource).not.toContain('return items[0]');
    expect(statusDomSource).not.toContain("document.querySelector('video')");
    expect(statusDomSource).not.toContain('data-opencli-jimeng-vcard');
    expect(statusDomSource).toContain('card-locator-ambiguous');
    expect(statusDomSource).toContain('card-text-mismatch');
    expect(statusDomSource).toContain('card-identity-mismatch');
    expect(statusDomSource).toContain('root.contains(el)');
    expect(statusDomSource).not.toContain('nativeClick(');
    expect(statusDomSource).not.toContain('alreadyApplied');
  });

  it('maps Windows Chrome download paths to WSL node paths', () => {
    expect(toNodeLocalPath(
      'C:\\Users\\fengwk\\Downloads\\jimeng-demo.mp4',
      { path: { sep: '/', join: (...parts) => parts.join('/').replace(/\/+/g, '/'), normalize: (p) => p } },
    )).toBe('/mnt/c/Users/fengwk/Downloads/jimeng-demo.mp4');
    expect(toNodeLocalPath('/tmp/already-posix.mp4')).toBe('/tmp/already-posix.mp4');
    expect(toNodeLocalPath('')).toBe('');
  });
});

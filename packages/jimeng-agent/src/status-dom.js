/**
 * Browser-side status search and optional download for Jimeng generate history.
 *
 * Flow:
 *   open workspace generate page
 *   -> filter task list with searchKey
 *   -> scan cards newest-first
 *   -> return status rows
 *   -> optionally open the newest ready video and download it
 */

import fs from 'node:fs';
import path from 'node:path';

import { CommandExecutionError } from '@jackwener/opencli/errors';

import {
  buildEnterKeyEvents,
  buildWorkspaceUrl,
  JIMENG_DOMAIN,
} from './agent-dom.js';
import {
  classifyTaskStatus,
  normalizeMatchText,
  textMatchesSearchKey,
} from './status-contract.js';

const RECORD_ITEM_SELECTOR = 'div[data-id]';
const AGENTIC_RECORD_SELECTOR = '[class*="agentic-record-"]';
const VIDEO_RECORD_SELECTOR = '[class*="video-record-"]';
const VIDEO_CARD_SELECTOR = '[class*="video-card-container"], [class*="agentic-video-card"]';
const IMAGE_CARD_SELECTOR = '[class*="image-card-container"]';
// CSS Modules hash tokens may contain underscores/hyphens, so the hash charset
// includes them; wrapper words (record-list-*/record-content-*/...) are rejected
// explicitly so a shared record class can never be confused with a container.
const CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE = '^record-[A-Za-z0-9_-]+$';
const CURRENT_AGENTIC_ROOT_TOKEN_RE_SOURCE = '^agentic-[A-Za-z0-9_-]+$';
const RECORD_ROOT_WRAPPER_HINTS_RE_SOURCE = '^(list|virtual|item|content|container|wrapper|feed|header|footer|empty|skeleton)([_-]|$)';
// Jimeng history cards expose a 16-hex 资产编号 (asset id) in their text.
const ASSET_ID_RE_SOURCE = '^[0-9a-fA-F]{16}$';
const LABELED_ASSET_ID_RE_SOURCE = '资产编号\\s*[：:]\\s*([0-9a-fA-F]{16})';
const EMPTY_STATE_TEXT = '暂未找到相关内容';
const SKELETON_SELECTOR = '#ssr-generated-record-feed-skeleton, [id*="generated-record-feed-skeleton"], [class*="record-feed-skeleton"]';
const HISTORY_ROOT_SELECTOR = '[class*="record-list-container"]';
const TASK_SEARCH_INPUT_SELECTOR = [
  'input[placeholder="搜索"]',
  'input[placeholder*="搜索"]',
  '.search-input-BUcnKA input',
  '.filter-container-yW2QOH input',
].join(', ');

export { JIMENG_DOMAIN };

/**
 * `record-*` tokens only identify a *candidate* current record root. They are
 * never used as a dataId, dedup key, or download locator: the token regex
 * allows CSS-safe hash chars (`_`/`-`) but rejects wrapper words, and the DOM
 * side additionally requires a task-card structure (see RECORD_ROOT_HELPERS_BODY).
 */
export function isCurrentJimengRecordRootToken(token) {
  const value = String(token || '');
  if (!new RegExp(CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE).test(value)) return false;
  const hash = value.slice('record-'.length);
  return !new RegExp(RECORD_ROOT_WRAPPER_HINTS_RE_SOURCE).test(hash);
}

/**
 * Extract the first 16-hex 资产编号 from record text.
 */
export function extractAssetIdFromText(value) {
  const text = String(value || '').trim();
  if (new RegExp(ASSET_ID_RE_SOURCE).test(text)) return text;
  const labeled = text.match(new RegExp(LABELED_ASSET_ID_RE_SOURCE, 'i'));
  return labeled ? labeled[1] : '';
}

/**
 * Map one scanned DOM node to its identity pair.
 * - dataId: DOM business id first, then the 16-hex 资产编号 from text,
 *   otherwise a unique synthetic id. Never a shared CSS class token.
 * - locatorId: unique per actual node (per-node page-wide sequence), used as
 *   the `data-opencli-jimeng-record` attribute for later download lookup.
 */
export function buildRecordMatch({ seq, text, dataIdAttr = '', recordIdAttr = '' } = {}) {
  const businessId = String(dataIdAttr || recordIdAttr || '').trim();
  if (businessId) {
    return { dataId: businessId, locatorId: `jm-${seq}`, identityKind: 'business' };
  }
  const assetId = extractAssetIdFromText(text);
  if (assetId) {
    return { dataId: assetId, locatorId: `jm-${seq}`, identityKind: 'asset' };
  }
  return {
    dataId: `jm-synthetic-${seq}-${hashRecordText(text)}`,
    locatorId: `jm-${seq}`,
    identityKind: 'synthetic',
  };
}

export function recordIdentityKey({ identityKind = 'unknown', dataId = '' } = {}) {
  return `${identityKind}:${String(dataId)}`;
}

function hashRecordText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Query-aware filter settle classification.
 * A terminal state requires the search input to already hold the query and the
 * feed skeleton to be gone, plus either at least one visible matching record
 * root (`matched`) or the explicit empty-state text (`empty`).
 */
export function classifyQuerySettleState({
  query,
  inputValue,
  skeletonVisible,
  scopeReady = true,
  matchedRootCount,
  visibleRootCount = matchedRootCount,
  emptyStateVisible,
} = {}) {
  const target = String(query ?? '').trim().slice(0, 100);
  const actual = String(inputValue ?? '').trim();
  if (!scopeReady) return 'pending';
  if (actual !== target) return 'pending';
  if (skeletonVisible) return 'pending';
  if (emptyStateVisible && visibleRootCount > 0) return 'conflict';
  if (matchedRootCount > 0) return 'matched';
  if (emptyStateVisible && visibleRootCount === 0) return 'empty';
  return 'pending';
}

export function classifySearchResolution({ settleKind, apiMatchCount = 0 } = {}) {
  const count = Number.isInteger(apiMatchCount) && apiMatchCount > 0 ? apiMatchCount : 0;
  if (settleKind === 'matched') return { kind: 'matched' };
  if (settleKind === 'conflict') return { kind: 'conflict' };
  if (settleKind === 'empty') {
    return count > 0 ? { kind: 'conflict' } : { kind: 'not_found' };
  }
  return { kind: 'timeout' };
}

export function isJimengTaskListReady(state) {
  return Boolean(
    state?.searchInputVisible
    && state?.recordListVisible
    && !state?.skeletonVisible,
  );
}

// In-page helpers shared by the settle wait and the record scan. `record-*`
// roots must have both the current record hash and its sibling agentic hash;
// wrappers (record-list/record-virtual-list/record-content/...) are excluded.
const RECORD_ROOT_HELPERS_BODY = `
  const visibleEl = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const isRootToken = (token) => {
    const value = String(token || '');
    if (!new RegExp(${JSON.stringify(CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE)}).test(value)) return false;
    const hash = value.slice('record-'.length);
    return !new RegExp(${JSON.stringify(RECORD_ROOT_WRAPPER_HINTS_RE_SOURCE)}).test(hash);
  };
  const hasCurrentAgenticToken = (el) => {
    const tokens = String(el.className || '').split(/\\s+/);
    return tokens.some((token) => (
      new RegExp(${JSON.stringify(CURRENT_AGENTIC_ROOT_TOKEN_RE_SOURCE)}).test(token)
      && !token.startsWith('agentic-record-')
    ));
  };
  const isCurrentRecordRoot = (el) => {
    const tokens = String(el.className || '').split(/\\s+/);
    if (!tokens.some(isRootToken)) return false;
    if (!hasCurrentAgenticToken(el)) return false;
    let parent = el.parentElement;
    while (parent) {
      const parentTokens = String(parent.className || '').split(/\\s+/);
      if (parentTokens.some(isRootToken)) return false;
      parent = parent.parentElement;
    }
    return true;
  };
  const isPrefixedRecordRoot = (el, prefix) => {
    const tokens = String(el.className || '').split(/\\s+/);
    const re = new RegExp('^' + prefix + '-[A-Za-z0-9_-]+$');
    const wrapperRe = new RegExp(${JSON.stringify(RECORD_ROOT_WRAPPER_HINTS_RE_SOURCE)});
    const hit = tokens.some((token) => (
      re.test(token)
      && !wrapperRe.test(token.slice(prefix.length + 1))
    ));
    if (!hit) return false;
    let parent = el.parentElement;
    while (parent) {
      const parentTokens = String(parent.className || '').split(/\\s+/);
      if (parentTokens.some((token) => (
        re.test(token)
        && !wrapperRe.test(token.slice(prefix.length + 1))
      ))) {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  };
  const collectRecordRoots = (scope = document) => {
    const classic = [...scope.querySelectorAll(${JSON.stringify(RECORD_ITEM_SELECTOR)})];
    const currentRecords = [...scope.querySelectorAll('[class*="record-"]')]
      .filter(isCurrentRecordRoot);
    const agentic = [...scope.querySelectorAll(${JSON.stringify(AGENTIC_RECORD_SELECTOR)})]
      .filter((el) => isPrefixedRecordRoot(el, 'agentic-record'));
    const videoRecords = [...scope.querySelectorAll(${JSON.stringify(VIDEO_RECORD_SELECTOR)})]
      .filter((el) => isPrefixedRecordRoot(el, 'video-record'));
    return [...new Set([...classic, ...currentRecords, ...agentic, ...videoRecords])].filter(visibleEl);
  };
`;

/**
 * Search Jimeng history for tasks matching searchKey.
 * The filtered DOM is authoritative for query state, ordering, and identity.
 * A captured /mweb/search/v1/search response may only enrich an exact DOM row
 * with its media URL.
 * When download=true, downloads the newest ready video match.
 */
export async function runJimengStatus(page, canonical) {
  assertPageCapabilities(page);

  const workspaceUrl = buildWorkspaceUrl(canonical.workspace);
  // Prefer video history when auto; caller can force image.
  const typeParam = canonical.type === 'image' ? 'image' : 'video';
  const url = `${workspaceUrl}&type=${encodeURIComponent(typeParam)}`;
  await page.goto(url);
  await page.sleep(2.5);
  await dismissModals(page);
  const taskListReady = await waitForTaskListReady(page, { timeoutMs: 20_000 });
  if (!taskListReady) {
    throw new CommandExecutionError(
      'JIMENG_STATUS_HISTORY_NOT_READY: search input or history list did not become ready',
      'Retry the status command or inspect the Jimeng workspace loading state.',
    );
  }

  let matches = [];
  let source = 'dom';
  const supportsSearchCapture = (
    typeof page.startNetworkCapture === 'function'
    && typeof page.readNetworkCapture === 'function'
  );
  const capturesSearch = supportsSearchCapture
    ? await page.startNetworkCapture('mweb/search/v1/search').catch(() => false)
    : false;

  const filtered = await applyTaskPromptFilter(page, canonical.searchKey);
  if (!filtered?.ok) {
    throw new CommandExecutionError(
      'JIMENG_STATUS_SEARCH_INPUT_UNAVAILABLE: could not set the history search query',
      'Retry the status command or inspect the Jimeng history search control.',
    );
  }
  const querySettle = await waitForQuerySettled(page, {
    query: canonical.searchKey,
    marker: filtered.marker,
    timeoutMs: 20_000,
  });

  let apiMatches = [];
  if (capturesSearch) {
    const entries = await page.readNetworkCapture().catch(() => []);
    apiMatches = parseSearchNetworkEntries(entries, canonical.searchKey);
  }
  const resolution = classifySearchResolution({
    settleKind: querySettle.kind,
    apiMatchCount: apiMatches.length,
  });
  if (resolution.kind === 'timeout') {
    throw new CommandExecutionError(
      'JIMENG_STATUS_QUERY_WAIT_TIMEOUT: history never settled to a matching card or the explicit empty state',
      'The filtered history list did not confirm the search key within the wait budget; retry or check the workspace manually.',
    );
  }
  if (resolution.kind === 'conflict') {
    throw new CommandExecutionError(
      'JIMENG_STATUS_SEARCH_STATE_CONFLICT: history search produced contradictory matched/empty evidence',
      'Retry the status command; the Jimeng history state or search response disagreed for this query.',
    );
  }
  if (resolution.kind === 'not_found') {
    return [{
      status: 'not_found',
      workspace: canonical.workspace,
      searchKey: canonical.searchKey,
      dataId: '',
      taskType: '',
      text: '',
      cancelled: false,
      downloaded: false,
      path: '',
      matchCount: 0,
      source,
    }];
  }

  const reset = await resetTaskListToLatest(page, { marker: filtered.marker });
  if (!reset) {
    throw new CommandExecutionError(
      'JIMENG_STATUS_HISTORY_SCOPE_LOST: the filtered history container changed before it could be scanned',
      'Retry the status command; the Jimeng history search controls were re-rendered.',
    );
  }
  matches = await findTaskRecords(page, {
    searchKey: canonical.searchKey,
    limit: canonical.limit,
    maxPages: canonical.maxPages,
    readyType: canonical.download ? canonical.type : '',
    marker: filtered.marker,
  });
  matches = mergeExactSearchApiMetadata(matches, apiMatches);

  if (matches.length === 0) {
    throw new CommandExecutionError(
      'JIMENG_STATUS_MATCH_DISAPPEARED: a matching history card disappeared before it could be read',
      'Retry the status command; the Jimeng history list changed while it was being inspected.',
    );
  }

  // Newest-first already. Prefer the last/newest ready item for download.
  const ordered = matches;
  const primary = pickPrimaryMatch(ordered, canonical.type);
  const primaryRank = ordered.indexOf(primary);
  const returned = selectReturnedMatches(ordered, primary, canonical.limit, canonical.download);
  const rows = returned.map((item) => ({
    status: item.status,
    workspace: canonical.workspace,
    searchKey: canonical.searchKey,
    dataId: item.dataId,
    taskType: item.taskType || '',
    text: clipText(item.text, 240),
    cancelled: item.cancelled === true,
    downloaded: false,
    path: '',
    matchCount: ordered.length,
    rank: ordered.indexOf(item),
    source,
    mediaUrl: item.mediaUrl || '',
  }));

  if (!canonical.download) {
    return rows;
  }

  if (!primary || primary.status !== 'ready') {
    // Still return statuses; do not fail hard — generating tasks are valid outcomes.
    return rows.map((row, index) => (
      index === 0
        ? {
          ...row,
          status: primary?.status || row.status,
          downloaded: false,
          path: '',
          downloadSkipped: primary?.status || 'not_ready',
        }
        : row
    ));
  }

  // Always rebuild the locator from the current filtered DOM. Virtualized
  // history nodes may be re-used or replaced after the status scan.
  let downloadMatch = { ...primary, locatorId: '' };
  const downloadFilter = await applyTaskPromptFilter(page, canonical.searchKey);
  if (downloadFilter?.ok) {
    const settled = await waitForQuerySettled(page, {
      query: canonical.searchKey,
      marker: downloadFilter.marker,
      timeoutMs: 8_000,
    });
    if (settled.kind === 'matched') {
      const downloadReset = await resetTaskListToLatest(page, { marker: downloadFilter.marker });
      const domMatch = downloadReset
        ? await findExactDomMatch(
          page,
          primary,
          canonical.searchKey,
          canonical.maxPages,
          downloadFilter.marker,
        )
        : null;
      if (domMatch) {
        downloadMatch = {
          ...primary,
          locatorId: domMatch.locatorId,
        };
      }
    }
  }

  const downloaded = await downloadTaskVideo(page, downloadMatch, canonical.searchKey, canonical.outputDir);
  return rows.map((row) => (
    row.rank === primaryRank
      ? {
        ...row,
        status: downloaded.ok ? 'ready' : row.status,
        downloaded: downloaded.ok === true,
        path: downloaded.path || '',
        collected: downloaded.collected === true,
        collectedFrom: downloaded.collectedFrom || '',
        downloadError: downloaded.error || '',
        downloadNote: downloaded.note || '',
        downloadBytes: downloaded.bytes || 0,
        downloadWarning: downloaded.warning || '',
      }
      : row
  ));
}

function pickPrimaryMatch(matches, preferredType) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const readyPreferred = matches.find((item) => (
    item.status === 'ready'
    && (preferredType === 'auto' || !item.taskType || item.taskType === preferredType)
  ));
  if (readyPreferred) return readyPreferred;
  const readyAny = matches.find((item) => item.status === 'ready');
  if (readyAny) return readyAny;
  return matches[0];
}

export function selectReturnedMatches(matches, primary, limit, includePrimary) {
  const ordered = Array.isArray(matches) ? matches : [];
  if (!includePrimary || !primary) return ordered.slice(0, limit);
  return [primary, ...ordered.filter((item) => item !== primary)].slice(0, limit);
}

function historyScopeLostError() {
  return new CommandExecutionError(
    'JIMENG_STATUS_HISTORY_SCOPE_LOST: the filtered history container changed while it was being scanned',
    'Retry the status command; the Jimeng history search controls were re-rendered.',
  );
}

async function waitForTaskListReady(page, { timeoutMs = 12_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const inputs = [...document.querySelectorAll(${JSON.stringify(TASK_SEARCH_INPUT_SELECTOR)})]
        .filter(visible);
      const historyRoot = inputs.length === 1
        ? inputs[0].closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)})
        : null;
      const searchInputVisible = inputs.length === 1;
      const recordListVisible = !!historyRoot && visible(historyRoot);
      const skeletonVisible = recordListVisible && [
        ...historyRoot.querySelectorAll(${JSON.stringify(SKELETON_SELECTOR)}),
      ].some(visible);
      return { searchInputVisible, skeletonVisible, recordListVisible };
    })()`).catch(() => null);
    if (isJimengTaskListReady(state)) return true;
    await page.sleep(0.35);
  }
  return false;
}

/**
 * Set the history filter box to `searchKey` (empty string clears it).
 * Returns `{ ok, marker }`; the marker identifies the input and its history
 * container so the query-aware settle wait can confirm this exact search.
 */
async function applyTaskPromptFilter(page, searchKey) {
  const query = String(searchKey || '').trim().slice(0, 100);
  // Empty query clears the filter box.
  // Keep going even when query is empty so callers can reset.

  const marker = `jimeng-search-${Date.now()}`;
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inputs = [...document.querySelectorAll(${JSON.stringify(TASK_SEARCH_INPUT_SELECTOR)})].filter(visible);
    if (inputs.length !== 1) return { ok: false };
    const historyRoot = inputs[0].closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)});
    if (!historyRoot || !visible(historyRoot)) return { ok: false };
    inputs[0].setAttribute('data-opencli-jimeng-search', ${JSON.stringify(marker)});
    historyRoot.setAttribute('data-opencli-jimeng-history', ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) return false;

  const selector = `[data-opencli-jimeng-search="${marker}"]`;
  const fillResult = await page.fillText(selector, query).catch(() => null);
  if (!fillResult?.verified || fillResult.actual !== query) return false;
  for (const event of buildEnterKeyEvents()) {
    await page.cdp('Input.dispatchKeyEvent', event);
  }
  await page.sleep(0.5);
  await dismissModals(page, { allowEscape: false });
  return { ok: true, marker };
}

/**
 * Query-aware settle wait (exported for page-mock tests): the input must
 * already hold `query`, the feed skeleton must be gone, and the terminal state
 * is either at least one visible record root whose text matches the query
 * (`matched`) or the explicit empty state (`empty`). A terminal kind must be
 * observed twice consecutively before it is trusted. On timeout returns
 * `{ kind: 'timeout' }` so callers fail closed instead of faking a not_found.
 */
export async function waitForQuerySettled(
  page,
  { query, marker, timeoutMs, pollIntervalMs = 350 },
) {
  const targetQuery = String(query ?? '').trim().slice(0, 100);
  const deadline = Date.now() + timeoutMs;
  let lastKind = null;
  let stableCount = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      ${RECORD_ROOT_HELPERS_BODY}
      const markedInputs = [...document.querySelectorAll('[data-opencli-jimeng-search="${marker}"]')];
      const markedScopes = [...document.querySelectorAll('[data-opencli-jimeng-history="${marker}"]')];
      const input = markedInputs.length === 1 ? markedInputs[0] : null;
      const scope = markedScopes.length === 1 ? markedScopes[0] : null;
      const scopeReady = !!(
        input
        && scope
        && visibleEl(input)
        && visibleEl(scope)
        && input.closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)}) === scope
      );
      const inputValue = input ? String(input.value ?? '') : '';
      const skeletonVisible = scopeReady && [...scope.querySelectorAll(${JSON.stringify(SKELETON_SELECTOR)})]
        .some(visibleEl);
      const texts = scopeReady ? collectRecordRoots(scope)
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter(Boolean) : [];
      const emptyStateVisible = scopeReady && [...scope.querySelectorAll('div, span, p, li')]
        .filter(visibleEl)
        .some((el) => String(el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === ${JSON.stringify(EMPTY_STATE_TEXT)});
      return { scopeReady, inputValue, skeletonVisible, texts, emptyStateVisible };
    })()`).catch(() => null);
    if (!state) {
      await page.sleep(pollIntervalMs / 1000);
      continue;
    }
    lastState = state;
    const matchedRootCount = targetQuery === ''
      ? state.texts.length
      : state.texts.filter((text) => textMatchesSearchKey(text, targetQuery)).length;
    const kind = classifyQuerySettleState({
      query: targetQuery,
      inputValue: state.inputValue,
      skeletonVisible: state.skeletonVisible,
      scopeReady: state.scopeReady,
      matchedRootCount,
      visibleRootCount: state.texts.length,
      emptyStateVisible: state.emptyStateVisible,
    });
    if (kind === 'pending') {
      stableCount = 0;
    } else if (kind === lastKind) {
      stableCount += 1;
    } else {
      stableCount = 1;
    }
    lastKind = kind;
    if (stableCount >= 2) return { kind, state: lastState };
    await page.sleep(pollIntervalMs / 1000);
  }
  return { kind: 'timeout', state: lastState, lastKind };
}

/**
 * Parse captured /mweb/search/v1/search responses into status match rows.
 * Tolerant to field-name drift across Jimeng versions.
 */
export function parseSearchNetworkEntries(entries, searchKey) {
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const url = String(entry.url || entry.key || '');
    if (!/search\/v1\/search|mweb\/search/i.test(url)) continue;
    const body = coerceBody(entry.responseBody ?? entry.body ?? entry.response ?? entry.data);
    if (!body) continue;
    const items = collectSearchItems(body);
    for (const item of items) {
      const text = extractItemText(item);
      if (searchKey && !textMatchesSearchKey(text, searchKey) && !textMatchesSearchKey(JSON.stringify(item), searchKey)) {
        // Skip unrelated items that server responses may mix into the payload.
        continue;
      }
      const dataId = String(
        item.item_id
        || item.id
        || item.history_id
        || item.generate_id
        || item.task_id
        || item.record_id
        || '',
      );
      if (!dataId || seen.has(dataId)) continue;
      seen.add(dataId);
      const assetId = extractAssetIdFromText(
        item.asset_id
        || item.assetId
        || item?.record?.asset_id
        || '',
      ) || extractAssetIdFromText(text);
      const mediaUrl = extractMediaUrl(item);
      const statusText = [
        text,
        item.status,
        item.generate_status,
        item.task_status,
        item.state_desc,
      ].filter(Boolean).join(' ');
      out.push({
        dataId,
        identityKind: 'business',
        assetId,
        text,
        taskType: inferTaskTypeFromItem(item, mediaUrl),
        cancelled: /取消|cancelled/i.test(statusText),
        status: classifyTaskStatus(statusText),
        mediaUrl,
      });
    }
  }
  return out;
}

function coerceBody(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectSearchItems(body) {
  const buckets = [];
  const pushArr = (v) => {
    if (Array.isArray(v)) buckets.push(...v);
  };
  pushArr(body?.data?.item_list);
  pushArr(body?.data?.items);
  pushArr(body?.data?.list);
  pushArr(body?.data?.records);
  pushArr(body?.item_list);
  pushArr(body?.items);
  pushArr(body?.list);
  // Nested common containers
  if (body?.data && typeof body.data === 'object') {
    for (const value of Object.values(body.data)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
        pushArr(value);
      }
      if (value && typeof value === 'object') {
        pushArr(value.item_list);
        pushArr(value.items);
        pushArr(value.list);
      }
    }
  }
  // de-dupe by object identity is enough here
  return buckets.filter((item) => item && typeof item === 'object');
}

function extractItemText(item) {
  const parts = [
    item.prompt,
    item.text,
    item.title,
    item.desc,
    item.description,
    item.caption,
    item.keyword,
    item.asset_id,
    item.item_id,
    item?.generate_info?.prompt,
    item?.aigc_image_params?.prompt,
    item?.aigc_video_params?.prompt,
    item?.content?.prompt,
    item?.record?.prompt,
  ];
  return parts.filter(Boolean).map(String).join('\n');
}

function extractMediaUrl(item) {
  const candidates = [
    item.video_url,
    item.play_url,
    item.download_url,
    item.url,
    item?.video?.url,
    item?.video?.play_url,
    item?.video?.download_url,
    item?.transcoded_video?.origin?.video_url,
    item?.transcoded_video?.origin?.play_url,
    item?.media_data?.video_url,
    item?.item?.video_url,
  ];
  // Deep-ish scan for mp4-like urls
  const json = JSON.stringify(item);
  const m = json.match(/https:\\\/\\\/[^"\\]+vlabvod[^"\\]+|https:\\\/\\\/[^"\\]+\.mp4[^"\\]*|https:\/\/[^"\\]+vlabvod[^"\\]+|https:\/\/[^"\\]+\.mp4[^"\\]*/i);
  if (m?.[0]) {
    candidates.unshift(m[0].replace(/\\\//g, '/'));
  }
  return candidates.map(String).find((u) => /^https?:\/\//.test(u)) || '';
}

function inferTaskTypeFromItem(item, mediaUrl) {
  const blob = JSON.stringify(item).toLowerCase();
  if (mediaUrl.includes('video') || /video_mp4|vlabvod|\.mp4/.test(mediaUrl) || /video/.test(blob)) {
    return 'video';
  }
  if (/image|png|jpg|jpeg|webp/.test(blob)) return 'image';
  return 'video';
}

async function resetTaskListToLatest(page, { marker } = {}) {
  const reset = await page.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('[data-opencli-jimeng-search="${marker}"]')];
    const roots = [...document.querySelectorAll('[data-opencli-jimeng-history="${marker}"]')];
    if (inputs.length !== 1 || roots.length !== 1) return false;
    const root = roots[0];
    if (inputs[0].closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)}) !== root) return false;
    const container = root.querySelector('[class*="record-virtual-list"]') || root;
    container.scrollTop = 0;
    return true;
  })()`);
  if (reset) await page.sleep(1.2);
  return !!reset;
}

export async function findTaskRecords(page, {
  searchKey,
  limit,
  maxPages,
  readyType = '',
  marker,
}) {
  const results = [];
  const seen = new Set();
  const hasDownloadCandidate = () => results.some((item) => (
    item.status === 'ready'
    && (
      readyType === 'auto'
      || !readyType
      || !item.taskType
      || item.taskType === readyType
    )
  ));

  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    await dismissModals(page, { allowEscape: false });
    const scanned = await page.evaluate(buildRecordScanExpression(marker));
    if (!scanned?.ok) throw historyScopeLostError();
    const items = scanned.items;

    // Newest first: reverse DOM order like jimeng_cli.
    for (const item of [...items].reverse()) {
      const compact = normalizeMatchText(item.text);
      if (['今天', '昨天', '更早', '本周', '本月'].includes(compact)) continue;
      if (!textMatchesSearchKey(item.text, searchKey)) continue;
      const { dataId, locatorId, identityKind } = buildRecordMatch(item);
      const identityKey = recordIdentityKey({ identityKind, dataId });
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      const status = classifyTaskStatus(item.text + ' ' + (item.className || ''));
      results.push({
        dataId,
        locatorId,
        identityKind,
        text: item.text,
        taskType: item.taskType,
        cancelled: status === 'cancelled',
        status,
      });
      if (results.length >= limit && (!readyType || hasDownloadCandidate())) return results;
    }

    if (pageNum + 1 >= maxPages) break;
    const scroll = await scrollTaskList(page, { marker });
    if (scroll?.kind === 'scope-lost') throw historyScopeLostError();
    if (scroll?.kind !== 'scrolled') break;
    await page.sleep(1.5);
  }

  return results;
}

export async function scrollTaskList(page, { marker }) {
  return page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const inputs = [...document.querySelectorAll('[data-opencli-jimeng-search="${marker}"]')];
    const roots = [...document.querySelectorAll('[data-opencli-jimeng-history="${marker}"]')];
    if (inputs.length !== 1 || roots.length !== 1) return { kind: 'scope-lost' };
    const root = roots[0];
    if (
      !visible(inputs[0])
      || !visible(root)
      || inputs[0].closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)}) !== root
    ) {
      return { kind: 'scope-lost' };
    }
    const container = root.querySelector('[class*="record-virtual-list"]') || root;
    if (container.scrollHeight <= container.clientHeight + 100) return { kind: 'end' };
    const prev = container.scrollTop;
    container.scrollTop = prev + 800;
    return { kind: container.scrollTop !== prev ? 'scrolled' : 'end' };
  })()`);
}

export function buildRecordScanExpression(marker = '') {
  return `(() => {
    ${RECORD_ROOT_HELPERS_BODY}
    const inputs = [...document.querySelectorAll('[data-opencli-jimeng-search="${marker}"]')];
    const scopes = [...document.querySelectorAll('[data-opencli-jimeng-history="${marker}"]')];
    if (inputs.length !== 1 || scopes.length !== 1) {
      return { ok: false, reason: 'scope-lost', items: [] };
    }
    const scope = scopes[0];
    if (
      !visibleEl(inputs[0])
      || !visibleEl(scope)
      || inputs[0].closest(${JSON.stringify(HISTORY_ROOT_SELECTOR)}) !== scope
    ) return { ok: false, reason: 'scope-lost', items: [] };
    const roots = collectRecordRoots(scope);
    const items = roots.map((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      const hasVideo = !!(
        el.querySelector('video')
        || el.querySelector(${JSON.stringify(VIDEO_CARD_SELECTOR)})
        || el.querySelector('[class*="video-record"]')
        || el.querySelector('[class*="agentic-video"]')
      );
      const hasImage = !!(
        el.querySelector(${JSON.stringify(IMAGE_CARD_SELECTOR)})
        || (!hasVideo && el.querySelector('img'))
      );
      let taskType = '';
      if (hasVideo) taskType = 'video';
      else if (hasImage) taskType = 'image';

      // Unique per-node locator: keep the first marker assigned to this
      // element, otherwise allocate the next page-wide sequence.
      const marker = el.getAttribute('data-opencli-jimeng-record') || '';
      const markerMatch = marker.match(/^jm-(\\d+)$/);
      let seq = 0;
      if (markerMatch) {
        seq = Number(markerMatch[1]);
      } else {
        seq = (window.__opencliJimengRecordSeq = (window.__opencliJimengRecordSeq || 0) + 1);
        el.setAttribute('data-opencli-jimeng-record', 'jm-' + seq);
      }

      return {
        seq,
        text,
        taskType,
        dataIdAttr: el.getAttribute('data-id') || '',
        recordIdAttr: el.getAttribute('data-record-id') || '',
        className: String(el.className || ''),
      };
    });
    return { ok: true, items };
  })()`;
}

export function mergeExactSearchApiMetadata(domItems, apiItems) {
  const apis = Array.isArray(apiItems) ? apiItems : [];
  return (Array.isArray(domItems) ? domItems : []).map((domItem) => {
    const domDataId = String(domItem?.dataId || '').trim();
    const domAssetId = domItem?.identityKind === 'asset'
      ? (extractAssetIdFromText(domItem?.text) || extractAssetIdFromText(domDataId))
      : '';
    const candidates = apis.filter((apiItem) => {
      const apiDataId = String(apiItem?.dataId || '').trim();
      if (
        domItem?.identityKind === 'business'
        && domDataId
        && apiDataId
        && domDataId === apiDataId
      ) return true;
      if (domItem?.identityKind !== 'asset') return false;
      const apiAssetId = extractAssetIdFromText(apiItem?.assetId)
        || extractAssetIdFromText(apiItem?.text);
      return Boolean(domAssetId && apiAssetId && domAssetId === apiAssetId);
    });
    if (candidates.length !== 1) return domItem;
    const apiItem = candidates[0];
    return {
      ...domItem,
      mediaUrl: apiItem.mediaUrl || domItem.mediaUrl || '',
    };
  });
}

/**
 * Re-scan the current (filtered) DOM and correlate one selected row with its
 * exact card. Strong identities are exclusive: business rows only match the
 * same business id, asset rows only match the same 16-hex 资产编号.
 */
export async function findExactDomMatch(page, primary, searchKey, maxPages, marker) {
  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    const items = await findTaskRecords(page, {
      searchKey,
      limit: 1_000,
      maxPages: 1,
      marker,
    });
    const exact = selectExactDomMatch(items, primary, searchKey);
    if (exact) return exact;
    if (pageNum + 1 >= maxPages) break;
    const scroll = await scrollTaskList(page, { marker });
    if (scroll?.kind === 'scope-lost') throw historyScopeLostError();
    if (scroll?.kind !== 'scrolled') break;
    await page.sleep(1.5);
  }
  return null;
}

export function selectExactDomMatch(items, primary, searchKey) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => textMatchesSearchKey(item?.text, searchKey));
  if (candidates.length === 0) return null;

  const primaryDataId = String(primary?.dataId || '').trim();
  if (primary?.identityKind === 'business') {
    const byDataId = candidates.filter((item) => (
      item?.identityKind === 'business'
      && String(item?.dataId || '') === primaryDataId
    ));
    if (byDataId.length === 1) return byDataId[0];
    return null;
  }

  const targetKey = extractAssetIdFromText(primary?.text || '')
    || extractAssetIdFromText(primaryDataId)
    || extractAssetIdFromText(searchKey);
  if (primary?.identityKind === 'asset' && targetKey) {
    const byAssetId = candidates.filter((item) => (
      item?.identityKind === 'asset'
      && (
        extractAssetIdFromText(item?.dataId) === targetKey
        || extractAssetIdFromText(item?.text) === targetKey
      )
    ));
    if (byAssetId.length === 1) return byAssetId[0];
    return null;
  }

  if (primary?.identityKind !== 'synthetic') return null;
  const primaryText = normalizeMatchText(primary?.text || '');
  if (!primaryText) return null;
  const byExactText = candidates.filter((item) => (
    normalizeMatchText(item?.text) === primaryText
  ));
  return byExactText.length === 1 ? byExactText[0] : null;
}

async function downloadTaskVideo(page, match, searchKey, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeId = String(match.dataId || match.locatorId || 'video').replace(/[^\w.-]+/g, '_').slice(0, 80);
  let uiError = '';

  // Official UI download yields full-quality files (~9MB+). It is only allowed
  // when the exact card was located by its unique locatorId and its text still
  // matches searchKey; any missing/ambiguous marker, text mismatch or re-render
  // fails closed here.
  if (match.locatorId && match.identityKind !== 'synthetic') {
    const uiDownload = await downloadViaOfficialButton(page, match, searchKey, outputDir, safeId);
    if (uiDownload.ok) return uiDownload;
    uiError = uiDownload.error || '';
  }

  // Fallback: only the exact matched row's API mediaUrl is allowed. Never an
  // arbitrary DOM card and never the first <video> on the page.
  if (match.mediaUrl) {
    const ext = guessExtFromUrl(match.mediaUrl, '.mp4');
    const targetPath = path.join(outputDir, `jimeng_${safeId}${ext}`);
    try {
      const savedPath = await downloadUrlToFile(match.mediaUrl, targetPath);
      return { ok: true, path: savedPath, note: 'api-media-url-fallback' };
    } catch (err) {
      return { ok: false, error: `api-media-url-fallback-failed: ${err?.message || err}` };
    }
  }

  return {
    ok: false,
    error: uiError || (match.locatorId ? 'official-download-source-not-found' : 'download-source-not-found'),
  };
}

/**
 * Fail-closed classification for an official-download locate attempt.
 * The locatorId must resolve to exactly one node (`card-not-found` /
 * `card-locator-ambiguous`) and its text must still match searchKey
 * (`card-text-mismatch`); a missing/ambiguous marker or re-render therefore
 * never falls through to an arbitrary card.
 */
export function classifyDownloadLocateResult({
  nodeCount,
  text,
  searchKey,
  dataId,
  identityKind,
  dataIdAttr,
  recordIdAttr,
  expectedText,
} = {}) {
  const count = Number.isInteger(nodeCount) ? nodeCount : 0;
  if (count === 0) return { ok: false, error: 'card-not-found' };
  if (count !== 1) return { ok: false, error: 'card-locator-ambiguous' };
  if (!textMatchesSearchKey(text, searchKey)) return { ok: false, error: 'card-text-mismatch' };
  const selectedId = String(dataId || '').trim();
  const businessId = String(dataIdAttr || recordIdAttr || '').trim();
  if (identityKind === 'asset') {
    const expectedAssetId = extractAssetIdFromText(expectedText)
      || extractAssetIdFromText(selectedId)
      || extractAssetIdFromText(searchKey);
    const currentAssetId = extractAssetIdFromText(text);
    if (!expectedAssetId || currentAssetId !== expectedAssetId) {
      return { ok: false, error: 'card-identity-mismatch' };
    }
    return { ok: true };
  }
  if (identityKind === 'business') {
    if (businessId !== selectedId) {
      return { ok: false, error: 'card-identity-mismatch' };
    }
    return { ok: true };
  }
  if (identityKind !== 'synthetic') {
    return { ok: false, error: 'card-identity-mismatch' };
  }
  const expected = normalizeMatchText(expectedText);
  if (!expected || normalizeMatchText(text) !== expected) {
    return { ok: false, error: 'card-identity-mismatch' };
  }
  return { ok: true };
}

async function downloadViaOfficialButton(page, match, searchKey, outputDir, safeId) {
  if (typeof page.waitForDownload !== 'function') {
    return { ok: false, error: 'waitForDownload-unavailable' };
  }
  const locatorId = String(match.locatorId || '');
  if (!locatorId) {
    return { ok: false, error: 'card-locator-missing' };
  }
  const normalizedSearchKey = normalizeMatchText(searchKey);
  const identityKind = String(match.identityKind || '');
  if (identityKind !== 'business' && identityKind !== 'asset') {
    return { ok: false, error: 'card-identity-kind-unsupported' };
  }
  const expectedAssetId = identityKind === 'asset'
    ? (
      extractAssetIdFromText(match.text)
      || extractAssetIdFromText(match.dataId)
      || extractAssetIdFromText(searchKey)
    )
    : '';
  const expectedBusinessId = identityKind === 'business' ? String(match.dataId || '') : '';

  // Locate by the exact unique locatorId and read the card text for
  // searchKey re-validation.
  const located = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-opencli-jimeng-record="${cssEscape(locatorId)}"]')];
    if (nodes.length !== 1) {
      return { nodeCount: nodes.length, text: '', point: null };
    }
    const item = nodes[0];
    item.scrollIntoView({ block: 'center', inline: 'nearest' });
    const card = item.querySelector('[class*="video-card-container"]')
      || item.querySelector('[class*="video-card"]')
      || item.querySelector('[class*="agentic-video-card"]')
      || item;
    const rect = card.getBoundingClientRect();
    return {
      nodeCount: 1,
      text: (item.innerText || item.textContent || '').trim(),
      dataIdAttr: item.getAttribute('data-id') || '',
      recordIdAttr: item.getAttribute('data-record-id') || '',
      point: {
        x: Math.round(rect.left + rect.width * 0.82),
        y: Math.round(rect.top + rect.height * 0.18),
      },
    };
  })()`);
  const locatedResult = classifyDownloadLocateResult({
    nodeCount: located?.nodeCount,
    text: located?.text,
    searchKey,
    dataId: match.dataId,
    identityKind,
    dataIdAttr: located?.dataIdAttr,
    recordIdAttr: located?.recordIdAttr,
    expectedText: match.text,
  });
  if (!locatedResult.ok) {
    return { ok: false, error: locatedResult.error };
  }

  const marker = `jimeng-official-dl-${Date.now()}`;
  let marked = null;
  const markDeadline = Date.now() + 6_000;
  while (Date.now() < markDeadline) {
    // The overlay is installed lazily after the video card finishes loading.
    // Re-hover only this exact card while waiting; all subsequent lookup stays
    // rooted under the same unique locator.
    if (located?.point && typeof page.cdp === 'function') {
      await page.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: located.point.x,
        y: located.point.y,
      }).catch(() => null);
    }
    await page.sleep(0.5);

    marked = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const roots = [...document.querySelectorAll('[data-opencli-jimeng-record="${cssEscape(locatorId)}"]')];
      if (roots.length === 0) return { ok: false, reason: 'card-not-found' };
      if (roots.length !== 1) return { ok: false, reason: 'card-locator-ambiguous' };
      const root = roots[0];
      const norm = (value) => String(value || '')
        .toLowerCase()
        .replace(/[，,。.!！?？;；:：]/g, '')
        .replace(/\\s+/g, '');
      const text = (root.innerText || root.textContent || '').trim();
      if (!norm(text).includes(${JSON.stringify(normalizedSearchKey)})) {
        return { ok: false, reason: 'card-text-mismatch' };
      }
      const businessId = root.getAttribute('data-id') || root.getAttribute('data-record-id') || '';
      const assetIdFrom = (value) => {
        const raw = String(value || '').trim();
        if (/^[0-9a-fA-F]{16}$/.test(raw)) return raw;
        const labeled = raw.match(/资产编号\\s*[：:]\\s*([0-9a-fA-F]{16})/i);
        return labeled ? labeled[1] : '';
      };
      if (${JSON.stringify(identityKind)} === 'asset') {
        if (assetIdFrom(text) !== ${JSON.stringify(expectedAssetId)}) {
          return { ok: false, reason: 'card-identity-mismatch' };
        }
      } else if (${JSON.stringify(identityKind)} === 'business') {
        if (businessId !== ${JSON.stringify(expectedBusinessId)}) {
          return { ok: false, reason: 'card-identity-mismatch' };
        }
      } else {
        return { ok: false, reason: 'card-identity-mismatch' };
      }
      const clickableAncestor = (el) => {
        let current = el;
        while (current && root.contains(current)) {
          if (
            current.matches('button, a, [role="button"]')
            || typeof current.onclick === 'function'
          ) {
            return current;
          }
          if (current === root) break;
          current = current.parentElement;
        }
        return null;
      };
      const toUniqueClickable = (elements) => [...new Set(
        elements.map(clickableAncestor).filter(Boolean),
      )].filter(visible);

      // 1) Explicit text / aria download controls.
      let candidates = toUniqueClickable(
        [...root.querySelectorAll('button, [role="button"], div, span, a')]
          .filter(visible)
          .filter((el) => {
            const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || ''))
              .replace(/\\s+/g, ' ')
              .trim();
            return label === '下载' || /^下载/.test(label) || /download/i.test(label);
          }),
      );

      // 2) Download icon in card overlay toolbar (arrow-down SVG).
      if (candidates.length === 0) {
        candidates = toUniqueClickable(
          [...root.querySelectorAll('[class*="operation-button"], [class*="action-button"], [class*="card-icon-view"]')]
            .filter(visible)
            .filter((el) => {
              const d = [...el.querySelectorAll('path')].map((p) => p.getAttribute('d') || '').join(' ');
              // Official download glyph uses a downward arrow path.
              return d.includes('v10.312l4.023') || d.includes('5.73 5.728');
            }),
        );
      }

      if (candidates.length === 0) return { ok: false, reason: 'download-button-not-found' };
      if (candidates.length !== 1) return { ok: false, reason: 'download-button-ambiguous' };
      candidates[0].setAttribute('data-opencli-jimeng-download', ${JSON.stringify(marker)});
      return { ok: true };
    })()`);
    if (marked?.ok || marked?.reason !== 'download-button-not-found') break;
  }

  if (!marked?.ok) {
    return { ok: false, error: marked?.reason || 'download-button-not-found' };
  }

  const clickReady = await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-opencli-jimeng-download="${marker}"]')];
    if (buttons.length === 0) return { ok: false, reason: 'download-button-not-found' };
    if (buttons.length !== 1) return { ok: false, reason: 'download-button-ambiguous' };
    const roots = [...document.querySelectorAll('[data-opencli-jimeng-record="${cssEscape(locatorId)}"]')];
    if (roots.length === 0) return { ok: false, reason: 'card-not-found' };
    if (roots.length !== 1) return { ok: false, reason: 'card-locator-ambiguous' };
    const root = roots[0];
    const el = buttons[0];
    if (!root.contains(el)) return { ok: false, reason: 'download-button-detached' };
    const norm = (value) => String(value || '')
      .toLowerCase()
      .replace(/[，,。.!！?？;；:：]/g, '')
      .replace(/\\s+/g, '');
    const text = (root.innerText || root.textContent || '').trim();
    if (!norm(text).includes(${JSON.stringify(normalizedSearchKey)})) {
      return { ok: false, reason: 'card-text-mismatch' };
    }
    const businessId = root.getAttribute('data-id') || root.getAttribute('data-record-id') || '';
    const assetIdFrom = (value) => {
      const raw = String(value || '').trim();
      if (/^[0-9a-fA-F]{16}$/.test(raw)) return raw;
      const labeled = raw.match(/资产编号\\s*[：:]\\s*([0-9a-fA-F]{16})/i);
      return labeled ? labeled[1] : '';
    };
    if (${JSON.stringify(identityKind)} === 'asset') {
      if (assetIdFrom(text) !== ${JSON.stringify(expectedAssetId)}) {
        return { ok: false, reason: 'card-identity-mismatch' };
      }
    } else if (${JSON.stringify(identityKind)} === 'business') {
      if (businessId !== ${JSON.stringify(expectedBusinessId)}) {
        return { ok: false, reason: 'card-identity-mismatch' };
      }
    } else {
      return { ok: false, reason: 'card-identity-mismatch' };
    }
    return { ok: true };
  })()`);
  if (!clickReady?.ok) {
    return { ok: false, error: clickReady?.reason || 'download-button-not-found' };
  }

  const downloadStartedAt = Date.now();
  const waitPromise = page.waitForDownload('jimeng-', 30_000);
  const clickResult = await page.click(`[data-opencli-jimeng-download="${marker}"]`).catch(() => null);
  if (!clickResult || clickResult.matches_n !== 1) {
    void waitPromise.catch(() => null);
    return { ok: false, error: 'download-button-click-failed' };
  }
  await page.sleep(0.5);

  let waitResult;
  try {
    waitResult = await waitPromise;
  } catch (err) {
    return { ok: false, error: `official-download-wait-failed: ${err?.message || err}` };
  }

  if (!waitResult?.downloaded) {
    return { ok: false, error: `official-download-not-completed: ${waitResult?.error || 'unknown'}` };
  }

  const rawSourcePath = waitResult.filename || waitResult.path || waitResult.url || '';
  if (!rawSourcePath) {
    return { ok: false, error: 'download-path-missing', raw: waitResult };
  }

  // Chrome on Windows reports C:\... paths; Node in WSL needs /mnt/c/...
  const sourcePath = toNodeLocalPath(rawSourcePath);
  if (!/^jimeng-.*\.mp4$/i.test(path.basename(sourcePath || rawSourcePath))) {
    return { ok: false, error: 'download-file-identity-unconfirmed' };
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: 'downloaded-file-not-found' };
  }
  const sourceStat = fs.statSync(sourcePath);
  if (sourceStat.size <= 0 || sourceStat.mtimeMs < downloadStartedAt - 2_000) {
    return { ok: false, error: 'downloaded-file-stale-or-empty' };
  }
  const ext = path.extname(sourcePath) || path.extname(rawSourcePath) || '.mp4';
  const targetPath = path.join(outputDir, `jimeng_${safeId}${ext}`);
  try {
    if (sourcePath && fs.existsSync(sourcePath)) {
      fs.mkdirSync(outputDir, { recursive: true });
      if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }
      const size = fs.statSync(targetPath).size;
      // Match chatgpt-agent download entry shape: path/collected/collectedFrom/bytes.
      return {
        ok: true,
        path: targetPath,
        collected: true,
        collectedFrom: sourcePath,
        bytes: size,
        note: 'official-download-button',
      };
    }
  } catch (err) {
    // Still report success with the original browser path if copy fails.
    return {
      ok: true,
      path: sourcePath || rawSourcePath,
      collected: false,
      collectedFrom: rawSourcePath,
      warning: err?.message || String(err),
      note: 'official-download-button',
    };
  }
  return {
    ok: true,
    path: sourcePath || rawSourcePath,
    collected: false,
    collectedFrom: rawSourcePath,
    note: 'official-download-button',
    warning: sourcePath && sourcePath !== rawSourcePath
      ? `downloaded-file-not-found-at-node-path: ${sourcePath}`
      : 'downloaded-file-not-found-for-copy',
  };
}

/**
 * Convert a Windows path reported by Chrome downloads into a Node-readable path.
 * In WSL: `C:\\Users\\a\\x.mp4` -> `/mnt/c/Users/a/x.mp4`.
 */
export function toNodeLocalPath(rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return '';
  const pathMod = options.path ?? path;
  const mountRoot = options.wslMountRoot ?? '/mnt';
  const windowsPath = rawPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (windowsPath && pathMod.sep === '/') {
    return pathMod.normalize(pathMod.join(
      mountRoot,
      windowsPath[1].toLowerCase(),
      windowsPath[2].replace(/\\/g, '/'),
    ));
  }
  return rawPath;
}

async function downloadUrlToFile(url, targetPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  let finalPath = targetPath;
  if (contentType.includes('video') && !/\.(mp4|webm|mov)(\?|$)/i.test(finalPath)) {
    finalPath = finalPath.replace(/\.[A-Za-z0-9]+$/, '') + '.mp4';
  } else if (contentType.includes('image') && !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(finalPath)) {
    finalPath = finalPath.replace(/\.[A-Za-z0-9]+$/, '') + '.png';
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(finalPath, buf);
  return finalPath;
}

function guessExtFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const mime = parsed.searchParams.get('mime_type') || '';
    if (/video_mp4|mp4/i.test(mime)) return '.mp4';
    if (/image_png|png/i.test(mime)) return '.png';
    if (/image_jpeg|jpe?g/i.test(mime)) return '.jpg';
    const ext = path.extname(parsed.pathname);
    if (ext && ext.length <= 5) return ext;
  } catch {
    // ignore
  }
  return fallback;
}

async function dismissModals(page, { allowEscape = true } = {}) {
  if (allowEscape && typeof page.nativeKeyPress === 'function') {
    await page.nativeKeyPress('Escape').catch(() => null);
    await page.sleep(0.12);
  }
  await page.evaluate(`(() => {
    const labels = ['关闭', '我知道了', '稍后再说', '暂不体验'];
    const buttons = [...document.querySelectorAll('button, [role="button"], .lv-btn')];
    for (const btn of buttons) {
      const text = (btn.innerText || btn.textContent || '').replace(/\\s+/g, '').trim();
      if (!labels.includes(text)) continue;
      const style = window.getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0) continue;
      btn.click();
      return true;
    }
    return false;
  })()`).catch(() => null);
}

function assertPageCapabilities(page) {
  const required = ['goto', 'evaluate', 'click', 'fillText', 'cdp', 'sleep'];
  const missing = required.filter((name) => typeof page?.[name] !== 'function');
  if (missing.length > 0) {
    throw new CommandExecutionError(
      `JIMENG_BROWSER_UNSUPPORTED: missing page capability ${missing.join(', ')}`,
      'Use the OpenCLI Browser Bridge extension.',
    );
  }
}

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function cssEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

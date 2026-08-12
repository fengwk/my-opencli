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

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

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
const CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE = '^record-[A-Za-z0-9]+$';
const TASK_SEARCH_INPUT_SELECTOR = [
  'input[placeholder="搜索"]',
  'input[placeholder*="搜索"]',
  '.search-input-BUcnKA input',
  '.filter-container-yW2QOH input',
].join(', ');

export { JIMENG_DOMAIN };

export function isCurrentJimengRecordRootToken(token) {
  return new RegExp(CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE).test(String(token || ''));
}

export function isJimengTaskListReady(state) {
  return Boolean(
    state?.searchInputVisible
    && state?.recordListVisible
    && !state?.skeletonVisible,
  );
}

/**
 * Search Jimeng history for tasks matching searchKey.
 * Prefer intercepting /mweb/search/v1/search (page signs the request).
 * Fall back to DOM card matching when capture is unavailable.
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
  await waitForTaskListReady(page, { timeoutMs: 12_000 });

  let matches = [];
  let source = 'dom';

  // 1) Network-first: let the real page fire the signed search API.
  if (typeof page.startNetworkCapture === 'function' && typeof page.readNetworkCapture === 'function') {
    await page.startNetworkCapture('mweb/search/v1/search').catch(() => false);
    const filtered = await applyTaskPromptFilter(page, canonical.searchKey);
    if (filtered) {
      const apiMatches = await waitForSearchApiMatches(page, {
        searchKey: canonical.searchKey,
        timeoutMs: 8_000,
      });
      if (apiMatches.length > 0) {
        matches = apiMatches;
        source = 'api';
      }
    }
  }

  // 2) DOM fallback (Agent cards + classic video-record cards).
  if (matches.length === 0) {
    const filtered = await applyTaskPromptFilter(page, canonical.searchKey);
    if (filtered) {
      await waitForTaskListReady(page, { timeoutMs: 8_000 });
      await resetTaskListToLatest(page);
    }
    matches = await findTaskRecords(page, {
      searchKey: canonical.searchKey,
      limit: Math.max(canonical.limit, 5),
      maxPages: canonical.maxPages,
    });
    if (matches.length === 0 && filtered) {
      await applyTaskPromptFilter(page, '');
      await waitForTaskListReady(page, { timeoutMs: 8_000 });
      await resetTaskListToLatest(page);
      matches = await findTaskRecords(page, {
        searchKey: canonical.searchKey,
        limit: Math.max(canonical.limit, 5),
        maxPages: canonical.maxPages,
      });
    }
    source = 'dom';
  }

  if (matches.length === 0) {
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

  // Newest-first already. Prefer the last/newest ready item for download.
  const ordered = matches;
  const primary = pickPrimaryMatch(ordered, canonical.type);
  const rows = ordered.slice(0, canonical.limit).map((item, index) => ({
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
    rank: index,
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

  const downloaded = await downloadTaskVideo(page, primary, canonical.outputDir);
  return rows.map((row) => (
    row.dataId === primary.dataId
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
      const searchInputVisible = [...document.querySelectorAll(${JSON.stringify(TASK_SEARCH_INPUT_SELECTOR)})]
        .some(visible);
      const skeletonVisible = [
        ...document.querySelectorAll(
          '#ssr-generated-record-feed-skeleton, [id*="generated-record-feed-skeleton"], [class*="record-feed-skeleton"]',
        ),
      ].some(visible);
      const recordListVisible = [...document.querySelectorAll('[class*="record-list"]')]
        .some(visible);
      return { searchInputVisible, skeletonVisible, recordListVisible };
    })()`).catch(() => null);
    if (isJimengTaskListReady(state)) return true;
    await page.sleep(0.35);
  }
  return false;
}

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
    if (inputs.length === 0) return { ok: false };
    inputs[0].setAttribute('data-opencli-jimeng-search', ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) return false;

  await page.click(`[data-opencli-jimeng-search="${marker}"]`);
  await page.sleep(0.15);
  const filled = await page.evaluate(`(() => {
    const input = document.querySelector('[data-opencli-jimeng-search="${marker}"]');
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, ${JSON.stringify(query)});
    else input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!filled) {
    if (typeof page.nativeType === 'function') await page.nativeType(query);
    else if (typeof page.insertText === 'function') await page.insertText(query);
    else return false;
  }
  // Complete Chromium Enter descriptor — bare nativeKeyPress('Enter') is dropped.
  if (typeof page.cdp === 'function') {
    for (const event of buildEnterKeyEvents()) {
      await page.cdp('Input.dispatchKeyEvent', event);
    }
  } else if (typeof page.nativeKeyPress === 'function') {
    await page.nativeKeyPress('Enter').catch(() => null);
  }
  await page.sleep(1.8);
  await dismissModals(page, { allowEscape: false });
  return true;
}

async function waitForSearchApiMatches(page, { searchKey, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastEntries = [];
  while (Date.now() < deadline) {
    lastEntries = await page.readNetworkCapture().catch(() => []);
    const parsed = parseSearchNetworkEntries(lastEntries, searchKey);
    if (parsed.length > 0) return parsed;
    await page.sleep(0.35);
  }
  return parseSearchNetworkEntries(lastEntries, searchKey);
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
        // Keep API hits even if text path differs; keyword already filtered server-side.
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

async function resetTaskListToLatest(page) {
  const reset = await page.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      const st = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (st.overflowY === 'auto' || st.overflowY === 'scroll')
        && el.scrollHeight > el.clientHeight + 100
        && rect.width > 200
        && rect.height > 200;
    });
    if (candidates.length === 0) return false;
    const container = candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    container.scrollTop = 0;
    return true;
  })()`);
  if (reset) await page.sleep(1.2);
  return !!reset;
}

async function findTaskRecords(page, { searchKey, limit, maxPages }) {
  const results = [];
  const seen = new Set();

  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    await dismissModals(page, { allowEscape: false });
    const items = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const isPrefixedRecordRoot = (el, prefix) => {
        const tokens = String(el.className || '').split(/\\s+/);
        const re = new RegExp('^' + prefix + '-[A-Za-z0-9_-]+$');
        const hit = tokens.some((token) => re.test(token) && !token.includes('content'));
        if (!hit) return false;
        // Keep only the outermost record node of this family.
        let parent = el.parentElement;
        while (parent) {
          const parentTokens = String(parent.className || '').split(/\\s+/);
          if (parentTokens.some((token) => re.test(token) && !token.includes('content'))) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      };
      const isCurrentRecordRoot = (el) => {
        const tokens = String(el.className || '').split(/\\s+/);
        const re = new RegExp(${JSON.stringify(CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE)});
        if (!tokens.some((token) => re.test(token))) return false;
        let parent = el.parentElement;
        while (parent) {
          const parentTokens = String(parent.className || '').split(/\\s+/);
          if (parentTokens.some((token) => re.test(token))) return false;
          parent = parent.parentElement;
        }
        return true;
      };

      const classic = [...document.querySelectorAll(${JSON.stringify(RECORD_ITEM_SELECTOR)})];
      const currentRecords = [...document.querySelectorAll('[class*="record-"]')]
        .filter(isCurrentRecordRoot);
      const agentic = [...document.querySelectorAll(${JSON.stringify(AGENTIC_RECORD_SELECTOR)})]
        .filter((el) => isPrefixedRecordRoot(el, 'agentic-record'));
      const videoRecords = [...document.querySelectorAll(${JSON.stringify(VIDEO_RECORD_SELECTOR)})]
        .filter((el) => isPrefixedRecordRoot(el, 'video-record'));
      const nodes = [...new Set([...classic, ...currentRecords, ...agentic, ...videoRecords])].filter(visible);
      const reCurrentRecordRoot = new RegExp(${JSON.stringify(CURRENT_RECORD_ROOT_TOKEN_RE_SOURCE)});

      return nodes.map((el, index) => {
        const text = (el.innerText || el.textContent || '').trim();
        const hasVideo = !!(
          el.querySelector('video')
          || el.querySelector('[class*="video-card"]')
          || el.querySelector('[class*="video-record"]')
          || el.querySelector('[class*="agentic-video"]')
        );
        const hasImage = !!(
          el.querySelector('[class*="image-card-container"]')
          || (!hasVideo && el.querySelector('img'))
        );
        let taskType = '';
        if (hasVideo) taskType = 'video';
        else if (hasImage) taskType = 'image';

        const rawId = el.getAttribute('data-id')
          || el.getAttribute('data-record-id')
          || String(el.className || '')
            .split(/\\s+/)
            .find((token) => reCurrentRecordRoot.test(token))
          || '';
        // Keep synthetic ids ASCII-safe: never embed raw prompt text
        // (newlines/quotes break later evaluate selectors).
        const dataId = rawId || ('record-' + index + '-' + hashText(text).slice(0, 12));

        // Stable locator for later download click.
        el.setAttribute('data-opencli-jimeng-record', dataId);

        return {
          dataId,
          text,
          taskType,
          className: String(el.className || ''),
        };
      }).filter((item) => item.text);

      function hashText(value) {
        const s = String(value || '');
        let h = 2166136261;
        for (let i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
      }
    })()`);

    // Newest first: reverse DOM order like jimeng_cli.
    for (const item of [...items].reverse()) {
      const compact = normalizeMatchText(item.text);
      if (['今天', '昨天', '更早', '本周', '本月'].includes(compact)) continue;
      if (!textMatchesSearchKey(item.text, searchKey)) continue;
      if (seen.has(item.dataId)) continue;
      seen.add(item.dataId);
      const status = classifyTaskStatus(item.text + ' ' + (item.className || ''));
      results.push({
        dataId: item.dataId,
        text: item.text,
        taskType: item.taskType,
        cancelled: status === 'cancelled',
        status,
      });
      if (results.length >= limit) return results;
    }

    const scrolled = await page.evaluate(`(() => {
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        const st = getComputedStyle(el);
        return (st.overflowY === 'auto' || st.overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 100;
      });
      if (candidates.length === 0) return false;
      const container = candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      const prev = container.scrollTop;
      container.scrollTop = prev + 800;
      return container.scrollTop !== prev;
    })()`);
    if (!scrolled) break;
    await page.sleep(1.5);
  }

  return results;
}

async function downloadTaskVideo(page, match, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeId = String(match.dataId || 'video').replace(/[^\w.-]+/g, '_').slice(0, 80);

  // Official UI download yields full-quality files (~9MB+). CDN <video src>
  // is often a compressed preview and must not be preferred.
  const uiDownload = await downloadViaOfficialButton(page, match, outputDir, safeId);
  if (uiDownload.ok) return uiDownload;

  // Fallback 1: media URL from search API payload (when present).
  if (match.mediaUrl) {
    const ext = guessExtFromUrl(match.mediaUrl, '.mp4');
    const targetPath = path.join(outputDir, `jimeng_${safeId}${ext}`);
    try {
      const savedPath = await downloadUrlToFile(match.mediaUrl, targetPath);
      return { ok: true, path: savedPath, note: 'api-media-url-fallback' };
    } catch (err) {
      void err;
    }
  }

  // Fallback 2: visible <video src> (preview quality; last resort).
  const preview = await extractDomMediaSrc(page, match.dataId);
  if (preview?.src) {
    const ext = guessExtFromUrl(preview.src, preview.kind === 'image' ? '.png' : '.mp4');
    const targetPath = path.join(outputDir, `jimeng_${safeId}_preview${ext}`);
    try {
      const savedPath = await downloadUrlToFile(preview.src, targetPath);
      return {
        ok: true,
        path: savedPath,
        note: 'preview-src-fallback',
        warning: 'Downloaded preview/stream URL; may be smaller than official 下载 button output',
      };
    } catch (err) {
      return { ok: false, error: `preview-url-download-failed: ${err?.message || err}` };
    }
  }

  return {
    ok: false,
    error: uiDownload.error || preview?.reason || 'download-source-not-found',
  };
}

async function downloadViaOfficialButton(page, match, outputDir, safeId) {
  if (typeof page.waitForDownload !== 'function') {
    return { ok: false, error: 'waitForDownload-unavailable' };
  }

  // Ensure record is marked and scrolled into view; hover to reveal overlay actions.
  const prepared = await page.evaluate(`(() => {
    const item = document.querySelector('[data-opencli-jimeng-record="${cssEscape(match.dataId)}"]')
      || document.querySelector('div[data-id="${cssEscape(match.dataId)}"]')
      || findBestVideoRecord();
    if (!item) return { ok: false, reason: 'card-not-found' };
    item.setAttribute('data-opencli-jimeng-record', ${JSON.stringify(String(match.dataId || 'download-target'))});
    item.scrollIntoView({ block: 'center', inline: 'nearest' });
    const card = item.querySelector('[class*="video-card-container"]')
      || item.querySelector('[class*="video-card"]')
      || item.querySelector('[class*="agentic-video-card"]')
      || item;
    card.setAttribute('data-opencli-jimeng-vcard', '1');
    return { ok: true };
    function findBestVideoRecord() {
      const roots = [...document.querySelectorAll('[class*="video-record-"]')].filter((el) => {
        const tokens = String(el.className || '').split(/\\s+/);
        return tokens.some((t) => /^video-record-[A-Za-z0-9_-]+$/.test(t) && !t.includes('content'));
      });
      return roots[0] || null;
    }
  })()`);
  if (!prepared?.ok) {
    return { ok: false, error: prepared?.reason || 'card-not-found' };
  }
  await page.sleep(0.4);

  // Real pointer hover (synthetic mouse events often do not open the overlay).
  const point = await page.evaluate(`(() => {
    const card = document.querySelector('[data-opencli-jimeng-vcard="1"]')
      || document.querySelector('[class*="video-card-container"]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width * 0.82),
      y: Math.round(r.top + r.height * 0.18),
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
    };
  })()`);
  if (point && typeof page.nativeClick === 'function') {
    // Move hover by a no-op click offset is imperfect; dispatch CDP mouseMoved if available.
    if (typeof page.cdp === 'function') {
      await page.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
      }).catch(() => null);
    }
  }
  await page.sleep(0.5);

  const marker = `jimeng-official-dl-${Date.now()}`;
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const root = document.querySelector('[data-opencli-jimeng-record="${cssEscape(match.dataId)}"]')
      || document.querySelector('[data-opencli-jimeng-vcard="1"]')
      || document;

    // 1) Explicit text / aria download controls.
    let candidates = [...root.querySelectorAll('button, [role="button"], div, span, a')]
      .filter(visible)
      .filter((el) => {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || ''))
          .replace(/\\s+/g, ' ')
          .trim();
        return label === '下载' || /^下载/.test(label) || /download/i.test(label);
      });

    // 2) Download icon in card overlay toolbar (arrow-down SVG).
    if (candidates.length === 0) {
      candidates = [...root.querySelectorAll('[class*="operation-button"], [class*="action-button"], [class*="card-icon-view"]')]
        .filter(visible)
        .filter((el) => {
          const d = [...el.querySelectorAll('path')].map((p) => p.getAttribute('d') || '').join(' ');
          // Official download glyph uses a downward arrow path.
          return d.includes('v10.312l4.023') || d.includes('5.73 5.728');
        });
    }

    if (candidates.length === 0) return { ok: false, reason: 'download-button-not-found' };
    // Prefer smallest clickable control (icon button), not a large wrapper.
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
    candidates[0].setAttribute('data-opencli-jimeng-download', ${JSON.stringify(marker)});
    return { ok: true };
  })()`);

  if (!marked?.ok) {
    return { ok: false, error: marked?.reason || 'download-button-not-found' };
  }

  const clickPoint = await page.evaluate(`(() => {
    const el = document.querySelector('[data-opencli-jimeng-download="${marker}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

  const waitPromise = page.waitForDownload('', 90_000);
  if (clickPoint && typeof page.nativeClick === 'function') {
    await page.nativeClick(clickPoint.x, clickPoint.y);
  } else {
    await page.click(`[data-opencli-jimeng-download="${marker}"]`);
  }
  await page.sleep(0.5);

  // Some builds open a quality menu; prefer 原画 / 高清 when present.
  const quality = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const btn = [...document.querySelectorAll('button, [role="button"], div, span, li')]
      .filter(visible)
      .find((el) => {
        const label = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
        return label === '原画' || label === '高清' || /^原画|^高清/.test(label);
      });
    if (!btn) return { ok: false };
    const r = btn.getBoundingClientRect();
    btn.setAttribute('data-opencli-jimeng-download-quality', '1');
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (quality?.ok) {
    if (quality.x && typeof page.nativeClick === 'function') {
      await page.nativeClick(quality.x, quality.y);
    } else {
      await page.click('[data-opencli-jimeng-download-quality="1"]');
    }
  }

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

async function extractDomMediaSrc(page, dataId) {
  return page.evaluate(`(() => {
    const item = document.querySelector('[data-opencli-jimeng-record="${cssEscape(dataId)}"]')
      || document.querySelector('div[data-id="${cssEscape(dataId)}"]');
    if (!item) {
      const video = document.querySelector('video');
      const src = video?.currentSrc || video?.src || '';
      if (src) return { ok: true, kind: 'video', src };
      return { ok: false, reason: 'card-not-found' };
    }
    const videos = [...item.querySelectorAll('video')];
    for (const video of videos) {
      const src = video.currentSrc || video.src || '';
      if (src) return { ok: true, kind: 'video', src };
    }
    return { ok: false, reason: 'media-src-missing' };
  })()`);
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
  const required = ['goto', 'evaluate', 'click', 'sleep'];
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

/**
 * jimeng-agent canvas-v0 read-back transport.
 *
 * Legacy canvases are read through the same authenticated page transport as the
 * Octo APIs, but they answer under `/mweb/v1/*` with the `{ret, errmsg, data}`
 * envelope. Three calls are needed to describe one generation:
 *   - `/mweb/v1/infinite_canvas/project_detail`  canvas draft: node → recordId
 *   - `/mweb/v1/get_history_by_ids`              history records: status + video
 *
 * The draft stores `aiGeneratorReference` as node-id → `{recordId, itemId, turnId}`,
 * so a status row is a join of the draft and the history records. No submission
 * happens here; every call is read-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { CommandExecutionError } from '@jackwener/opencli/errors';

import { requestJimengJson } from './canvas-api.js';
import { navigateCanvasStatus } from './canvas-resource-dom.js';
import {
  buildCanvasV0Url,
  canvasV0RecordStatusName,
  evaluateCanvasV0RecordState,
  parseCanvasV0AssetId,
  pickCanvasV0VideoDefinition,
  readCanvasV0RecordMedia,
} from './canvas-v0-contract.js';

export const CANVAS_V0_PROJECT_DETAIL_PATH = '/mweb/v1/infinite_canvas/project_detail';
export const CANVAS_V0_HISTORY_BY_IDS_PATH = '/mweb/v1/get_history_by_ids';

const V0_API_PATH_PREFIXES = Object.freeze(['/mweb/v1/']);
const V0_HISTORY_BATCH_SIZE = 50;

async function postCanvasV0(page, apiPath, body) {
  const envelope = await requestJimengJson(page, apiPath, body, { pathPrefixes: V0_API_PATH_PREFIXES });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_API_FAILED: ${apiPath} returned a malformed envelope`,
      'Confirm that the Jimeng browser session is logged in and can open this canvas.',
    );
  }
  if (String(envelope.ret ?? '') !== '0') {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_API_FAILED: ${apiPath} rejected the request (ret=${String(envelope.ret ?? 'missing')}, errmsg=${String(envelope.errmsg || '')})`,
      'Confirm that the Jimeng browser session is logged in and can open this canvas.',
    );
  }
  return envelope.data;
}

/**
 * Read one legacy canvas draft: title, node → history-record references.
 */
export async function readCanvasV0ProjectDraft(page, projectId) {
  const data = await postCanvasV0(page, CANVAS_V0_PROJECT_DETAIL_PATH, { project_id: projectId });
  const project = data?.project;
  if (!project || typeof project !== 'object') {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_API_FAILED: ${CANVAS_V0_PROJECT_DETAIL_PATH} returned no project for ${projectId}`,
      'Confirm the project id belongs to a legacy canvas (/ai-tool/canvas).',
    );
  }
  const rawDraft = project?.draft?.draft;
  let draft = null;
  if (typeof rawDraft === 'string' && rawDraft.trim() !== '') {
    try {
      draft = JSON.parse(rawDraft);
    } catch (error) {
      throw new CommandExecutionError(
        `JIMENG_CANVAS_V0_API_FAILED: ${CANVAS_V0_PROJECT_DETAIL_PATH} returned an unreadable draft (${error instanceof Error ? error.message : String(error)})`,
        'Open the canvas in the browser to confirm it still loads, then retry.',
      );
    }
  } else if (rawDraft && typeof rawDraft === 'object') {
    draft = rawDraft;
  }
  const references = [];
  const referenceMap = draft?.aiGeneratorReference;
  if (referenceMap && typeof referenceMap === 'object' && !Array.isArray(referenceMap)) {
    for (const [nodeId, reference] of Object.entries(referenceMap)) {
      const recordId = String(reference?.recordId ?? '').trim();
      if (!recordId) continue;
      references.push({
        nodeId,
        recordId,
        itemId: String(reference?.itemId ?? '').trim(),
        turnId: String(reference?.turnId ?? '').trim(),
        nodeType: reference?.type ?? '',
      });
    }
  }
  const nodes = new Map();
  collectCanvasV0Nodes(draft?.layers, nodes);
  return {
    projectId: String(project.id ?? projectId),
    title: String(project.name ?? '').trim(),
    projectStatus: project.status ?? '',
    draftVersion: draft?.version ?? '',
    layerCount: Array.isArray(draft?.layers) ? draft.layers.length : 0,
    nodes,
    references,
  };
}

export async function fetchCanvasV0HistoryRecords(page, recordIds) {
  const wanted = [...new Set((recordIds || []).map((id) => String(id).trim()).filter(Boolean))];
  const records = new Map();
  for (let index = 0; index < wanted.length; index += V0_HISTORY_BATCH_SIZE) {
    const batch = wanted.slice(index, index + V0_HISTORY_BATCH_SIZE);
    const data = await postCanvasV0(page, CANVAS_V0_HISTORY_BY_IDS_PATH, { history_ids: batch });
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    for (const [recordId, record] of Object.entries(data)) {
      if (record && typeof record === 'object') records.set(String(recordId), record);
    }
  }
  return records;
}

/**
 * Join the draft with the history records into one row per generated item.
 */
export async function readCanvasV0Generations(page, canonical) {
  const canvasUrl = buildCanvasV0Url(
    { mode: 'existing', value: canonical.projectId, projectId: canonical.projectId },
    { projectId: canonical.projectId },
  );
  await prepareCanvasV0Page(page, canvasUrl);
  const draft = await readCanvasV0ProjectDraft(page, canonical.projectId);
  const recordIds = [...new Set(draft.references.map((reference) => reference.recordId))];
  const records = recordIds.length > 0
    ? await fetchCanvasV0HistoryRecords(page, recordIds)
    : new Map();

  const rows = [];
  for (const reference of draft.references) {
    const record = records.get(reference.recordId);
    if (!record) continue;
    const media = readCanvasV0RecordMedia(record);
    const verdict = evaluateCanvasV0RecordState(record, media);
    const node = draft.nodes.get(reference.nodeId) || null;
    rows.push({
      recordId: reference.recordId,
      nodeId: reference.nodeId,
      nodeType: node?.type ? String(node.type) : (reference.nodeType ? String(reference.nodeType) : ''),
      itemId: reference.itemId || media?.itemId || '',
      turnId: reference.turnId,
      canvasUrl,
      state: verdict.state,
      stateReason: verdict.reason,
      statusCode: record.status ?? '',
      statusName: canvasV0RecordStatusName(record.status),
      itemStatusCode: media?.itemStatus ?? '',
      generateType: record.generate_type ?? '',
      createdAt: record.created_time ?? '',
      finishTime: record.finish_time ?? '',
      prompt: media?.prompt || '',
      assetId: parseCanvasV0AssetId(media?.prompt || ''),
      duration: media?.duration ?? '',
      videoId: media?.videoId || '',
      coverUrl: media?.coverUrl || '',
      definitions: media?.definitions || [],
    });
  }
  rows.sort((left, right) => Number(right.finishTime || 0) - Number(left.finishTime || 0));
  return {
    projectId: draft.projectId,
    title: draft.title,
    layerCount: draft.layerCount,
    referenceCount: draft.references.length,
    recordCount: recordIds.length,
    canvasUrl,
    rows,
  };
}

/**
 * Build the user-facing status rows: one row per generation, plus an explicit
 * "waiting for the first generation" row when the canvas has no records yet.
 */
export async function runCanvasV0Status(page, canonical) {
  const report = await readCanvasV0Generations(page, canonical);
  let rows = report.rows;
  if (canonical.recordId) {
    rows = rows.filter((row) => row.recordId === canonical.recordId);
  }
  if (canonical.assetId) {
    rows = rows.filter((row) => row.assetId === canonical.assetId);
  }
  const limited = rows.slice(0, canonical.limit);
  const common = {
    canvas: canonical.canvas,
    projectId: report.projectId,
    projectTitle: report.title,
    canvasUrl: report.canvasUrl,
    records: report.recordCount,
    generations: report.rows.length,
    matched: rows.length,
  };

  if (limited.length === 0) {
    const empty = canonical.assetId || canonical.recordId
      ? 'no-matching-generation'
      : (report.rows.length === 0 ? 'no-generations' : 'filtered-out');
    return [{
      ...common,
      status: empty,
      recordId: canonical.recordId,
      assetId: canonical.assetId,
      definitions: '',
      downloadUrl: '',
      prompt: '',
      note: report.rows.length === 0
        ? 'The legacy canvas has no generations yet; canvas-v0-video only prepares a draft until --submit 1 succeeds.'
        : 'No generation matched the requested filter.',
    }];
  }

  return limited.map((row) => {
    const best = pickCanvasV0VideoDefinition({ definitions: row.definitions }, '');
    return {
      ...common,
      status: row.state,
      recordId: row.recordId,
      assetId: row.assetId,
      nodeId: row.nodeId,
      nodeType: row.nodeType,
      itemId: row.itemId,
      stateReason: row.stateReason,
      statusCode: row.statusCode,
      statusName: row.statusName,
      itemStatusCode: row.itemStatusCode,
      generateType: row.generateType,
      finishTime: row.finishTime,
      finishTimeIso: row.finishTime ? new Date(Number(row.finishTime) * 1000).toISOString() : '',
      duration: row.duration,
      videoId: row.videoId,
      definitions: row.definitions.map((entry) => entry.definition).join('/'),
      definitionSizes: row.definitions.map((entry) => `${entry.definition}:${entry.size}`).join('/'),
      downloadUrl: best?.url || '',
      coverUrl: row.coverUrl,
      prompt: row.prompt,
    };
  });
}

/**
 * Download one generated video through the signed CDN URL, verifying the md5 the
 * legacy API publishes for that definition.
 */
export async function runCanvasV0Download(page, canonical) {
  const report = await readCanvasV0Generations(page, canonical);
  const candidates = report.rows.filter((row) => row.definitions.length > 0);
  const matched = canonical.recordId
    ? candidates.filter((row) => row.recordId === canonical.recordId)
    : canonical.assetId
      ? candidates.filter((row) => row.assetId === canonical.assetId)
      : candidates;

  const common = {
    canvas: canonical.canvas,
    projectId: report.projectId,
    projectTitle: report.title,
    canvasUrl: report.canvasUrl,
    generations: report.rows.length,
    matched: matched.length,
    requestedDefinition: canonical.definition,
  };

  if (matched.length === 0) {
    const readyStates = report.rows.map((row) => `${row.recordId}:${row.state}`).join(',');
    const detail = canonical.recordId
      ? `no downloadable video for record ${canonical.recordId}`
      : canonical.assetId
        ? `no downloadable video for asset ${canonical.assetId}`
        : 'the legacy canvas has no downloadable video yet';
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_DOWNLOAD_FAILED: ${detail} (generations=${report.rows.length}${readyStates ? `, states=${readyStates}` : ''})`,
      'Run canvas-v0-status for this canvas to see every generation, its state and the asset ids.',
    );
  }

  const target = matched[0];
  const definition = pickCanvasV0VideoDefinition({ definitions: target.definitions }, canonical.definition);
  if (!definition) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_DOWNLOAD_FAILED: record ${target.recordId} published no video definition`,
      'Run canvas-v0-status to inspect available definitions.',
    );
  }

  const fileName = `canvas-v0-${report.projectId}-${target.recordId}-${definition.definition}.mp4`;
  const filePath = path.join(canonical.outputDir, fileName);
  const downloaded = await downloadCanvasV0File(definition.url, filePath, definition.md5);

  return [{
    ...common,
    status: 'downloaded',
    recordId: target.recordId,
    assetId: target.assetId,
    itemId: target.itemId,
    definition: definition.definition,
    definitionFallback: definition.fallback,
    width: definition.width,
    height: definition.height,
    duration: target.duration,
    path: downloaded.path,
    bytes: downloaded.bytes,
    expectedBytes: definition.size,
    checksum: downloaded.checksum,
    source: definition.url,
  }];
}

async function downloadCanvasV0File(url, targetPath, expectedMd5) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      'Signed Jimeng video URLs expire; retry so the canvas API hands out a fresh URL.',
    );
  }
  if (!response.ok) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_DOWNLOAD_FAILED: HTTP ${response.status} for the signed video URL`,
      'Signed Jimeng video URLs expire; retry so the canvas API hands out a fresh URL.',
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const actualMd5 = createHash('md5').update(buffer).digest('hex');
  const wanted = String(expectedMd5 || '').trim().toLowerCase();
  const checksum = wanted ? (wanted === actualMd5 ? 'verified' : 'mismatch') : 'unavailable';
  if (checksum === 'mismatch') {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_V0_DOWNLOAD_FAILED: md5 mismatch for ${url} (expected ${wanted}, got ${actualMd5})`,
      'Retry the download; nothing was written to disk.',
    );
  }

  fs.writeFileSync(targetPath, buffer);
  return { path: targetPath, bytes: buffer.length, checksum };
}

function collectCanvasV0Nodes(layers, sink, depth = 0) {
  if (depth > 6 || !Array.isArray(layers)) return;
  for (const entry of layers) {
    // A frame stores its children as an array of arrays, one per generated batch.
    if (Array.isArray(entry)) {
      collectCanvasV0Nodes(entry, sink, depth + 1);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.id === 'string' && entry.id) sink.set(entry.id, entry);
    if (Array.isArray(entry.children)) collectCanvasV0Nodes(entry.children, sink, depth + 1);
  }
}

/**
 * The API transport only needs an authenticated jimeng.jianying.com document, so a
 * page already on the target canvas is reused as-is (a reload would drop an unsent
 * draft in that tab).
 */
async function prepareCanvasV0Page(page, canvasUrl) {
  const href = await page.evaluate('(() => location.href)()').catch(() => '');
  if (String(href || '').split('?')[0] === canvasUrl.split('?')[0]) return;
  await navigateCanvasStatus(page, canvasUrl);
}

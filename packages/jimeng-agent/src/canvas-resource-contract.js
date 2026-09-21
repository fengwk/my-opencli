/**
 * Pure contracts for listing and correlating AI Canvas resources.
 */

import { ArgumentError } from '@jackwener/opencli/errors';

import {
  JIMENG_CANVAS_URL,
  normalizeCanvasIdentity,
} from './canvas-contract.js';
import {
  CANVAS_PROJECT_DRAFT_GET_PATH,
  CANVAS_RESOURCE_BATCH_GET_PATH,
  unwrapOctoData,
} from './canvas-api.js';

export const DEFAULT_CANVAS_EVENT_MAX_PAGES = 20;
export const MAX_CANVAS_EVENT_MAX_PAGES = 100;

const RESOURCE_TYPE_NAMES = Object.freeze({
  1: 'image',
  2: 'video',
  3: 'audio',
  4: 'file',
});

const RESOURCE_STATUS_NAMES = Object.freeze({
  200: 'generating',
  1000: 'ready',
  1001: 'failed',
  1002: 'canceled',
  2000: 'deleted',
});

export function normalizeCanvasResourceArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      'Invalid arguments: expected a plain object',
      'Pass --canvas <projectId> or a Jimeng AI Canvas URL.',
    );
  }
  const identity = normalizeCanvasIdentity(kwargs.canvas);
  if (identity.mode !== 'existing' || !identity.projectId) {
    throw new ArgumentError(
      "canvas-status requires an existing canvas; '--canvas new' is not valid",
      'Pass the project id or URL returned by canvas-video.',
    );
  }

  let assetId = '';
  if (kwargs.asset_id !== undefined && kwargs.asset_id !== null) {
    if (typeof kwargs.asset_id !== 'string') {
      throw new ArgumentError(
        "Invalid 'asset-id': expected string",
        'Pass --asset-id with the 16-character value returned by canvas-video.',
      );
    }
    assetId = kwargs.asset_id.trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(assetId)) {
      throw new ArgumentError(
        `Invalid 'asset-id': '${kwargs.asset_id}'`,
        'Pass --asset-id with the 16-character hexadecimal value returned by canvas-video.',
      );
    }
  }

  const rawMaxPages = kwargs.max_pages ?? DEFAULT_CANVAS_EVENT_MAX_PAGES;
  const maxPages = typeof rawMaxPages === 'string' && /^\d+$/.test(rawMaxPages.trim())
    ? Number(rawMaxPages)
    : rawMaxPages;
  if (
    !Number.isSafeInteger(maxPages)
    || maxPages < 1
    || maxPages > MAX_CANVAS_EVENT_MAX_PAGES
  ) {
    throw new ArgumentError(
      `Invalid 'max-pages': expected integer 1-${MAX_CANVAS_EVENT_MAX_PAGES}`,
      `Use --max-pages between 1 and ${MAX_CANVAS_EVENT_MAX_PAGES}.`,
    );
  }

  return {
    canvas: identity.value,
    projectId: identity.projectId,
    assetId,
    maxPages,
  };
}

export function parseCanvasDraftEnvelope(envelope, expectedProjectId) {
  const data = unwrapOctoData(envelope, CANVAS_PROJECT_DRAFT_GET_PATH);
  const project = data.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error(`${CANVAS_PROJECT_DRAFT_GET_PATH} returned no project`);
  }
  const projectId = cleanString(project.project_id);
  if (!projectId || projectId !== expectedProjectId) {
    throw new Error(
      `${CANVAS_PROJECT_DRAFT_GET_PATH} project id did not match '${expectedProjectId}'`,
    );
  }

  let draft;
  try {
    draft = typeof data.draft_json === 'string'
      ? JSON.parse(data.draft_json)
      : data.draft_json;
  } catch (error) {
    throw new Error(
      `${CANVAS_PROJECT_DRAFT_GET_PATH} draft_json was invalid: ${describeError(error)}`,
    );
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error(`${CANVAS_PROJECT_DRAFT_GET_PATH} returned no draft object`);
  }

  const nodes = Array.isArray(draft.nodes)
    ? draft.nodes
    : (Array.isArray(draft.document?.nodes) ? draft.document.nodes : []);

  return {
    project: {
      projectId,
      title: cleanString(project.name),
      createdAt: finiteNumber(project.created_at),
      updatedAt: finiteNumber(project.updated_at),
    },
    draft,
    resources: collectDraftResourceReferences(nodes),
  };
}

export function parseCanvasResourceBatchEnvelope(envelope) {
  const data = unwrapOctoData(envelope, CANVAS_RESOURCE_BATCH_GET_PATH);
  if (!Array.isArray(data.resources)) {
    throw new Error(`${CANVAS_RESOURCE_BATCH_GET_PATH} returned no resources array`);
  }
  return {
    resources: data.resources,
    imageUrls: isPlainObject(data.image_urls) ? data.image_urls : {},
    mediaUrls: isPlainObject(data.media_urls) ? data.media_urls : {},
    fileUrls: isPlainObject(data.file_urls) ? data.file_urls : {},
  };
}

export function collectDraftResourceReferences(nodes) {
  const byResource = new Map();

  const add = (resourceId, node, batchId = '') => {
    const id = cleanString(resourceId);
    if (!id) return;
    let entry = byResource.get(id);
    if (!entry) {
      entry = {
        resourceId: id,
        nodeIds: new Set(),
        nodeTitles: new Set(),
        nodeTypes: new Set(),
        batchIds: new Set(),
      };
      byResource.set(id, entry);
    }
    const nodeId = cleanString(node?.id);
    const nodeTitle = cleanString(node?.data?.title);
    const nodeType = cleanString(node?.type);
    if (nodeId) entry.nodeIds.add(nodeId);
    if (nodeTitle) entry.nodeTitles.add(nodeTitle);
    if (nodeType) entry.nodeTypes.add(nodeType);
    if (batchId) entry.batchIds.add(batchId);
  };

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const data = isPlainObject(node.data) ? node.data : {};
    add(data.resourceId ?? data.resource_id, node);
    const batches = Array.isArray(data.resourceBatches)
      ? data.resourceBatches
      : (Array.isArray(data.resource_batches) ? data.resource_batches : []);
    for (const batch of batches) {
      if (!batch || typeof batch !== 'object') continue;
      const batchId = cleanString(batch.id ?? batch.submit_id);
      const resourceIds = Array.isArray(batch.resourceIds)
        ? batch.resourceIds
        : (Array.isArray(batch.resource_ids) ? batch.resource_ids : []);
      for (const resourceId of resourceIds) add(resourceId, node, batchId);
    }
  }

  return [...byResource.values()].map((entry) => ({
    resourceId: entry.resourceId,
    nodeIds: [...entry.nodeIds],
    nodeTitles: [...entry.nodeTitles],
    nodeTypes: [...entry.nodeTypes],
    batchIds: [...entry.batchIds],
  }));
}

/**
 * Correlate canonical asset ids and run_nodes artifacts through turn_id.
 */
export function correlateCanvasEvents(events) {
  const turns = new Map();

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const turnId = cleanString(event.turn_id ?? event.turnId);
    if (!turnId) continue;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        sessionIds: new Set(),
        assetIds: new Set(),
        artifacts: new Map(),
        createdAt: 0,
      };
      turns.set(turnId, turn);
    }
    const sessionId = cleanString(
      event.session_id ?? event.sessionId ?? event.__sessionId,
    );
    if (sessionId) turn.sessionIds.add(sessionId);
    const createdAt = finiteNumber(event.created_at_ms ?? event.createdAtMs);
    if (createdAt > turn.createdAt) turn.createdAt = createdAt;

    const rawPayload = event.payload;
    for (const assetId of extractAssetIds(rawPayload)) turn.assetIds.add(assetId);
    const payload = parseStructuredValue(rawPayload);
    if (!payload || typeof payload !== 'object') continue;

    const eventType = cleanString(event.event_type ?? event.type).toUpperCase();
    if (eventType !== 'TOOL_CALL_FINISHED') continue;
    const renderInfos = collectRenderInfos(payload);
    const toolName = findRunToolName(payload);
    if (toolName !== 'run_nodes') continue;

    for (const info of renderInfos) {
      const nodeId = cleanString(info.node_id ?? info.nodeId);
      const artifacts = Array.isArray(info.artifacts) ? info.artifacts : [];
      for (const artifact of artifacts) {
        if (!artifact || typeof artifact !== 'object') continue;
        const resourceId = cleanString(artifact.resource_id ?? artifact.resourceId);
        if (!resourceId) continue;
        const prior = turn.artifacts.get(resourceId) || {
          resourceId,
          nodeIds: new Set(),
          mediaTypes: new Set(),
          statuses: new Set(),
          creditsAmount: null,
        };
        if (nodeId) prior.nodeIds.add(nodeId);
        const mediaType = cleanString(artifact.media_type ?? artifact.mediaType);
        const status = cleanString(artifact.status);
        if (mediaType) prior.mediaTypes.add(mediaType);
        if (status) prior.statuses.add(status);
        const credits = finiteNumber(artifact.credits_amount ?? artifact.creditsAmount);
        if (credits !== null) prior.creditsAmount = credits;
        turn.artifacts.set(resourceId, prior);
      }
    }
  }

  const normalizedTurns = [...turns.values()].map((turn) => ({
    turnId: turn.turnId,
    sessionIds: [...turn.sessionIds],
    assetIds: [...turn.assetIds],
    createdAt: turn.createdAt,
    artifacts: [...turn.artifacts.values()].map((artifact) => ({
      resourceId: artifact.resourceId,
      nodeIds: [...artifact.nodeIds],
      mediaTypes: [...artifact.mediaTypes],
      statuses: [...artifact.statuses],
      creditsAmount: artifact.creditsAmount,
    })),
  }));

  const byResource = new Map();
  for (const turn of normalizedTurns) {
    for (const artifact of turn.artifacts) {
      let resource = byResource.get(artifact.resourceId);
      if (!resource) {
        resource = {
          resourceId: artifact.resourceId,
          assetIds: new Set(),
          sessionIds: new Set(),
          turnIds: new Set(),
          nodeIds: new Set(),
          mediaTypes: new Set(),
          statuses: new Set(),
          creditsAmount: null,
          createdAt: 0,
        };
        byResource.set(artifact.resourceId, resource);
      }
      for (const value of turn.assetIds) resource.assetIds.add(value);
      for (const value of turn.sessionIds) resource.sessionIds.add(value);
      resource.turnIds.add(turn.turnId);
      for (const value of artifact.nodeIds) resource.nodeIds.add(value);
      for (const value of artifact.mediaTypes) resource.mediaTypes.add(value);
      for (const value of artifact.statuses) resource.statuses.add(value);
      if (artifact.creditsAmount !== null) resource.creditsAmount = artifact.creditsAmount;
      if (turn.createdAt > resource.createdAt) resource.createdAt = turn.createdAt;
    }
  }

  return {
    turns: normalizedTurns,
    resources: [...byResource.values()].map((resource) => ({
      resourceId: resource.resourceId,
      assetIds: [...resource.assetIds],
      sessionIds: [...resource.sessionIds],
      turnIds: [...resource.turnIds],
      nodeIds: [...resource.nodeIds],
      mediaTypes: [...resource.mediaTypes],
      statuses: [...resource.statuses],
      creditsAmount: resource.creditsAmount,
      createdAt: resource.createdAt,
    })),
  };
}

export function buildCanvasResourceRows({
  project,
  draftResources,
  eventCorrelation,
  batch,
  assetId = '',
  sessionsScanned = 0,
  eventsScanned = 0,
}) {
  const draftById = new Map(
    (Array.isArray(draftResources) ? draftResources : [])
      .map((entry) => [entry.resourceId, entry]),
  );
  const eventById = new Map(
    (Array.isArray(eventCorrelation?.resources) ? eventCorrelation.resources : [])
      .map((entry) => [entry.resourceId, entry]),
  );
  const apiById = new Map(
    (Array.isArray(batch?.resources) ? batch.resources : [])
      .map((entry) => [cleanString(entry?.resource_id), entry])
      .filter(([resourceId]) => resourceId),
  );

  let resourceIds;
  if (assetId) {
    resourceIds = [...eventById.values()]
      .filter((entry) => entry.assetIds.includes(assetId))
      .map((entry) => entry.resourceId);
  } else {
    resourceIds = [...new Set([...draftById.keys(), ...eventById.keys()])];
  }

  const matchingTurns = (eventCorrelation?.turns || [])
    .filter((turn) => !assetId || turn.assetIds.includes(assetId));
  const base = {
    canvas: project.projectId,
    projectId: project.projectId,
    projectTitle: project.title || '',
    canvasUrl: `${JIMENG_CANVAS_URL}/${encodeURIComponent(project.projectId)}`,
    sessionsScanned,
    eventsScanned,
    scanComplete: true,
  };

  if (assetId && matchingTurns.length === 0) {
    return [{
      ...base,
      status: 'not_found',
      assetId,
      resourceId: '',
      resourceCount: 0,
      correlation: 'asset_not_found',
    }];
  }
  if (assetId && resourceIds.length === 0) {
    return [{
      ...base,
      status: 'pending',
      assetId,
      sessionId: uniqueJoin(matchingTurns.flatMap((turn) => turn.sessionIds)),
      turnId: uniqueJoin(matchingTurns.map((turn) => turn.turnId)),
      resourceId: '',
      resourceCount: 0,
      correlation: 'submission_found_no_artifact',
    }];
  }
  if (!assetId && resourceIds.length === 0) {
    return [{
      ...base,
      status: 'not_found',
      assetId: '',
      resourceId: '',
      resourceCount: 0,
      correlation: 'canvas_empty',
    }];
  }

  const rows = resourceIds.map((resourceId) => normalizeResourceRow({
    base,
    resourceId,
    resource: apiById.get(resourceId),
    draft: draftById.get(resourceId),
    event: eventById.get(resourceId),
    batch,
    filterAssetId: assetId,
  }));
  rows.sort((left, right) => (
    (right.createdAt || 0) - (left.createdAt || 0)
    || left.resourceId.localeCompare(right.resourceId)
  ));
  return rows.map((row) => ({ ...row, resourceCount: rows.length }));
}

function normalizeResourceRow({
  base,
  resourceId,
  resource,
  draft,
  event,
  batch,
  filterAssetId,
}) {
  const type = resolveResourceType(resource, event, draft);
  const media = resolveMediaDescriptor(resource, type);
  const urls = resolveResourceUrls(resource, type, media, batch);
  const statusCode = finiteNumber(resource?.status);
  const status = statusCode === null
    ? normalizeArtifactStatus(event?.statuses)
    : (RESOURCE_STATUS_NAMES[statusCode] || 'unknown');
  const generation = isPlainObject(media?.gen) ? media.gen : {};
  const createdAt = finiteNumber(resource?.created_at)
    ?? finiteNumber(event?.createdAt)
    ?? 0;

  return {
    ...base,
    status,
    statusCode: statusCode ?? '',
    assetId: filterAssetId || uniqueJoin(event?.assetIds || []),
    sessionId: uniqueJoin(event?.sessionIds || []),
    turnId: uniqueJoin(event?.turnIds || []),
    nodeId: uniqueJoin([...(draft?.nodeIds || []), ...(event?.nodeIds || [])]),
    nodeTitle: uniqueJoin(draft?.nodeTitles || []),
    batchId: uniqueJoin(draft?.batchIds || []),
    resourceId,
    submitId: cleanString(resource?.submit_id),
    type,
    createdAt,
    createdAtIso: createdAt > 0 ? new Date(createdAt).toISOString() : '',
    creditsAmount: finiteNumber(resource?.credits_amount)
      ?? finiteNumber(event?.creditsAmount)
      ?? '',
    model: cleanString(generation.model_name ?? generation.modelName),
    ratio: cleanString(generation.aspect_ratio ?? generation.aspectRatio),
    resolution: cleanString(generation.resolution ?? media?.resolution),
    duration: resolveDuration(media, generation),
    width: finiteNumber(media?.width) ?? '',
    height: finiteNumber(media?.height) ?? '',
    prompt: clipText(generation.prompt, 280),
    url: urls.url,
    downloadUrl: urls.downloadUrl,
    coverUrl: urls.coverUrl,
    errorCode: primitiveString(resource?.error_code),
    errorMessage: cleanString(resource?.error_message),
    correlation: event ? 'event_artifact' : 'canvas_draft',
  };
}

function resolveResourceType(resource, event, draft) {
  const numeric = finiteNumber(resource?.type);
  if (numeric !== null && RESOURCE_TYPE_NAMES[numeric]) return RESOURCE_TYPE_NAMES[numeric];
  const candidates = [
    ...(event?.mediaTypes || []),
    ...(draft?.nodeTypes || []),
  ].map((value) => cleanString(value).toLowerCase());
  return candidates.find((value) => ['image', 'video', 'audio', 'file'].includes(value))
    || 'unknown';
}

function resolveMediaDescriptor(resource, type) {
  if (!resource || typeof resource !== 'object') return {};
  if (isPlainObject(resource[type])) return resource[type];
  for (const candidate of ['video', 'image', 'audio', 'file']) {
    if (isPlainObject(resource[candidate])) return resource[candidate];
  }
  return {};
}

function resolveResourceUrls(resource, type, media, batch) {
  const imageUrls = isPlainObject(batch?.imageUrls) ? batch.imageUrls : {};
  const mediaUrls = isPlainObject(batch?.mediaUrls) ? batch.mediaUrls : {};
  const fileUrls = isPlainObject(batch?.fileUrls) ? batch.fileUrls : {};
  let urlEntry = {};
  if (type === 'image') {
    const uri = cleanString(media?.uri ?? media?.resource_id);
    urlEntry = isPlainObject(imageUrls[uri]) ? imageUrls[uri] : {};
  } else if (type === 'video' || type === 'audio') {
    const vid = cleanString(media?.vid ?? media?.audio_vid);
    urlEntry = isPlainObject(mediaUrls[vid]) ? mediaUrls[vid] : {};
  } else if (type === 'file') {
    const key = cleanString(media?.uri ?? media?.file_id ?? resource?.resource_id);
    urlEntry = isPlainObject(fileUrls[key]) ? fileUrls[key] : {};
  }
  const downloadUrl = cleanString(
    urlEntry.download_url ?? urlEntry.downloadUrl ?? urlEntry.url,
  );
  return {
    url: cleanString(urlEntry.url) || downloadUrl,
    downloadUrl,
    coverUrl: cleanString(urlEntry.cover_url ?? urlEntry.coverUrl),
  };
}

function resolveDuration(media, generation) {
  const actual = finiteNumber(media?.duration);
  if (actual !== null) return actual;
  const durationMs = finiteNumber(generation.duration_ms ?? generation.durationMs);
  return durationMs === null ? '' : durationMs / 1000;
}

function normalizeArtifactStatus(statuses) {
  const values = (Array.isArray(statuses) ? statuses : [])
    .map((value) => cleanString(value).toLowerCase());
  if (values.includes('running') || values.includes('generating')) return 'generating';
  if (values.includes('success') || values.includes('ready')) return 'ready';
  if (values.includes('failed')) return 'failed';
  if (values.includes('canceled') || values.includes('cancelled')) return 'canceled';
  return values[0] || 'unavailable';
}

function extractAssetIds(value) {
  const found = new Set();
  const seen = new Set();
  const stack = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      const regex = /资产编号\s*[：:]\s*([0-9a-f]{16})(?![0-9a-f])/gi;
      for (const match of current.matchAll(regex)) found.add(match[1].toLowerCase());
      const parsed = parseStructuredValue(current);
      if (parsed !== current) stack.push(parsed);
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) stack.push(...current);
    else stack.push(...Object.values(current));
  }
  return [...found];
}

function collectRenderInfos(root) {
  const found = [];
  const seen = new Set();
  const seenInfos = new Set();
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      const parsed = parseStructuredValue(current);
      if (parsed !== current) stack.push(parsed);
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if ((key === 'render_infos' || key === 'renderInfos') && Array.isArray(value)) {
        for (const info of value) {
          if (isPlainObject(info) && !seenInfos.has(info)) {
            seenInfos.add(info);
            found.push(info);
          }
        }
      }
      stack.push(value);
    }
  }
  return found;
}

function findRunToolName(payload) {
  const direct = cleanString(payload?.tool_name ?? payload?.toolName);
  if (direct) return direct;
  return cleanString(
    payload?.tool_call?.function?.name
    ?? payload?.toolCall?.function?.name
    ?? payload?.tool_call?.name
    ?? payload?.toolCall?.name,
  );
}

function parseStructuredValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (
    !text
    || (!text.startsWith('{') && !text.startsWith('['))
  ) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function uniqueJoin(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(cleanString)
      .filter(Boolean),
  )].join(',');
}

function clipText(value, limit) {
  const text = cleanString(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function primitiveString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}

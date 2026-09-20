/**
 * Read-only AI Canvas resource discovery and assetId correlation.
 */

import { CommandExecutionError } from '@jackwener/opencli/errors';

import {
  CANVAS_AGENT_EVENTS_LIST_PATH,
  CANVAS_AGENT_SESSIONS_LIST_PATH,
  CANVAS_PROJECT_DRAFT_GET_PATH,
  CANVAS_RESOURCE_BATCH_GET_PATH,
  requestCanvasJson,
  unwrapCanvasAgentEnvelope,
} from './canvas-api.js';
import { buildCanvasUrl } from './canvas-contract.js';
import {
  buildCanvasResourceRows,
  correlateCanvasEvents,
  parseCanvasDraftEnvelope,
  parseCanvasResourceBatchEnvelope,
} from './canvas-resource-contract.js';

const PAGE_SIZE = 50;
const RESOURCE_BATCH_SIZE = 50;

export async function runJimengCanvasStatus(page, canonical) {
  assertCanvasStatusPageCapabilities(page);
  const canvasUrl = buildCanvasUrl(canonical.projectId);

  try {
    await navigateCanvasStatus(page, canvasUrl);
    await page.sleep(0.5);

    const draftEnvelope = await requestCanvasJson(
      page,
      CANVAS_PROJECT_DRAFT_GET_PATH,
      { project_id: canonical.projectId },
    );
    const snapshot = parseCanvasDraftEnvelope(draftEnvelope, canonical.projectId);

    const sessions = await listAllCanvasSessions(
      page,
      canonical.projectId,
      canonical.maxPages,
    );
    const events = [];
    for (const session of sessions) {
      const sessionId = cleanString(session.session_id ?? session.sessionId);
      if (!sessionId) continue;
      const sessionEvents = await listAllCanvasEvents(
        page,
        sessionId,
        canonical.maxPages,
      );
      events.push(...sessionEvents.map((event) => ({
        ...event,
        __sessionId: sessionId,
      })));
    }

    const correlation = correlateCanvasEvents(events);
    const resourceIds = selectResourceIds(
      snapshot.resources,
      correlation,
      canonical.assetId,
    );
    const batch = await getCanvasResources(
      page,
      canonical.projectId,
      resourceIds,
    );

    return buildCanvasResourceRows({
      project: snapshot.project,
      draftResources: snapshot.resources,
      eventCorrelation: correlation,
      batch,
      assetId: canonical.assetId,
      sessionsScanned: sessions.length,
      eventsScanned: events.length,
    });
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(
      `JIMENG_CANVAS_STATUS_FAILED: ${describeError(error)}`,
      'Verify canvas access and retry. Increase --max_pages only when the error reports an incomplete event scan.',
    );
  }
}

export async function navigateCanvasStatus(page, canvasUrl) {
  try {
    await page.goto(canvasUrl);
    return;
  } catch (error) {
    if (!/Navigation rejected/i.test(describeError(error))) throw error;
  }

  await page.sleep(0.25);
  try {
    await page.goto(canvasUrl);
    return;
  } catch (error) {
    if (!/Navigation rejected/i.test(describeError(error))) throw error;
    if (typeof page.newTab === 'function' && typeof page.setActivePage === 'function') {
      const pageId = await page.newTab(canvasUrl);
      if (pageId) {
        await page.setActivePage(pageId);
        return;
      }
    }
    throw error;
  }
}

export async function listAllCanvasSessions(page, projectId, maxPages) {
  const sessions = [];
  const seenSessionIds = new Set();
  const seenTokens = new Set();
  let pageToken = '';

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const request = {
      project_id: projectId,
      page_size: PAGE_SIZE,
    };
    if (pageToken) request.page_token = pageToken;
    const envelope = unwrapCanvasAgentEnvelope(
      await requestCanvasJson(page, CANVAS_AGENT_SESSIONS_LIST_PATH, request),
      CANVAS_AGENT_SESSIONS_LIST_PATH,
    );
    const pageSessions = Array.isArray(envelope.sessions) ? envelope.sessions : [];
    for (const session of pageSessions) {
      const id = cleanString(session?.session_id ?? session?.sessionId);
      if (!id || seenSessionIds.has(id)) continue;
      seenSessionIds.add(id);
      sessions.push(session);
    }

    if (envelope.has_more !== true) return sessions;
    const nextToken = cleanString(envelope.next_page_token);
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new Error(`${CANVAS_AGENT_SESSIONS_LIST_PATH} returned an invalid pagination token`);
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }

  throw incompleteScanError(CANVAS_AGENT_SESSIONS_LIST_PATH, maxPages);
}

export async function listAllCanvasEvents(page, sessionId, maxPages) {
  const events = [];
  const seenEventIds = new Set();
  const seenTokens = new Set();
  let pageToken = '';

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const request = {
      session_id: sessionId,
      page_size: PAGE_SIZE,
      backward: true,
    };
    if (pageToken) request.page_token = pageToken;
    const envelope = unwrapCanvasAgentEnvelope(
      await requestCanvasJson(page, CANVAS_AGENT_EVENTS_LIST_PATH, request),
      CANVAS_AGENT_EVENTS_LIST_PATH,
    );
    const pageEvents = Array.isArray(envelope.events) ? envelope.events : [];
    for (const event of pageEvents) {
      const id = cleanString(event?.event_id ?? event?.eventId);
      const dedupeKey = id || `${sessionId}:${events.length}`;
      if (seenEventIds.has(dedupeKey)) continue;
      seenEventIds.add(dedupeKey);
      events.push(event);
    }

    if (envelope.has_more !== true) return events;
    const nextToken = cleanString(envelope.next_page_token);
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new Error(`${CANVAS_AGENT_EVENTS_LIST_PATH} returned an invalid pagination token`);
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }

  throw incompleteScanError(
    `${CANVAS_AGENT_EVENTS_LIST_PATH} for session ${sessionId}`,
    maxPages,
  );
}

export async function getCanvasResources(page, projectId, resourceIds) {
  const merged = {
    resources: [],
    imageUrls: {},
    mediaUrls: {},
    fileUrls: {},
  };
  const ids = [...new Set(
    (Array.isArray(resourceIds) ? resourceIds : [])
      .map(cleanString)
      .filter(Boolean),
  )];

  for (let offset = 0; offset < ids.length; offset += RESOURCE_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + RESOURCE_BATCH_SIZE);
    const envelope = await requestCanvasJson(
      page,
      CANVAS_RESOURCE_BATCH_GET_PATH,
      {
        project_id: projectId,
        resource_ids: chunk,
      },
    );
    const batch = parseCanvasResourceBatchEnvelope(envelope);
    merged.resources.push(...batch.resources);
    Object.assign(merged.imageUrls, batch.imageUrls);
    Object.assign(merged.mediaUrls, batch.mediaUrls);
    Object.assign(merged.fileUrls, batch.fileUrls);
  }

  return merged;
}

function selectResourceIds(draftResources, correlation, assetId) {
  const draftIds = (Array.isArray(draftResources) ? draftResources : [])
    .map((entry) => cleanString(entry.resourceId))
    .filter(Boolean);
  const eventResources = Array.isArray(correlation?.resources)
    ? correlation.resources
    : [];
  const eventIds = eventResources
    .filter((entry) => !assetId || entry.assetIds.includes(assetId))
    .map((entry) => cleanString(entry.resourceId))
    .filter(Boolean);
  return assetId
    ? [...new Set(eventIds)]
    : [...new Set([...draftIds, ...eventIds])];
}

function incompleteScanError(path, maxPages) {
  return new Error(
    `${path} still has more data after ${maxPages} pages; increase --max_pages to avoid an incomplete resource list`,
  );
}

function assertCanvasStatusPageCapabilities(page) {
  const missing = ['goto', 'evaluate', 'sleep']
    .filter((name) => typeof page?.[name] !== 'function');
  if (missing.length > 0) {
    throw new CommandExecutionError(
      `JIMENG_CANVAS_STATUS_BROWSER_UNSUPPORTED: missing page capability ${missing.join(', ')}`,
      'Use the OpenCLI Browser Bridge extension.',
    );
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}

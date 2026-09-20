import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  buildCanvasResourceRows,
  correlateCanvasEvents,
  normalizeCanvasResourceArgs,
  parseCanvasDraftEnvelope,
  parseCanvasResourceBatchEnvelope,
} from '../src/canvas-resource-contract.js';

const PROJECT_ID = '7747d23b-cd5d-454f-9e59-bd6a56f29ced';
const ASSET_ID = '9ef879de0504e787';

function draftEnvelope() {
  return {
    ret: '0',
    errmsg: 'OK',
    data: {
      project: {
        project_id: PROJECT_ID,
        name: '苏州猫咪短片',
        created_at: 1_789_900_000_000,
        updated_at: 1_789_900_100_000,
      },
      draft_json: JSON.stringify({
        draftVersion: 2,
        nodes: [
          {
            id: 'node-video',
            type: 'video',
            data: {
              title: '猫咪视频',
              resourceId: 'resource-ready',
              resourceBatches: [
                {
                  id: 'batch-1',
                  resourceIds: ['resource-ready', 'resource-running'],
                },
              ],
            },
          },
        ],
        edges: [],
      }),
    },
  };
}

function correlatedEvents({ includeArtifact = true } = {}) {
  const events = [
    {
      event_id: 'event-input',
      event_type: 'TURN_STARTED',
      session_id: 'session-1',
      turn_id: 'turn-1',
      created_at_ms: 1_789_900_200_000,
      payload: JSON.stringify({
        parts: [
          {
            type: 'image',
            // Input references must never be mistaken for generated artifacts.
            resource_id: 'tos-input-image',
          },
          {
            type: 'text',
            text: `视频要求\n资产编号：${ASSET_ID}`,
          },
        ],
      }),
    },
  ];
  if (includeArtifact) {
    events.push({
      event_id: 'event-tool',
      event_type: 'TOOL_CALL_FINISHED',
      session_id: 'session-1',
      turn_id: 'turn-1',
      created_at_ms: 1_789_900_210_000,
      payload: JSON.stringify({
        tool_name: 'run_nodes',
        result: {
          parts: [{
            extra: {
              render_infos: [{
                node_id: 'node-video',
                artifacts: [{
                  resource_id: 'resource-running',
                  media_type: 'video',
                  status: 'running',
                  credits_amount: 24,
                }],
              }],
            },
          }],
        },
      }),
    });
  }
  return events;
}

function resourceBatchEnvelope() {
  return {
    ret: '0',
    errmsg: 'OK',
    data: {
      resources: [
        {
          resource_id: 'resource-ready',
          type: 2,
          status: 1000,
          submit_id: 'batch-1',
          created_at: 1_789_900_190_000,
          credits_amount: 24,
          video: {
            vid: 'video-ready',
            width: 1280,
            height: 720,
            duration: 4.096,
            resolution: '720p',
            gen: {
              prompt: '猫咪在柜台互动',
              model_name: 'seedance_2.0_fast_vip',
              aspect_ratio: '16:9',
              resolution: '720p',
              duration_ms: 4000,
            },
          },
        },
        {
          resource_id: 'resource-running',
          type: 2,
          status: 200,
          submit_id: 'batch-1',
          created_at: 1_789_900_200_000,
          video: {
            vid: 'video-running',
            gen: {
              prompt: '正在生成的猫咪镜头',
              model_name: 'seedance_2.0_fast',
              aspect_ratio: '16:9',
              duration_ms: 4000,
            },
          },
        },
      ],
      image_urls: {},
      media_urls: {
        'video-ready': {
          url: 'https://media.example/ready.mp4',
          download_url: 'https://media.example/ready-download.mp4',
          cover_url: 'https://media.example/ready.webp',
        },
      },
      file_urls: {},
    },
  };
}

describe('jimeng-agent/canvas-resource-contract — arguments', () => {
  it('normalizes an existing canvas and optional exact asset id', () => {
    expect(normalizeCanvasResourceArgs({
      canvas: `https://jimeng.jianying.com/ai-tool/ai-canvas/${PROJECT_ID}`,
      asset_id: ASSET_ID.toUpperCase(),
      max_pages: 12,
    })).toEqual({
      canvas: PROJECT_ID,
      projectId: PROJECT_ID,
      assetId: ASSET_ID,
      maxPages: 12,
    });
  });

  it('rejects create mode, malformed asset ids, and unsafe page bounds', () => {
    expect(() => normalizeCanvasResourceArgs({ canvas: 'new' })).toThrow(ArgumentError);
    expect(() => normalizeCanvasResourceArgs({
      canvas: PROJECT_ID,
      asset_id: 'not-an-asset-id',
    })).toThrow(ArgumentError);
    expect(() => normalizeCanvasResourceArgs({
      canvas: PROJECT_ID,
      max_pages: 0,
    })).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/canvas-resource-contract — snapshot and event correlation', () => {
  it('enumerates current and historical resource batches from draft_json', () => {
    const parsed = parseCanvasDraftEnvelope(draftEnvelope(), PROJECT_ID);
    expect(parsed.project).toMatchObject({
      projectId: PROJECT_ID,
      title: '苏州猫咪短片',
    });
    expect(parsed.resources).toEqual([
      {
        resourceId: 'resource-ready',
        nodeIds: ['node-video'],
        nodeTitles: ['猫咪视频'],
        nodeTypes: ['video'],
        batchIds: ['batch-1'],
      },
      {
        resourceId: 'resource-running',
        nodeIds: ['node-video'],
        nodeTitles: ['猫咪视频'],
        nodeTypes: ['video'],
        batchIds: ['batch-1'],
      },
    ]);
  });

  it('links assetId to generated artifacts only through the same turn id', () => {
    const correlation = correlateCanvasEvents(correlatedEvents());
    expect(correlation.turns).toHaveLength(1);
    expect(correlation.turns[0]).toMatchObject({
      turnId: 'turn-1',
      sessionIds: ['session-1'],
      assetIds: [ASSET_ID],
    });
    expect(correlation.resources).toEqual([
      expect.objectContaining({
        resourceId: 'resource-running',
        assetIds: [ASSET_ID],
        turnIds: ['turn-1'],
        nodeIds: ['node-video'],
        statuses: ['running'],
      }),
    ]);
    expect(correlation.resources.some((item) => item.resourceId === 'tos-input-image')).toBe(false);
  });

  it('does not infer generated artifacts from tool events that are not proven run_nodes', () => {
    const ambiguousArtifact = correlatedEvents()[1];
    const payload = JSON.parse(ambiguousArtifact.payload);
    delete payload.tool_name;
    ambiguousArtifact.payload = JSON.stringify(payload);

    const otherToolArtifact = structuredClone(ambiguousArtifact);
    otherToolArtifact.event_id = 'event-other-tool';
    otherToolArtifact.payload = JSON.stringify({
      ...payload,
      tool_name: 'inspect_nodes',
    });

    const correlation = correlateCanvasEvents([
      correlatedEvents()[0],
      ambiguousArtifact,
      otherToolArtifact,
    ]);
    expect(correlation.turns[0].assetIds).toEqual([ASSET_ID]);
    expect(correlation.resources).toEqual([]);
  });
});

describe('jimeng-agent/canvas-resource-contract — output rows', () => {
  it('lists generating and completed resources with signed media metadata', () => {
    const snapshot = parseCanvasDraftEnvelope(draftEnvelope(), PROJECT_ID);
    const correlation = correlateCanvasEvents(correlatedEvents());
    const batch = parseCanvasResourceBatchEnvelope(resourceBatchEnvelope());

    const rows = buildCanvasResourceRows({
      project: snapshot.project,
      draftResources: snapshot.resources,
      eventCorrelation: correlation,
      batch,
      sessionsScanned: 1,
      eventsScanned: 2,
    });

    expect(rows.map((row) => row.status)).toEqual(['generating', 'ready']);
    expect(rows[0]).toMatchObject({
      resourceId: 'resource-running',
      assetId: ASSET_ID,
      correlation: 'event_artifact',
      resourceCount: 2,
    });
    expect(rows[1]).toMatchObject({
      resourceId: 'resource-ready',
      status: 'ready',
      downloadUrl: 'https://media.example/ready-download.mp4',
      coverUrl: 'https://media.example/ready.webp',
      projectTitle: '苏州猫咪短片',
    });
  });

  it('filters exactly by assetId and reports a submitted turn without artifacts as pending', () => {
    const snapshot = parseCanvasDraftEnvelope(draftEnvelope(), PROJECT_ID);
    const batch = parseCanvasResourceBatchEnvelope(resourceBatchEnvelope());
    const matched = buildCanvasResourceRows({
      project: snapshot.project,
      draftResources: snapshot.resources,
      eventCorrelation: correlateCanvasEvents(correlatedEvents()),
      batch,
      assetId: ASSET_ID,
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({
      resourceId: 'resource-running',
      assetId: ASSET_ID,
    });

    const pending = buildCanvasResourceRows({
      project: snapshot.project,
      draftResources: snapshot.resources,
      eventCorrelation: correlateCanvasEvents(correlatedEvents({ includeArtifact: false })),
      batch: { resources: [], imageUrls: {}, mediaUrls: {}, fileUrls: {} },
      assetId: ASSET_ID,
    });
    expect(pending).toEqual([
      expect.objectContaining({
        status: 'pending',
        assetId: ASSET_ID,
        correlation: 'submission_found_no_artifact',
      }),
    ]);
  });

  it('returns not_found rather than guessing when the asset id has no matching turn', () => {
    const snapshot = parseCanvasDraftEnvelope(draftEnvelope(), PROJECT_ID);
    const rows = buildCanvasResourceRows({
      project: snapshot.project,
      draftResources: snapshot.resources,
      eventCorrelation: correlateCanvasEvents([]),
      batch: { resources: [], imageUrls: {}, mediaUrls: {}, fileUrls: {} },
      assetId: ASSET_ID,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'not_found',
        correlation: 'asset_not_found',
        resourceCount: 0,
      }),
    ]);
  });

  // Every server status is normalized, and numeric failure codes remain observable.
  it.each([
    [1001, 'failed'],
    [1002, 'canceled'],
    [2000, 'deleted'],
  ])('maps resource status %s to %s', (statusCode, expectedStatus) => {
    const rows = buildCanvasResourceRows({
      project: { projectId: PROJECT_ID, title: '状态测试' },
      draftResources: [{
        resourceId: `resource-${statusCode}`,
        nodeIds: ['node-status'],
        nodeTitles: [],
        nodeTypes: ['video'],
        batchIds: [],
      }],
      eventCorrelation: { turns: [], resources: [] },
      batch: {
        resources: [{
          resource_id: `resource-${statusCode}`,
          type: 2,
          status: statusCode,
          error_code: 400123,
          error_message: 'generation failed',
          video: {},
        }],
        imageUrls: {},
        mediaUrls: {},
        fileUrls: {},
      },
    });
    expect(rows[0]).toMatchObject({
      status: expectedStatus,
      statusCode,
      errorCode: '400123',
      errorMessage: 'generation failed',
    });
  });
});

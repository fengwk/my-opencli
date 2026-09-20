import { describe, expect, it, vi } from 'vitest';

import {
  listAllCanvasEvents,
  listAllCanvasSessions,
  runJimengCanvasStatus,
} from '../src/canvas-resource-dom.js';
import { normalizeCanvasResourceArgs } from '../src/canvas-resource-contract.js';
import { JIMENG_CANVAS_URL } from '../src/canvas-contract.js';

const PROJECT_ID = '7747d23b-cd5d-454f-9e59-bd6a56f29ced';
const ASSET_ID = '9ef879de0504e787';

function transport(body) {
  return {
    httpOk: true,
    status: 200,
    body,
    parseError: '',
  };
}

function makeStatusPage() {
  const page = {
    goto: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    evaluate: vi.fn(async (expression) => {
      // Parsing every generated browser expression catches unsafe interpolation.
      Function(`return (${expression});`);
      if (expression.includes('/octo_api/v1/project/draft/get')) {
        return transport({
          ret: '0',
          errmsg: 'OK',
          data: {
            project: {
              project_id: PROJECT_ID,
              name: '精确关联测试',
            },
            draft_json: JSON.stringify({
              draftVersion: 2,
              nodes: [{
                id: 'node-1',
                type: 'video',
                data: {
                  title: '成片',
                  resourceId: 'resource-1',
                  resourceBatches: [{
                    id: 'submit-1',
                    resourceIds: ['resource-1'],
                  }],
                },
              }],
            }),
          },
        });
      }
      if (expression.includes('/octo_api/v1/canvas_agent/sessions/list')) {
        return transport({
          code: 0,
          message: 'OK',
          sessions: [{
            project_id: PROJECT_ID,
            session_id: 'session-1',
          }],
          has_more: false,
        });
      }
      if (expression.includes('/octo_api/v1/canvas_agent/events/list')) {
        return transport({
          code: 0,
          message: 'OK',
          events: [
            {
              event_id: 'input',
              event_type: 'TURN_STARTED',
              session_id: 'session-1',
              turn_id: 'turn-1',
              payload: JSON.stringify({
                parts: [{ type: 'text', text: `资产编号：${ASSET_ID}` }],
              }),
            },
            {
              event_id: 'tool',
              event_type: 'TOOL_CALL_FINISHED',
              session_id: 'session-1',
              turn_id: 'turn-1',
              payload: JSON.stringify({
                tool_name: 'run_nodes',
                result: {
                  parts: [{
                    extra: {
                      render_infos: [{
                        node_id: 'node-1',
                        artifacts: [{
                          resource_id: 'resource-1',
                          media_type: 'video',
                          status: 'success',
                        }],
                      }],
                    },
                  }],
                },
              }),
            },
          ],
          has_more: false,
        });
      }
      if (expression.includes('/octo_api/v1/resource/batch_get')) {
        return transport({
          ret: '0',
          errmsg: 'OK',
          data: {
            resources: [{
              resource_id: 'resource-1',
              type: 2,
              status: 1000,
              submit_id: 'submit-1',
              created_at: 1_789_900_000_000,
              video: {
                vid: 'video-1',
                duration: 4,
                gen: {
                  model_name: 'seedance_2.0_fast',
                  aspect_ratio: '16:9',
                },
              },
            }],
            image_urls: {},
            media_urls: {
              'video-1': {
                download_url: 'https://media.example/video-1.mp4',
              },
            },
          },
        });
      }
      throw new Error(`Unexpected evaluate expression: ${expression.slice(0, 120)}`);
    }),
  };
  return page;
}

describe('jimeng-agent/canvas-resource-dom — read-only integration', () => {
  it('loads snapshot/events/resources and returns the exact asset match', async () => {
    const page = makeStatusPage();
    const canonical = normalizeCanvasResourceArgs({
      canvas: PROJECT_ID,
      asset_id: ASSET_ID,
    });

    const rows = await runJimengCanvasStatus(page, canonical);

    expect(page.goto).toHaveBeenCalledWith(`${JIMENG_CANVAS_URL}/${PROJECT_ID}`);
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'ready',
        projectId: PROJECT_ID,
        projectTitle: '精确关联测试',
        assetId: ASSET_ID,
        sessionId: 'session-1',
        turnId: 'turn-1',
        nodeId: 'node-1',
        resourceId: 'resource-1',
        downloadUrl: 'https://media.example/video-1.mp4',
        correlation: 'event_artifact',
        sessionsScanned: 1,
        eventsScanned: 2,
        scanComplete: true,
      }),
    ]);
    const paths = page.evaluate.mock.calls.map(([expression]) => expression);
    expect(paths.some((value) => value.includes('/messages/send'))).toBe(false);
    expect(paths.some((value) => value.includes('/conversation'))).toBe(false);
  });

  // Exhausting a caller bound must fail closed instead of presenting a partial list as complete.
  it('rejects event pagination that remains incomplete at max_pages', async () => {
    const page = {
      evaluate: vi.fn(async () => transport({
        code: 0,
        message: 'OK',
        events: [],
        has_more: true,
        next_page_token: 'next',
      })),
    };

    await expect(
      listAllCanvasEvents(page, 'session-1', 1),
    ).rejects.toThrow('increase --max_pages');
  });

  it('follows session and event page tokens without dropping earlier pages', async () => {
    const sessionPage = {
      evaluate: vi.fn(async (expression) => {
        const secondPage = expression.includes('"page_token":"sessions-next"');
        return transport({
          code: 0,
          message: 'OK',
          sessions: [{
            session_id: secondPage ? 'session-2' : 'session-1',
          }],
          has_more: !secondPage,
          ...(secondPage ? {} : { next_page_token: 'sessions-next' }),
        });
      }),
    };
    await expect(
      listAllCanvasSessions(sessionPage, PROJECT_ID, 2),
    ).resolves.toEqual([
      { session_id: 'session-1' },
      { session_id: 'session-2' },
    ]);

    const eventPage = {
      evaluate: vi.fn(async (expression) => {
        const secondPage = expression.includes('"page_token":"events-next"');
        return transport({
          code: 0,
          message: 'OK',
          events: [{
            event_id: secondPage ? 'event-2' : 'event-1',
          }],
          has_more: !secondPage,
          ...(secondPage ? {} : { next_page_token: 'events-next' }),
        });
      }),
    };
    await expect(
      listAllCanvasEvents(eventPage, 'session-1', 2),
    ).resolves.toEqual([
      { event_id: 'event-1' },
      { event_id: 'event-2' },
    ]);
  });
});

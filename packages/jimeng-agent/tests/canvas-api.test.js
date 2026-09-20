import { describe, expect, it, vi } from 'vitest';

import {
  CANVAS_PROJECT_UPDATE_PATH,
  requestCanvasJson,
  updateCanvasProjectTitle,
} from '../src/canvas-api.js';

function assertEvaluableExpression(expression) {
  Function(`return (${expression});`);
}

describe('jimeng-agent/canvas-api — authenticated same-origin transport', () => {
  it('serializes the title request and accepts the Octo success envelope', async () => {
    let script = '';
    const page = {
      evaluate: vi.fn(async (expression) => {
        script = expression;
        assertEvaluableExpression(expression);
        return {
          httpOk: true,
          status: 200,
          body: {
            ret: '0',
            errmsg: 'OK',
            logid: 'rename-log',
          },
          parseError: '',
        };
      }),
    };

    await expect(
      updateCanvasProjectTitle(page, 'project-1', '画布标题'),
    ).resolves.toEqual({
      projectId: 'project-1',
      title: '画布标题',
      logId: 'rename-log',
    });
    expect(script).toContain(CANVAS_PROJECT_UPDATE_PATH);
    expect(script).toContain('"project_id":"project-1"');
    expect(script).toContain('"name":"画布标题"');
    expect(script).toContain("credentials: 'include'");
  });

  it('rejects HTTP, JSON, and Octo service failures', async () => {
    const httpPage = {
      evaluate: vi.fn(async () => ({
        httpOk: false,
        status: 403,
        body: { errmsg: 'forbidden' },
        parseError: '',
      })),
    };
    await expect(
      requestCanvasJson(httpPage, CANVAS_PROJECT_UPDATE_PATH, {}),
    ).rejects.toThrow('HTTP 403: forbidden');

    const jsonPage = {
      evaluate: vi.fn(async () => ({
        httpOk: true,
        status: 200,
        body: null,
        parseError: 'Unexpected token',
      })),
    };
    await expect(
      requestCanvasJson(jsonPage, CANVAS_PROJECT_UPDATE_PATH, {}),
    ).rejects.toThrow('response was not valid JSON');

    const servicePage = {
      evaluate: vi.fn(async () => ({
        httpOk: true,
        status: 200,
        body: { ret: '20009', errmsg: 'project not found' },
        parseError: '',
      })),
    };
    await expect(
      updateCanvasProjectTitle(servicePage, 'missing', 'title'),
    ).rejects.toThrow('project not found');
  });
});

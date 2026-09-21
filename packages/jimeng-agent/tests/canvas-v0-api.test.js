import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readCanvasV0Generations,
  runCanvasV0Download,
  runCanvasV0Status,
} from '../src/canvas-v0-api.js';
import {
  normalizeCanvasV0DownloadArgs,
  normalizeCanvasV0StatusArgs,
} from '../src/canvas-v0-contract.js';

const PROJECT_ID = '17883546906892';
const RECORD_ID = '39441026984460';
const ASSET_ID = '58674724fb245869';
const CANVAS_URL = `https://jimeng.jianying.com/ai-tool/canvas/${PROJECT_ID}`;

const PROMPT = [
  '(必须使用 Seedance2.0 Fast 模型，**禁止使用 VIP 模型**），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
  `资产编号：${ASSET_ID}`,
  '',
  '---',
  '',
  '请以参考图中的浣熊为主角。',
].join('\n');

const VIDEO_BYTES = Buffer.from('fake-but-stable-mp4-payload');
const VIDEO_MD5 = createHash('md5').update(VIDEO_BYTES).digest('hex');

/** The canvas draft stores its node → history record map as a JSON string. */
function draftPayload({ references = { 'node-1': { recordId: RECORD_ID, itemId: 'item-1', type: 3, turnId: 'turn-1' } } } = {}) {
  return JSON.stringify({
    version: '3.3.9',
    // Frames keep their children as an array of arrays, one per generated batch.
    layers: [{ type: 'frame', id: 'frame-1', children: [[{ type: 'video', id: 'node-1' }]] }],
    aiGeneratorReference: references,
  });
}

function historyRecord(overrides = {}) {
  return {
    status: 50,
    generate_type: 10,
    finish_time: 1785604150,
    fail_starling_message: '',
    item_list: [{
      common_attr: { id: 'item-1', status: 144, prompt: PROMPT, cover_url: 'https://cover.example/a.jpg' },
      video: {
        duration: 16,
        video_id: 'vid-1',
        transcoded_video: {
          '360p': { video_url: 'https://cdn.example/360.mp4', md5: VIDEO_MD5, size: VIDEO_BYTES.length, width: 640, height: 360 },
          '720p': { video_url: 'https://cdn.example/720.mp4', md5: VIDEO_MD5, size: VIDEO_BYTES.length, width: 1280, height: 720 },
        },
      },
    }],
    ...overrides,
  };
}

function transport(body) {
  return { httpOk: true, status: 200, body, parseError: '' };
}

/**
 * Legacy read-back page double: answers the three calls the reader makes
 * (current url, project detail, history by ids) with canned envelopes.
 */
function createCanvasV0Page(options = {}) {
  const calls = { evaluate: [], goto: [] };
  const page = {
    calls,
    async evaluate(expression) {
      const text = String(expression);
      calls.evaluate.push(text);
      if (text.includes('location.href')) return options.href ?? CANVAS_URL;
      if (text.includes('/mweb/v1/infinite_canvas/project_detail')) {
        return transport(options.projectEnvelope ?? {
          ret: '0',
          errmsg: 'success',
          data: {
            project: {
              id: PROJECT_ID,
              name: '阿宝1',
              status: 1,
              draft: { draft: options.draft ?? draftPayload() },
            },
          },
        });
      }
      if (text.includes('/mweb/v1/get_history_by_ids')) {
        const body = options.historyEnvelope ?? {
          ret: '0',
          errmsg: 'success',
          data: { [RECORD_ID]: options.record ?? historyRecord() },
        };
        return transport(body);
      }
      return {};
    },
    async goto(url) {
      calls.goto.push(url);
      return {};
    },
    async sleep() {
      return {};
    },
  };
  return page;
}

const tempDirs = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-v0-api-'));
  tempDirs.push(dir);
  return dir;
}

describe('jimeng-agent canvas-v0 read-back API', () => {
  it('joins the draft references with the history records', async () => {
    const page = createCanvasV0Page();
    const report = await readCanvasV0Generations(page, { projectId: PROJECT_ID });

    expect(report).toMatchObject({
      projectId: PROJECT_ID,
      title: '阿宝1',
      layerCount: 1,
      referenceCount: 1,
      recordCount: 1,
      canvasUrl: CANVAS_URL,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      recordId: RECORD_ID,
      nodeId: 'node-1',
      nodeType: 'video',
      itemId: 'item-1',
      state: 'ready',
      statusName: 'finished',
      assetId: ASSET_ID,
      duration: 16,
    });
    expect(report.rows[0].definitions.map((entry) => entry.definition)).toEqual(['720p', '360p']);
    // The reader reuses a page that already shows the canvas.
    expect(page.calls.goto).toEqual([]);
  });

  it('navigates when the browser is not on the target canvas yet', async () => {
    const page = createCanvasV0Page({ href: 'about:blank' });
    await readCanvasV0Generations(page, { projectId: PROJECT_ID });
    expect(page.calls.goto).toEqual([CANVAS_URL]);
  });

  it('reports one ready row per generation with the best download url', async () => {
    const page = createCanvasV0Page();
    const rows = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({ canvas: PROJECT_ID }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ready',
      projectId: PROJECT_ID,
      recordId: RECORD_ID,
      assetId: ASSET_ID,
      definitions: '720p/360p',
      downloadUrl: 'https://cdn.example/720.mp4',
      generations: 1,
      matched: 1,
    });
    expect(rows[0]['finish-time-iso']).toBeUndefined();
    expect(rows[0].finishTimeIso).toBe(new Date(1785604150 * 1000).toISOString());
  });

  it('filters by asset id, by record id, and reports when nothing matches', async () => {
    const page = createCanvasV0Page();
    const byAsset = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({
      canvas: PROJECT_ID,
      asset_id: ASSET_ID,
    }));
    expect(byAsset).toHaveLength(1);

    const byRecord = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({
      canvas: PROJECT_ID,
      record_id: RECORD_ID,
    }));
    expect(byRecord).toHaveLength(1);

    const missing = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({
      canvas: PROJECT_ID,
      asset_id: '0123456789abcdef',
    }));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ status: 'no-matching-generation', matched: 0 });
  });

  it('explains an untouched canvas instead of returning an empty list', async () => {
    const page = createCanvasV0Page({ draft: draftPayload({ references: {} }) });
    const rows = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({ canvas: PROJECT_ID }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'no-generations', generations: 0, matched: 0 });
    expect(rows[0].note).toMatch(/no generations yet/);
  });

  it('surfaces a failed generation with its reason', async () => {
    const page = createCanvasV0Page({
      record: historyRecord({
        status: 60,
        fail_starling_message: '审核不通过',
        item_list: [{ common_attr: { id: 'item-1', status: 200, prompt: PROMPT, cover_url: '' } }],
      }),
    });
    const rows = await runCanvasV0Status(page, normalizeCanvasV0StatusArgs({ canvas: PROJECT_ID }));
    expect(rows[0]).toMatchObject({ status: 'failed', stateReason: '审核不通过', statusCode: 60, statusName: '' });
  });

  it('rejects a discarded canvas and unreadable project detail', async () => {
    const rejected = createCanvasV0Page({
      projectEnvelope: { ret: '20009', errmsg: 'project not found' },
    });
    await expect(readCanvasV0Generations(rejected, { projectId: PROJECT_ID }))
      .rejects.toThrow(/project_detail rejected the request/);

    const unreadable = createCanvasV0Page({
      projectEnvelope: {
        ret: '0',
        errmsg: 'success',
        data: { project: { id: PROJECT_ID, name: 'x', draft: { draft: '{not-json' } } },
      },
    });
    await expect(readCanvasV0Generations(unreadable, { projectId: PROJECT_ID }))
      .rejects.toThrow(/unreadable draft/);
  });

  it('downloads the requested definition, verifies md5 and writes the file', async () => {
    const page = createCanvasV0Page();
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => VIDEO_BYTES,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await runCanvasV0Download(page, normalizeCanvasV0DownloadArgs({
      canvas: PROJECT_ID,
      record_id: RECORD_ID,
      definition: '360p',
      output: outputDir,
    }));

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/360.mp4');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'downloaded',
      recordId: RECORD_ID,
      assetId: ASSET_ID,
      definition: '360p',
      definitionFallback: false,
      checksum: 'verified',
      bytes: VIDEO_BYTES.length,
      expectedBytes: VIDEO_BYTES.length,
    });
    const written = fs.readFileSync(rows[0].path);
    expect(written.equals(VIDEO_BYTES)).toBe(true);
    expect(path.basename(rows[0].path)).toBe(`canvas-v0-${PROJECT_ID}-${RECORD_ID}-360p.mp4`);
  });

  it('falls back to the best available definition and says so', async () => {
    const page = createCanvasV0Page();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => VIDEO_BYTES,
    })));
    const rows = await runCanvasV0Download(page, normalizeCanvasV0DownloadArgs({
      canvas: PROJECT_ID,
      record_id: RECORD_ID,
      definition: 'origin',
      output: makeTempDir(),
    }));
    expect(rows[0]).toMatchObject({ definition: '720p', definitionFallback: true, requestedDefinition: 'origin' });
  });

  it('refuses a corrupted download and keeps nothing on disk', async () => {
    const page = createCanvasV0Page();
    const outputDir = makeTempDir();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('corrupted'),
    })));

    await expect(runCanvasV0Download(page, normalizeCanvasV0DownloadArgs({
      canvas: PROJECT_ID,
      record_id: RECORD_ID,
      definition: '360p',
      output: outputDir,
    }))).rejects.toThrow(/md5 mismatch/);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('reports the available states when nothing can be downloaded', async () => {
    const page = createCanvasV0Page({
      record: historyRecord({
        status: 20,
        item_list: [{ common_attr: { id: 'item-1', status: 200, prompt: PROMPT, cover_url: '' } }],
      }),
    });
    await expect(runCanvasV0Download(page, normalizeCanvasV0DownloadArgs({
      canvas: PROJECT_ID,
      output: makeTempDir(),
    }))).rejects.toThrow(/no downloadable video yet .*states=39441026984460:pending/);
  });
});

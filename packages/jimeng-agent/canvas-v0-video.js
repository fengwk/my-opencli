/**
 * Prepare or submit a Jimeng Agent video prompt inside the legacy canvas
 * (初代画布, /ai-tool/canvas).
 *
 * Supports:
 *   --canvas new          Create a fresh legacy canvas project
 *   --canvas <projectId>  Open an existing legacy canvas project by ID or URL
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import {
  JIMENG_DOMAIN,
} from './src/canvas-contract.js';
import { normalizeCanvasV0AskArgs } from './src/canvas-v0-contract.js';
import { cliColumns, fromCliArgs, toCliRow } from './src/cli-public.js';
import { prepareJimengCanvasV0Ask } from './src/canvas-v0-dom.js';
import { prepareBrowserReferenceAssets } from './src/media.js';

export const canvasV0VideoCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-v0-video',
  access: 'write',
  description: 'Prepare a Jimeng legacy canvas (初代画布) Agent video draft, require a green checkpoint, optionally submit with --submit 1',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  // Jimeng keeps a canvas in a permanent preparing state in background tabs.
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'canvas',
      valueRequired: true,
      required: true,
      help: "Legacy canvas identity: 'new' to create one, or <projectId> / full /ai-tool/canvas URL for an existing one",
    },
    {
      name: 'title',
      valueRequired: true,
      help: 'Optional title for --canvas new (maximum 20 characters; rejected for existing canvases)',
    },
    {
      name: 'image',
      valueRequired: true,
      repeatable: true,
      help: 'Reference image path (repeatable; comma-separated values also accepted). The legacy 对话 panel keeps at most 2 references in total across --image/--video/--audio',
    },
    {
      name: 'video',
      valueRequired: true,
      repeatable: true,
      help: 'Reference video path (repeatable). Counts against the legacy panel limit of 2 references in total',
    },
    {
      name: 'audio',
      valueRequired: true,
      repeatable: true,
      help: 'Reference audio path (repeatable). Counts against the legacy panel limit of 2 references in total',
    },
    {
      name: 'prompt',
      valueRequired: true,
      help: 'Prompt text. The legacy canvas attaches references as files, so plain text is enough.',
    },
    {
      name: 'duration',
      type: 'int',
      default: 5,
      help: 'Requested video duration in seconds (4-15; default 5); carried by the Agent prompt',
    },
    {
      name: 'ratio',
      valueRequired: true,
      required: true,
      choices: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
      help: 'Requested output ratio (also applied to the legacy canvas 生成偏好 panel)',
    },
    {
      name: 'model-version',
      valueRequired: true,
      required: true,
      choices: [
        'seedance2.0',
        'seedance2.0fast',
        'seedance2.0_vip',
        'seedance2.0fast_vip',
        'seedance2.0mini',
      ],
      help: 'Seedance model directive included in the Agent prompt',
    },
    {
      name: 'retry',
      type: 'int',
      default: 0,
      help: 'Preparation retry count (default 0)',
    },
    {
      name: 'submit',
      type: 'int',
      default: 0,
      choices: [0, 1],
      help: '0 = prepare only after green checkpoint (default); 1 = formally submit generation after the checkpoint passes',
    },
  ],
  columns: cliColumns([
    'status',
    'canvas',
    'canvasMode',
    'projectId',
    'canvasTitle',
    'canvasUrl',
    'uploaded',
    'references',
    'assetId',
    'retryUsed',
    'submitted',
    'checkpointOk',
    'panelOpen',
    'confirmation',
    'sessionId',
    'submitRequestCount',
  ]),
  validateArgs: (kwargs) => {
    normalizeCanvasV0AskArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasV0AskArgs(fromCliArgs(kwargs));
    const preflight = prepareBrowserReferenceAssets(canonical);
    try {
      const prepared = await prepareJimengCanvasV0Ask(page, canonical, preflight.assets);
      return [toCliRow({
        ...prepared,
        uploaded: JSON.stringify(prepared.uploaded),
      })];
    } finally {
      preflight.cleanup();
    }
  },
});

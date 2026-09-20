/**
 * Prepare or submit a Jimeng Agent video prompt inside an AI Canvas.
 *
 * Supports:
 *   --canvas new          Create a fresh canvas project
 *   --canvas <projectId>  Open an existing canvas project by ID or URL
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import {
  JIMENG_DOMAIN,
  normalizeCanvasAskArgs,
} from './src/canvas-contract.js';
import { prepareJimengCanvasAsk } from './src/canvas-dom.js';
import { prepareBrowserReferenceAssets } from './src/media.js';

export const canvasVideoCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-video',
  access: 'write',
  description: 'Prepare Jimeng Canvas Agent video draft, require a green checkpoint, optionally submit with --submit 1',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  // Jimeng keeps Canvas in a permanent preparing state in background tabs.
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'canvas',
      valueRequired: true,
      required: true,
      help: "Canvas identity: 'new' to create a canvas, or <projectId> / full canvas URL for an existing one",
    },
    {
      name: 'title',
      valueRequired: true,
      help: 'Optional title for --canvas new (maximum 60 characters; rejected for existing canvases)',
    },
    {
      name: 'image',
      valueRequired: true,
      repeatable: true,
      help: 'Image reference path (repeatable; comma-separated values also accepted)',
    },
    {
      name: 'video',
      valueRequired: true,
      repeatable: true,
      help: 'Video reference path (repeatable; maximum 3)',
    },
    {
      name: 'audio',
      valueRequired: true,
      repeatable: true,
      help: 'Audio reference path (repeatable; maximum 3)',
    },
    {
      name: 'prompt',
      valueRequired: true,
      help: 'Prompt text. Use @图片1 / @视频1 / @音频1 for rich references.',
    },
    {
      name: 'duration',
      type: 'int',
      default: 5,
      help: 'Requested video duration in seconds (4-15; default 5)',
    },
    {
      name: 'ratio',
      valueRequired: true,
      required: true,
      choices: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
      help: 'Requested output ratio',
    },
    {
      name: 'model_version',
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
      help: '0 = prepare only after green checkpoint (default); 1 = formally submit generation after checkpoint passes',
    },
  ],
  columns: [
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
    'confirmation',
    'sessionId',
    'submitRequestCount',
  ],
  validateArgs: (kwargs) => {
    normalizeCanvasAskArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasAskArgs(kwargs);
    const preflight = prepareBrowserReferenceAssets(canonical);
    try {
      const prepared = await prepareJimengCanvasAsk(page, canonical, preflight.assets);
      return [{
        ...prepared,
        uploaded: JSON.stringify(prepared.uploaded),
      }];
    } finally {
      preflight.cleanup();
    }
  },
});

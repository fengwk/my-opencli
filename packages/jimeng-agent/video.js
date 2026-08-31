/**
 * Prepare a Jimeng Agent video request through visible UI, run a mandatory
 * preparation checkpoint, and optionally submit generation when --submit 1.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import { prepareJimengAgentAsk, JIMENG_DOMAIN } from './src/agent-dom.js';
import { normalizeAskArgs } from './src/contract.js';
import { prepareBrowserReferenceAssets } from './src/media.js';

export const videoCommand = cli({
  site: 'jimeng-agent',
  name: 'video',
  access: 'write',
  description: 'Prepare Jimeng Agent video draft, require a green checkpoint, optionally submit with --submit 1',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    {
      name: 'workspace',
      valueRequired: true,
      required: true,
      help: 'Jimeng workspace id used in the visible generate URL',
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
      help: 'Preparation retry count (default 0; prefers in-page recovery before a fresh workspace)',
    },
    {
      name: 'submit',
      type: 'int',
      default: 0,
      help: '0 = prepare only after green checkpoint (default); 1 = formally submit generation after checkpoint passes',
    },
  ],
  columns: [
    'status',
    'workspace',
    'workspaceUrl',
    'uploaded',
    'mentions',
    'assetId',
    'retryUsed',
    'submitted',
    'checkpointOk',
    'confirmation',
    'threadId',
    'conversationId',
    'submitRequestCount',
  ],
  validateArgs: (kwargs) => {
    normalizeAskArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const canonical = normalizeAskArgs(kwargs);
    const preflight = prepareBrowserReferenceAssets(canonical);
    try {
      const prepared = await prepareJimengAgentAsk(page, canonical, preflight.assets);
      return [{
        ...prepared,
        uploaded: JSON.stringify(prepared.uploaded),
      }];
    } finally {
      preflight.cleanup();
    }
  },
});

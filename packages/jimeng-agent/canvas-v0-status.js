/**
 * Read the generations of a legacy canvas (/ai-tool/canvas).
 *
 * Legacy canvases have no Octo project, so status comes from the canvas draft's
 * `aiGeneratorReference` (node → history record) joined with
 * `/mweb/v1/get_history_by_ids` (record status, item prompt, video definitions).
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import { JIMENG_DOMAIN } from './src/canvas-contract.js';
import { runCanvasV0Status } from './src/canvas-v0-api.js';
import { normalizeCanvasV0StatusArgs } from './src/canvas-v0-contract.js';
import { cliColumns, fromCliArgs, toCliRows } from './src/cli-public.js';

export const canvasV0StatusCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-v0-status',
  access: 'read',
  description: 'List legacy canvas generations with state, video definitions and asset ids, optionally filtered to one asset or record',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'ephemeral',
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'canvas',
      valueRequired: true,
      required: true,
      help: 'Legacy canvas project id or full /ai-tool/canvas/<projectId> URL',
    },
    {
      name: 'asset-id',
      valueRequired: true,
      help: 'Optional 16-character asset-id printed by canvas-v0-video for exact generation correlation',
    },
    {
      name: 'record-id',
      valueRequired: true,
      help: 'Optional legacy history record id (as printed by canvas-v0-status)',
    },
    {
      name: 'limit',
      type: 'int',
      default: 20,
      help: 'Maximum generation rows to return (default 20)',
    },
  ],
  columns: cliColumns([
    'status',
    'stateReason',
    'canvas',
    'projectId',
    'projectTitle',
    'canvasUrl',
    'recordId',
    'assetId',
    'nodeId',
    'nodeType',
    'itemId',
    'statusCode',
    'statusName',
    'itemStatusCode',
    'generateType',
    'finishTime',
    'finishTimeIso',
    'duration',
    'videoId',
    'definitions',
    'definitionSizes',
    'downloadUrl',
    'coverUrl',
    'prompt',
    'records',
    'generations',
    'matched',
    'note',
  ]),
  validateArgs: (kwargs) => {
    normalizeCanvasV0StatusArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasV0StatusArgs(fromCliArgs(kwargs));
    return toCliRows(await runCanvasV0Status(page, canonical));
  },
});

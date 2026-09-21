/**
 * Download one generated video from a legacy canvas (/ai-tool/canvas).
 *
 * The video URL comes from the signed CDN definitions in
 * `/mweb/v1/get_history_by_ids`; the md5 the same response publishes is verified
 * before the file is kept.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import { JIMENG_DOMAIN } from './src/canvas-contract.js';
import { runCanvasV0Download } from './src/canvas-v0-api.js';
import {
  V0_DEFAULT_VIDEO_DEFINITION,
  V0_VIDEO_DEFINITIONS,
  normalizeCanvasV0DownloadArgs,
} from './src/canvas-v0-contract.js';
import { cliColumns, fromCliArgs, toCliRows } from './src/cli-public.js';

export const canvasV0DownloadCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-v0-download',
  access: 'write',
  description: 'Download a legacy canvas generated video (md5 verified) by record id, asset id, or the newest ready generation',
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
      name: 'record-id',
      valueRequired: true,
      help: 'History record id to download (mutually exclusive with --asset-id)',
    },
    {
      name: 'asset-id',
      valueRequired: true,
      help: 'Asset id printed by canvas-v0-video (mutually exclusive with --record-id)',
    },
    {
      name: 'definition',
      valueRequired: true,
      default: V0_DEFAULT_VIDEO_DEFINITION,
      choices: [...V0_VIDEO_DEFINITIONS],
      help: `Video definition to fetch (default ${V0_DEFAULT_VIDEO_DEFINITION}; falls back to the best available and reports it)`,
    },
    {
      name: 'output',
      valueRequired: true,
      help: 'Download directory (default: ~/Downloads/jimeng-agent)',
    },
  ],
  columns: cliColumns([
    'status',
    'canvas',
    'projectId',
    'projectTitle',
    'canvasUrl',
    'recordId',
    'assetId',
    'itemId',
    'requestedDefinition',
    'definition',
    'definitionFallback',
    'width',
    'height',
    'duration',
    'path',
    'bytes',
    'expectedBytes',
    'checksum',
    'source',
    'generations',
    'matched',
  ]),
  validateArgs: (kwargs) => {
    normalizeCanvasV0DownloadArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasV0DownloadArgs(fromCliArgs(kwargs));
    return toCliRows(await runCanvasV0Download(page, canonical));
  },
});

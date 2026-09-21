/**
 * Create a blank Jimeng legacy canvas (初代画布, /ai-tool/canvas) project.
 *
 * The project is materialized through `/mweb/v1/infinite_canvas/create_project`
 * inside the authenticated page, so no upload, prompt or submit happens here and
 * the returned `project-id` can be reused by `canvas-v0-video` runs.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import {
  JIMENG_DOMAIN,
} from './src/canvas-contract.js';
import { normalizeCanvasV0CreateArgs } from './src/canvas-v0-contract.js';
import { cliColumns, fromCliArgs, toCliRows } from './src/cli-public.js';
import { runJimengCanvasV0Create } from './src/canvas-v0-dom.js';

export const canvasV0CreateCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-v0-create',
  access: 'write',
  description: 'Create a blank legacy Jimeng canvas (初代画布) and return its project id for later canvas-v0-video runs',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'title',
      valueRequired: true,
      help: 'Optional legacy canvas title (maximum 20 characters)',
    },
  ],
  columns: cliColumns([
    'status',
    'projectId',
    'draftId',
    'canvasTitle',
    'canvasUrl',
  ]),
  validateArgs: (kwargs) => {
    normalizeCanvasV0CreateArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasV0CreateArgs(fromCliArgs(kwargs));
    return toCliRows(await runJimengCanvasV0Create(page, canonical));
  },
});

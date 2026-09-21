/**
 * Create a blank Jimeng AI Canvas project.
 *
 * The command only materializes the canvas and returns its project id, so
 * later `canvas-video --canvas <project-id>` runs can prepare and submit in
 * that canvas. No upload, prompt or submit happens here.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import {
  JIMENG_DOMAIN,
  normalizeCanvasCreateArgs,
} from './src/canvas-contract.js';
import { cliColumns, fromCliArgs, toCliRows } from './src/cli-public.js';
import { runJimengCanvasCreate } from './src/canvas-dom.js';

export const canvasCreateCommand = cli({
  site: 'jimeng-agent',
  name: 'canvas-create',
  access: 'write',
  description: 'Create a blank AI Canvas and return its project id for later canvas-video runs',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  // Jimeng keeps a canvas in a permanent preparing state in background tabs.
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'title',
      valueRequired: true,
      help: 'Optional canvas title (maximum 60 characters)',
    },
  ],
  columns: cliColumns([
    'status',
    'projectId',
    'canvasTitle',
    'canvasUrl',
  ]),
  validateArgs: (kwargs) => {
    normalizeCanvasCreateArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeCanvasCreateArgs(fromCliArgs(kwargs));
    return toCliRows(await runJimengCanvasCreate(page, canonical));
  },
});

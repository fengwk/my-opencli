/**
 * Search Jimeng generate history by prompt/hash and optionally download video.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

import { cliColumns, fromCliArgs, toCliRows } from './src/cli-public.js';
import { JIMENG_DOMAIN, runJimengStatus } from './src/status-dom.js';
import { normalizeStatusArgs } from './src/status-contract.js';

export const statusCommand = cli({
  site: 'jimeng-agent',
  name: 'status',
  access: 'write',
  description: 'Search Jimeng workspace history by search key/hash and optionally download the newest ready video',
  domain: JIMENG_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  // Status navigates independently and must not replace the persistent video draft tab.
  siteSession: 'ephemeral',
  // Jimeng leaves the history feed in a permanent skeleton in background tabs.
  defaultWindowMode: 'foreground',
  navigateBefore: false,
  args: [
    {
      name: 'workspace',
      valueRequired: true,
      required: true,
      help: 'Jimeng workspace id used in the visible generate URL',
    },
    {
      name: 'search-key',
      valueRequired: true,
      required: true,
      help: 'Search key / asset id / prompt snippet used to filter history cards',
    },
    {
      name: 'download',
      type: 'int',
      default: 0,
      help: '0 = return status only (default); 1 = download the newest ready video match',
    },
    {
      name: 'type',
      valueRequired: true,
      choices: ['auto', 'video', 'image'],
      default: 'auto',
      help: 'History type filter preference (default auto, prefers video)',
    },
    {
      name: 'limit',
      type: 'int',
      default: 1,
      help: 'Max matching rows to return (default 1)',
    },
    {
      name: 'max-pages',
      type: 'int',
      default: 5,
      help: 'Max virtual-list scroll pages while searching (default 5)',
    },
    {
      name: 'output',
      valueRequired: true,
      help: 'Download directory when --download 1 (default: ~/Downloads/jimeng-agent)',
    },
  ],
  columns: cliColumns([
    'status',
    'workspace',
    'searchKey',
    'dataId',
    'taskType',
    'cancelled',
    'downloaded',
    'path',
    'collected',
    'collectedFrom',
    'downloadBytes',
    'downloadNote',
    'matchCount',
    'text',
  ]),
  validateArgs: (kwargs) => {
    normalizeStatusArgs(fromCliArgs(kwargs));
  },
  func: async (page, kwargs) => {
    const canonical = normalizeStatusArgs(fromCliArgs(kwargs));
    return toCliRows(await runJimengStatus(page, canonical));
  },
});

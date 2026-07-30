/**
 * Search Jimeng generate history by prompt/hash and optionally download video.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';

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
      name: 'search_key',
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
      name: 'max_pages',
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
  columns: [
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
  ],
  validateArgs: (kwargs) => {
    normalizeStatusArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const canonical = normalizeStatusArgs(kwargs);
    return runJimengStatus(page, canonical);
  },
});

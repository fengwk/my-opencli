/**
 * utils scrape — render a URL in the host Chrome and export clean content.
 *
 * Uses the OpenCLI adapter automation window (default --window background)
 * so the user's current tab is never stolen. Pass --window foreground to
 * watch the owned automation window.
 *
 * Content pipeline is ported from my-mcp: HtmlCleaner scoring + Turndown
 * (flexmark stand-in) + MarkdownPostProcessor + iframe ContentSourceSelector.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { scrapeWithPage } from './src/browser-scrape.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  normalizeScrapeArgs,
} from './src/contract.js';
import { SCRAPE_FORMATS } from './src/pipeline.js';

export const scrapeCommand = cli({
  site: 'utils',
  name: 'scrape',
  access: 'read',
  description:
    'Fetch a URL in the host Chrome (background by default) and export clean markdown/links/screenshot',
  example: 'opencli utils scrape https://example.com --only-main-content true --window background',
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'ephemeral',
  navigateBefore: false,
  defaultWindowMode: 'background',
  defaultFormat: 'json',
  args: [
    {
      name: 'url',
      positional: true,
      required: true,
      help: 'Fully-qualified http/https URL to fetch',
    },
    {
      name: 'as',
      default: 'markdown',
      choices: [...SCRAPE_FORMATS],
      help: `Content kind: ${SCRAPE_FORMATS.join(', ')} (default markdown). Not the CLI -f/--format envelope.`,
    },
    {
      name: 'only-main-content',
      default: false,
      help: 'Keep only the primary page content for markdown/links (default false)',
    },
    {
      name: 'timeout',
      type: 'int',
      default: DEFAULT_TIMEOUT_SECONDS,
      help: `Total seconds once the command starts (1-${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS})`,
    },
    {
      name: 'wait-for',
      type: 'int',
      default: 0,
      help: 'Extra milliseconds to wait if smart stability wait does not settle (default 0: remaining-timeout network idle)',
    },
  ],
  columns: ['title', 'url', 'as', 'truncated', 'chars', 'text', 'files'],
  validateArgs: (kwargs) => {
    normalizeScrapeArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const args = normalizeScrapeArgs(kwargs);
    return scrapeWithPage(page, args);
  },
});

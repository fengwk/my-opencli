/**
 * douyin-ext download — Download Douyin videos without third-party extensions.
 *
 * Strategy note:
 *   PAGE_FETCH, internal-unstable.
 *   Non-public API fetched in read-only page context; downloaded via streaming Node HTTP
 *   to CLI execution host. Does not mutate the DOM, does not click UI elements, and
 *   does not depend on Chrome downloads or third-party extensions.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  DEFAULT_TIMEOUT_SECONDS,
  DOWNLOAD_COLUMNS,
  normalizeDownloadArgs,
  SUPPORTED_QUALITIES,
} from './src/contract.js';
import { fetchAwemeDetailFromPage } from './src/page-fetch.js';
import { resolveTargetToId } from './src/resolve-target.js';
import { downloadVideoToFile } from './src/stream-download.js';
import { selectVideoVariant } from './src/video-selector.js';

export const downloadCommand = cli({
  site: 'douyin-ext',
  name: 'download',
  access: 'read',
  description:
    'Download Douyin video via read-only in-page metadata fetch and Node streaming download (no extension required)',
  domain: 'www.douyin.com',
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'ephemeral',
  navigateBefore: false,
  defaultWindowMode: 'background',
  defaultFormat: 'json',
  example:
    'opencli douyin-ext download "https://v.douyin.com/xxxx/" --output ./videos --quality best --timeout 60',
  args: [
    {
      name: 'target',
      positional: true,
      required: true,
      help: 'Douyin video ID, official video URL, or v.douyin.com short share link',
    },
    {
      name: 'output',
      valueRequired: true,
      default: '.',
      help: 'Target directory on CLI execution host for downloaded video (default current directory)',
    },
    {
      name: 'quality',
      valueRequired: true,
      default: 'best',
      choices: [...SUPPORTED_QUALITIES],
      help: `Desired video quality: ${SUPPORTED_QUALITIES.join(', ')} (default best)`,
    },
    {
      name: 'timeout',
      type: 'int',
      default: DEFAULT_TIMEOUT_SECONDS,
      help: `Overall timeout in seconds for API fetch and stream download (default ${DEFAULT_TIMEOUT_SECONDS})`,
    },
  ],
  columns: DOWNLOAD_COLUMNS,
  validateArgs: (kwargs) => {
    normalizeDownloadArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const args = normalizeDownloadArgs(kwargs);

    // Resolve target to video ID before navigation; invalid inputs throw ArgumentError here
    const { id } = await resolveTargetToId(args.target);

    // Obtain dynamic browser userAgent to avoid hardcoding outdated UA strings
    let userAgent;
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    }

    // Step 1: Read-only in-page fetch for video detail
    const detail = await fetchAwemeDetailFromPage(page, id, {
      timeoutMs: args.timeoutMs,
    });

    // Step 2: Extract variants and select requested quality
    const variant = selectVideoVariant(detail.video, args.quality);

    // Step 3: Stream download video to local file
    const title = detail.desc || detail.title || id;
    const author = detail.author?.nickname || '';

    const downloadResult = await downloadVideoToFile({
      id,
      title,
      author,
      variant,
      outputDir: args.output,
      userAgent,
      timeoutMs: args.timeoutMs,
    });

    return [downloadResult];
  },
});

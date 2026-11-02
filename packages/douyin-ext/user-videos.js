/**
 * douyin-ext user-videos — Single-page cursor pagination primitive for Douyin user videos.
 *
 * Strategy note:
 *   PAGE_FETCH, internal-unstable.
 *   Non-public API fetched in read-only page context (/aweme/v1/web/aweme/post/).
 *   Inherits logged-in browser JS runtime signatures (a_bogus, msToken) and cookies.
 *   Strictly read-only: does not mutate DOM, does not click UI elements, and avoids
 *   unstable DOM scroll-pagination.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  DEFAULT_COMMENT_LIMIT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_USER_VIDEOS_COUNT,
  MAX_COMMENT_LIMIT,
  MAX_USER_VIDEOS_COUNT,
  MIN_COMMENT_LIMIT,
  MIN_TIMEOUT_SECONDS,
  MIN_USER_VIDEOS_COUNT,
  normalizeUserVideosArgs,
  USER_VIDEOS_COLUMNS,
  validateCursor,
  validateUserVideosTarget,
} from './src/user-videos-contract.js';
import {
  extractVideoItem,
  fetchAwemeCommentsFromPage,
  fetchUserVideosPage,
  isAuthLikeMessage,
  unwrapEvaluateResult,
} from './src/user-videos-fetch.js';

export {
  validateUserVideosTarget,
  validateCursor,
  normalizeUserVideosArgs,
  fetchUserVideosPage,
  fetchAwemeCommentsFromPage,
  extractVideoItem,
  unwrapEvaluateResult,
  isAuthLikeMessage,
  USER_VIDEOS_COLUMNS,
};

export const userVideosCommand = cli({
  site: 'douyin-ext',
  name: 'user-videos',
  access: 'read',
  description:
    'Fetch Douyin user videos with cursor pagination via in-page PAGE_FETCH (no extension required)',
  domain: 'www.douyin.com',
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'ephemeral',
  navigateBefore: false,
  defaultWindowMode: 'background',
  defaultFormat: 'json',
  example:
    'opencli douyin-ext user-videos "https://www.douyin.com/user/MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU" --cursor 0 --count 20 --comment-limit 0 --timeout 60',
  args: [
    {
      name: 'target',
      positional: true,
      required: true,
      help: 'Douyin user sec_uid or official user URL (https://www.douyin.com/user/<sec_uid>)',
    },
    {
      name: 'cursor',
      valueRequired: true,
      default: '0',
      help: 'Pagination cursor string (default 0)',
    },
    {
      name: 'count',
      type: 'int',
      valueRequired: true,
      default: DEFAULT_USER_VIDEOS_COUNT,
      help: `Number of videos to fetch per page (${MIN_USER_VIDEOS_COUNT}-${MAX_USER_VIDEOS_COUNT}, default ${DEFAULT_USER_VIDEOS_COUNT})`,
    },
    {
      name: 'comment-limit',
      type: 'int',
      valueRequired: true,
      default: DEFAULT_COMMENT_LIMIT,
      help: `Maximum number of top comments per video (${MIN_COMMENT_LIMIT}-${MAX_COMMENT_LIMIT}, default ${DEFAULT_COMMENT_LIMIT}, 0 disables fetching)`,
    },
    {
      name: 'timeout',
      type: 'int',
      valueRequired: true,
      default: DEFAULT_TIMEOUT_SECONDS,
      help: `Overall timeout in seconds across page navigation, wait, post fetch, and comment fetch (default ${DEFAULT_TIMEOUT_SECONDS})`,
    },
  ],
  columns: USER_VIDEOS_COLUMNS,
  validateArgs: (kwargs) => {
    normalizeUserVideosArgs(kwargs);
  },
  func: async (page, kwargs) => {
    const args = normalizeUserVideosArgs(kwargs);
    const result = await fetchUserVideosPage(page, {
      secUid: args.secUid,
      cursor: args.cursor,
      count: args.count,
      commentLimit: args.commentLimit,
      timeoutMs: args.timeoutMs,
    });
    return [result];
  },
});

export default userVideosCommand;

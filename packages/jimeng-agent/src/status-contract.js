/**
 * Pure contract for jimeng-agent status/search/download.
 */

import path from 'node:path';
import os from 'node:os';

import { ArgumentError } from '@jackwener/opencli/errors';

export const STATUS_TASK_TYPES = Object.freeze(['video', 'image', 'auto']);

/**
 * Normalize CLI kwargs for `jimeng-agent status`.
 */
export function normalizeStatusArgs(kwargs = {}) {
  if (kwargs === null || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    throw new ArgumentError(
      `Invalid arguments: expected a plain object, got ${describeType(kwargs)}`,
      'Pass the command arguments as a plain JSON-style object.',
    );
  }

  const workspace = requireNonBlankString(kwargs.workspace, 'workspace');
  const searchKey = requireNonBlankString(kwargs.search_key ?? kwargs.query, 'search_key');
  const download = normalizeBoolFlag(kwargs.download, false);
  const limit = normalizePositiveInt(kwargs.limit, 1, 'limit');
  const maxPages = normalizePositiveInt(kwargs.max_pages, 5, 'max_pages');
  const type = normalizeTaskType(kwargs.type);
  const outputDir = normalizeOutputDir(kwargs.output);

  return {
    workspace,
    searchKey,
    download,
    limit,
    maxPages,
    type,
    outputDir,
  };
}

export function classifyTaskStatus(rawText) {
  const text = String(rawText || '');
  if (/取消生成|积分已返还|任务已取消/.test(text)) return 'cancelled';
  if (/失败|生成失败|出错/.test(text)) return 'failed';
  // Prefer terminal success markers over intermediate "已提交生成" phrasing.
  if (/视频生成完成|重新生成|已完成|completed-/.test(text)) return 'ready';
  if (/认真思考中|排队加速中|生成中|处理中|加载中|已提交生成/.test(text)) return 'generating';
  if (text.trim().length > 0) return 'ready';
  return 'unknown';
}

export function textMatchesSearchKey(rawText, searchKey) {
  const haystack = normalizeMatchText(rawText);
  const needle = normalizeMatchText(searchKey);
  if (!needle) return false;
  return haystack.includes(needle);
}

export function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[，,。.!！?？;；:：]/g, '')
    .replace(/\s+/g, '');
}

function normalizeTaskType(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'auto';
  const value = String(raw).trim().toLowerCase();
  if (!STATUS_TASK_TYPES.includes(value)) {
    throw new ArgumentError(
      `Invalid type: '${raw}' (must be one of ${STATUS_TASK_TYPES.join(', ')})`,
      'Pass --type video|image|auto.',
    );
  }
  return value;
}

function normalizeOutputDir(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return path.join(os.homedir(), 'Downloads', 'jimeng-agent');
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid output: expected string, got ${describeType(raw)}`,
      'Pass --output as a directory path.',
    );
  }
  return path.resolve(raw.trim());
}

function normalizeBoolFlag(raw, defaultValue) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return defaultValue;
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 0) return false;
    if (raw === 1) return true;
  }
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  }
  throw new ArgumentError(
    `Invalid download flag: '${raw}' (must be 0/1 or true/false)`,
    'Pass --download 0 to search only, or --download 1 to download the newest match.',
  );
}

function normalizePositiveInt(raw, defaultValue, name) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return defaultValue;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ArgumentError(
      `Invalid ${name}: '${raw}' (must be a positive integer)`,
      `Pass --${name} as a positive integer.`,
    );
  }
  return n;
}

function requireNonBlankString(raw, name) {
  if (raw === undefined || raw === null) {
    throw new ArgumentError(
      `Missing required argument: '${name}'`,
      `Pass a non-empty --${name} value.`,
    );
  }
  if (typeof raw !== 'string') {
    throw new ArgumentError(
      `Invalid '${name}': expected string, got ${describeType(raw)}`,
      `Pass --${name} as a plain string.`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throw new ArgumentError(
      `Invalid '${name}': value is blank`,
      `Pass a non-empty --${name} value.`,
    );
  }
  return value;
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

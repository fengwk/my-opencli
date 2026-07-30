import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  classifyTaskStatus,
  normalizeStatusArgs,
  textMatchesSearchKey,
} from '../src/status-contract.js';
import { parseSearchNetworkEntries, toNodeLocalPath } from '../src/status-dom.js';

describe('jimeng-agent/status-contract', () => {
  it('normalizes search args with download defaulting to false', () => {
    const out = normalizeStatusArgs({
      workspace: '12505736104460',
      search_key: 'b7e4f19a2c0d5e68',
    });
    expect(out.workspace).toBe('12505736104460');
    expect(out.searchKey).toBe('b7e4f19a2c0d5e68');
    expect(out.download).toBe(false);
    expect(out.limit).toBe(1);
    expect(out.type).toBe('auto');
  });

  it('accepts download 1 and rejects invalid flags', () => {
    expect(normalizeStatusArgs({
      workspace: '1',
      search_key: 'abc',
      download: 1,
    }).download).toBe(true);
    expect(() => normalizeStatusArgs({
      workspace: '1',
      search_key: 'abc',
      download: 2,
    })).toThrow(ArgumentError);
  });

  it('classifies generating / cancelled / ready statuses from card text', () => {
    expect(classifyTaskStatus('认真思考中...')).toBe('generating');
    expect(classifyTaskStatus('排队加速中')).toBe('generating');
    expect(classifyTaskStatus('取消生成 积分已返还')).toBe('cancelled');
    expect(classifyTaskStatus('重新生成 下载')).toBe('ready');
  });

  it('matches search keys with punctuation/spacing differences', () => {
    expect(textMatchesSearchKey(
      '甚至来不及问，身体已经先一步照做，往左挪了半步；叶归年',
      '甚至来不及问,身体已经先一步照做,往左挪了半步;叶归年',
    )).toBe(true);
    expect(textMatchesSearchKey('资产编号：b7e4f19a2c0d5e68', 'b7e4f19a2c0d5e68')).toBe(true);
  });

  it('parses captured search API entries into status rows', () => {
    const rows = parseSearchNetworkEntries([{
      url: 'https://jimeng.jianying.com/mweb/search/v1/search?aid=1',
      responseBody: JSON.stringify({
        ret: '0',
        data: {
          item_list: [{
            item_id: 'abc123',
            prompt: '甚至来不及问,身体已经先一步照做,往左挪了半步;叶归年',
            status: 'finish',
            video_url: 'https://v3-artist.vlabvod.com/demo/video.mp4?mime_type=video_mp4',
          }],
        },
      }),
    }], '甚至来不及问');
    expect(rows).toHaveLength(1);
    expect(rows[0].dataId).toBe('abc123');
    expect(rows[0].taskType).toBe('video');
    expect(rows[0].mediaUrl).toContain('vlabvod');
  });

  it('maps Windows Chrome download paths to WSL node paths', () => {
    expect(toNodeLocalPath(
      'C:\\Users\\fengwk\\Downloads\\jimeng-demo.mp4',
      { path: { sep: '/', join: (...parts) => parts.join('/').replace(/\/+/g, '/'), normalize: (p) => p } },
    )).toBe('/mnt/c/Users/fengwk/Downloads/jimeng-demo.mp4');
    expect(toNodeLocalPath('/tmp/already-posix.mp4')).toBe('/tmp/already-posix.mp4');
    expect(toNodeLocalPath('')).toBe('');
  });
});
